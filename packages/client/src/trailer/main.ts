// Trailer renderer (dev only): scripts/trailer.mjs drives it frame by frame and encodes the video.
// Each frame: advance the shot's replayed match, draw it with the game's own renderer and particles,
// frame it with the camera, then the motion graphics on top. Game sounds are logged with their time
// and mixed with the soundtrack offline at the end.
//
// The camera is planned, not chased: when a shot starts, its ticks are simulated ahead (dryRun), the
// camera path is laid on the ball and pulled onto the shot's key event before it happens, then smoothed
// with a centred Gaussian, so it moves early, slowly and never jitters. Screen shake only comes from
// the key event itself (an explosion), never from anything else.
import { FIELD } from '@crateball/sim';
import type { GameEvent } from '../events';
import { createParticles, type Particles } from '../particles';
import { createRenderer } from '../render';
import { createSound } from '../sound';
import { OUT_H, OUT_W } from './fx';
import { KEYS, dryRun, replay, scan, where, type Key, type MatchSpec, type Moment } from './match';
import { BEAT, impact, renderMusic, toWav } from './music';
import { DURATION, SEGMENTS, enterFx, punch, vignette, type Segment } from './story';

declare global {
  interface Window {
    trailer: Record<string, unknown>;
  }
}

const FPS = 60;
const out = document.querySelector<HTMLCanvasElement>('#out')!;
const o = out.getContext('2d')!;
// The game is rendered wider than the output (2400 px of room at 1080 high): the pitch is
// height-bound, so the extra width is space past the goal lines and the camera can centre a goal.
const GW = 2400;
const gameCanvas = document.createElement('canvas');
const renderer = createRenderer(gameCanvas);
renderer.resize(GW, OUT_H, 2);
const RES = gameCanvas.width / GW;
const gameCtx = gameCanvas.getContext('2d', { willReadFrequently: false })!; // the renderer caps its backing store, so read the real ratio
// Where the renderer puts the field on its canvas (render.ts resize(), in logical pixels).
const HUD = 56;
const FOOTER = 30;
const VIEW = { w: (FIELD.halfW + FIELD.marginX + 10) * 2, h: (FIELD.halfH + FIELD.margin + 10) * 2 };
const SCALE = Math.min(GW / VIEW.w, (OUT_H - HUD - FOOTER) / VIEW.h);
const ORIGIN = { x: GW / 2, y: (HUD + OUT_H - FOOTER) / 2 };
const PAD = { x: 240, y: 260 };
const BOOMS = new Set(['rocket', 'mine', 'erupt']);
const isBoom = (e: GameEvent) => e.type === 'item' && BOOMS.has(e.kind);

interface Plan {
  /** Camera centre (field units) per sim tick of the shot. */
  path: Array<{ x: number; y: number }>;
  /** The key event: its first frame (in the segment) and every place it happens (a teleport has two). */
  key: { frame: number; points: Array<{ x: number; y: number; frame: number }> } | null;
  /** Frames with an explosion (screen shake), the key one marked. */
  booms: Array<{ frame: number; key: boolean; x: number; y: number }>;
  /** The simulated ticks (for check()). */
  run: Moment[];
  frameOf: (i: number) => number;
}

/** What the camera must keep in view at a tick: around the key moment the key event and whoever is near
 * it, otherwise the ball and the players near it. */
function play(m: Moment, f: number, keyPts: Array<{ x: number; y: number; frame: number }>) {
  const active = keyPts.filter((k) => Math.abs(k.frame - f) < 40);
  const hub = active[0] ?? m.ball;
  const near = (pl: { x: number; y: number }) => Math.hypot(pl.x - hub.x, pl.y - hub.y) < 220;
  return { pts: [...(near(m.ball) ? [m.ball] : []), ...m.players.filter(near)], active };
}

/** Simulate the shot ahead and lay out its camera path. */
function plan(s: Segment): Plan | null {
  const sh = s.shot;
  if (!sh) return null;
  const speed = sh.speed ?? 1;
  const frames = Math.round((s.t1 - s.t0) * FPS);
  const ticks = Math.ceil(frames * speed) + 2;
  const run = dryRun(sh.spec, sh.from, ticks);
  const frameOf = (i: number) => (i + 1) / speed - 1;
  const focus = run.map((m) => ({ ...m.ball }));
  let key: Plan['key'] = null;
  if (sh.key) {
    const match = KEYS[sh.key];
    // The event the shot was cut around (keyTick: a gun fires all the time, so not just the first),
    // plus the same event's other places within half a second (a teleport's arrival).
    const first = run.findIndex((m) => m.tick >= (sh.keyTick ?? 0) && m.events.some(match));
    if (first >= 0) {
      const points = run
        .slice(first, first + 30)
        .flatMap((m, j) =>
          m.events.filter(match).flatMap((e) => {
            const p = where(e);
            return p ? [{ x: Math.max(-430, Math.min(430, p.x)), y: p.y, frame: frameOf(first + j) }] : [];
          }),
        )
        // Other players doing the same thing elsewhere (two gunners) are not part of this moment.
        .filter((p, _i, all) => Math.hypot(p.x - all[0]!.x, p.y - all[0]!.y) < 220);
      key = { frame: frameOf(first), points };
      const c = {
        x: points.reduce((n, p) => n + p.x, 0) / Math.max(1, points.length),
        y: points.reduce((n, p) => n + p.y, 0) / Math.max(1, points.length),
      };
      // Lean onto the event from 70 ticks before it, hold through the aftermath, ease off at the end.
      const before = 70;
      const hold = 90;
      for (let j = Math.max(0, first - before); j < run.length; j++) {
        const d = j - first;
        const w = d < 0 ? Math.min(1, (before + d) / 30) : Math.max(0, Math.min(1, (hold + 40 - d) / 40));
        focus[j]!.x += (c.x - focus[j]!.x) * w * 0.85;
        focus[j]!.y += (c.y - focus[j]!.y) * w * 0.85;
      }
    }
  }
  const booms: Plan['booms'] = [];
  run.forEach((m, i) => {
    const boom = m.events.find(isBoom);
    const at = boom && where(boom);
    if (!at) return;
    const frame = frameOf(i);
    const isKey = !!key && Math.abs(frame - key.frame) < 1;
    const last = booms[booms.length - 1];
    if (last && frame - last.frame < 0.3 * FPS) return;
    booms.push({ frame, key: isKey, ...at });
  });
  // Framing: per tick, nudge the camera (within ±300 × ±200 field px) so the play (ball, players near
  // it, the key event around its moment) is in frame and out from under the segment's text, moving as
  // little as possible. Then smooth.
  const keyPts = key ? (key as NonNullable<Plan['key']>).points : [];
  // Explosions (and their smoke) also stay clear of the text, for a moment either side.
  const boomPts = run.flatMap((m, i) =>
    m.events.filter(isBoom).flatMap((e) => {
      const p = where(e);
      return p ? [{ ...p, frame: frameOf(i) }] : [];
    }),
  );
  focus.forEach((c, i) => {
    const m = run[i]!;
    const f = frameOf(i);
    const zoom = zoomAt(s, f);
    const { pts: around, active } = play(m, f, keyPts);
    const booms = boomPts.filter((b) => Math.abs(b.frame - f) < 20);
    const pts = [...around, ...booms];
    let best = { x: c.x, y: c.y, cost: Infinity };
    for (let dx = -300; dx <= 300; dx += 50)
      for (let dy = -200; dy <= 200; dy += 40) {
        const v = rect(s, c.x + dx, c.y + dy, zoom);
        let cost = (dx * dx + dy * dy) / 100;
        const bad = (q: { x: number; y: number }) =>
          (underText(s, q) ? 1000 : 0) +
          (q.x < 120 || q.x > OUT_W - 120 || q.y < 100 || q.y > OUT_H - 100 ? 600 : 0);
        for (const pt of pts) cost += bad(onScreen(v, pt.x, pt.y));
        // Explosions want room around them (their smoke and captions are wide).
        for (const b of booms) {
          const q = onScreen(v, b.x, b.y);
          if (q.x < 200 || q.x > OUT_W - 200 || q.y < 170 || q.y > OUT_H - 150) cost += 500;
        }
        for (const k of active) cost += 4 * bad(onScreen(v, k.x, k.y)); // the event itself matters most
        if (cost < best.cost) best = { x: c.x + dx, y: c.y + dy, cost };
      }
    c.x = best.x;
    c.y = best.y;
  });
  // Centred Gaussian smoothing (σ = 16 ticks): no lag, no jitter.
  const sigma = 16;
  const path = focus.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let j = Math.max(0, i - 3 * sigma); j <= Math.min(focus.length - 1, i + 3 * sigma); j++) {
      const w = Math.exp(-((j - i) ** 2) / (2 * sigma * sigma));
      sx += focus[j]!.x * w;
      sy += focus[j]!.y * w;
      sw += w;
    }
    return { x: sx / sw, y: sy / sw };
  });
  return { path, key, booms, run, frameOf };
}

/** Source rectangle (game canvas, logical px) the camera shows for a shot frame. */
function zoomAt(s: Segment, frame: number) {
  const z = s.shot!.zoom;
  return z[0] + (z[1] - z[0]) * (frame / Math.round((s.t1 - s.t0) * FPS));
}

/** The view rectangle (game canvas, logical px) for a camera centre (field units) and zoom. */
function rect(s: Segment, cx: number, cy: number, zoom: number) {
  const vw = OUT_W / zoom;
  const vh = OUT_H / zoom;
  // The camera centre sits at `subject` (fractions of the frame).
  const [fx0, fy0] = s.subject ?? [0.5, 0.5];
  // The camera may look past the pitch (PAD): the space beyond is filled with the arena's outside colour.
  const sx = Math.max(-PAD.x, Math.min(GW - vw + PAD.x, ORIGIN.x + cx * SCALE - vw * fx0));
  const sy = Math.max(HUD - PAD.y, Math.min(OUT_H - FOOTER - vh + PAD.y, ORIGIN.y + cy * SCALE - vh * fy0));
  return { sx, sy, vw, vh, zoom };
}

/** Source rectangle the camera shows for a shot frame. */
function view(s: Segment, p: Plan, frame: number) {
  const tick = Math.max(0, frame * (s.shot!.speed ?? 1));
  const i = Math.min(p.path.length - 1, Math.floor(tick));
  const a = p.path[i]!;
  const b = p.path[Math.min(p.path.length - 1, i + 1)]!;
  const f = tick - i;
  return rect(s, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, zoomAt(s, frame));
}
/** Where a field point lands in the output frame. */
function onScreen(v: ReturnType<typeof view>, x: number, y: number) {
  return {
    x: ((ORIGIN.x + x * SCALE - v.sx) / v.vw) * OUT_W,
    y: ((ORIGIN.y + y * SCALE - v.sy) / v.vh) * OUT_H,
  };
}

const sounds: Array<{ t: number; e: GameEvent }> = [];
/** Key moments as they were shown (for the music's accents). */
const hits: Array<{ t: number; big: boolean }> = [];
let seg: Segment | null = null;
let run: ReturnType<typeof replay> | null = null;
let fx: Particles = createParticles();
let cur: Plan | null = null;
let frameInSeg = 0;
let outside = '#4A7A3A';
let acc = 0;

function startSegment(s: Segment) {
  seg = s;
  run = s.shot ? replay(s.shot.spec, s.shot.from) : null;
  cur = plan(s);
  const inner = createParticles();
  // The renderer's own shake is off: zoomed in it reads as noise. Ours is in drawShot.
  fx = Object.assign(Object.create(inner) as Particles, { takeShake: () => 0 });
  frameInSeg = 0;
  acc = 0;
}

function drawShot(s: Segment, t: number, lt: number) {
  if (!run || !s.shot || !cur) return;
  const r = run;
  const speed = s.shot.speed ?? 1;
  acc += speed;
  while (acc >= 1) {
    acc -= 1;
    for (const e of r.advance()) {
      fx.emit(e);
      // Only the event the shot is about makes a game sound; the rest of the match stays under the music.
      if (s.shot.key && KEYS[s.shot.key](e) && Math.abs(frameInSeg - (cur.key?.frame ?? -99)) < 2)
        sounds.push({ t, e });
    }
  }
  fx.ambient(r.game, (id) => r.pred.pos(id, acc), speed / FPS);
  fx.update(speed / FPS);
  renderer.draw(r.pred, acc, fx, { rtt: null, banners: false });
  if (cur.key && frameInSeg === Math.round(cur.key.frame) && s.shot.key)
    hits.push({ t, big: ['rocket', 'mine', 'erupt', 'goal'].includes(s.shot.key) });
  const v = view(s, cur, frameInSeg);
  // A short, decaying shake on each explosion (stronger on the one the shot is about).
  let dx = 0;
  let dy = 0;
  for (const b of cur.booms) {
    const since = (frameInSeg - b.frame) / FPS;
    if (since < 0 || since >= 0.35) continue;
    const amp = (b.key ? 9 : 5) * Math.exp(-since / 0.09);
    dx += Math.sin(since * 90) * amp;
    dy += Math.cos(since * 77) * amp;
  }
  const blur = s.blur?.(lt) ?? 0;
  if (blur > 0.2) o.filter = `blur(${blur.toFixed(1)}px)`;
  // Only the pitch part of the game canvas is used (never the HUD bar on top nor the controls hint
  // at the bottom); whatever the view shows beyond it is the arena's outside colour.
  // Sampled once per shot (later frames may have rain or embers over that corner).
  if (frameInSeg === 0) {
    const [r0, g0, b0] = gameCtx.getImageData(4, Math.round((HUD + 4) * RES), 1, 1).data;
    outside = `rgb(${r0},${g0},${b0})`;
  }
  o.fillStyle = outside;
  o.fillRect(0, 0, OUT_W, OUT_H);
  const sx = v.sx + dx / v.zoom;
  const sy = v.sy + dy / v.zoom;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(HUD, sy);
  const x1 = Math.min(GW, sx + v.vw);
  const y1 = Math.min(OUT_H - FOOTER, sy + v.vh);
  const k = OUT_W / v.vw;
  if (x1 > x0 && y1 > y0)
    o.drawImage(
      gameCanvas,
      x0 * RES,
      y0 * RES,
      (x1 - x0) * RES,
      (y1 - y0) * RES,
      (x0 - sx) * k,
      (y0 - sy) * k,
      (x1 - x0) * k,
      (y1 - y0) * k,
    );
  o.filter = 'none';
  vignette(o, 0.45);
}

function frame(i: number): void {
  const t = i / FPS;
  const idx = SEGMENTS.findIndex((s) => t >= s.t0 && t < s.t1);
  const s = SEGMENTS[idx];
  o.setTransform(1, 0, 0, 1, 0, 0);
  if (!s) {
    o.fillStyle = '#000';
    o.fillRect(0, 0, OUT_W, OUT_H);
    return;
  }
  if (s !== seg) startSegment(s);
  const lt = t - s.t0;
  const k = punch(s, lt);
  o.setTransform(k, 0, 0, k, (OUT_W * (1 - k)) / 2, (OUT_H * (1 - k)) / 2);
  if (s.shot) drawShot(s, t, lt);
  s.over?.(o, lt, t, 1 / FPS);
  o.setTransform(1, 0, 0, 1, 0, 0);
  enterFx(o, s, lt);
  frameInSeg++;
}

function underText(s: Segment, q: { x: number; y: number }, margin = 40): boolean {
  return (s.clear ?? []).some(
    ([x0, y0, x1, y1]) => q.x > x0 - margin && q.x < x1 + margin && q.y > y0 - margin && q.y < y1 + margin,
  );
}

/**
 * Checks every shot before rendering: its key event must happen while the shot is on screen (after
 * the cut has settled and before the next one), every place it happens must be inside the frame,
 * and none of them under the segment's text.
 */
function check(): string[] {
  const problems: string[] = [];
  SEGMENTS.forEach((s, n) => {
    const sh = s.shot;
    if (!sh?.key) return;
    const name = `#${n} ${sh.key} @${s.t0.toFixed(2)}s`;
    const p = plan(s);
    const frames = Math.round((s.t1 - s.t0) * FPS);
    if (!p?.key) {
      problems.push(`${name}: the key event never happens`);
      return;
    }
    // On the beat (within two frames), so the music hits with it.
    const kt = s.t0 + p.key.frame / FPS;
    const off = kt - Math.round(kt / BEAT) * BEAT;
    if (Math.abs(off) > 2 / FPS)
      problems.push(`${name}: key event ${(off * 1000).toFixed(0)} ms off the beat`);
    const at = p.key.frame / frames;
    if (at < 0.12 || at > 0.85) problems.push(`${name}: key event at ${(at * 100).toFixed(0)}% of the shot`);
    for (const pt of p.key.points) {
      if (pt.frame >= frames) continue;
      const q = onScreen(view(s, p, Math.round(pt.frame)), pt.x, pt.y);
      const where = `(${q.x.toFixed(0)}, ${q.y.toFixed(0)}) at ${(s.t0 + pt.frame / FPS).toFixed(2)}s`;
      if (q.x < 100 || q.x > OUT_W - 100 || q.y < 100 || q.y > OUT_H - 100)
        problems.push(`${name}: off screen ${where}`);
      if (underText(s, q)) problems.push(`${name}: under the text ${where}`);
    }
    // Every explosion stays out of the text, too.
    for (const b of p.booms) {
      if (b.frame >= frames) continue;
      const q = onScreen(view(s, p, Math.round(b.frame)), b.x, b.y);
      if (underText(s, q))
        problems.push(`${name}: explosion under the text at ${(s.t0 + b.frame / FPS).toFixed(2)}s`);
    }
    // And the play: the players near the ball may not spend more than a fifth of the shot behind the
    // text (the far side of the pitch can; the statements have a backing band for that).
    let covered = 0;
    let total = 0;
    p.run.forEach((m, i) => {
      const f = p.frameOf(i);
      if (f >= frames || i % 3) return;
      total++;
      const v = view(s, p, Math.round(f));
      const { pts } = play(m, f, p.key?.points ?? []);
      if (pts.some((pl) => underText(s, onScreen(v, pl.x, pl.y), 0))) covered++;
    });
    if (total && covered / total > 0.2)
      problems.push(`${name}: players behind the text ${((covered / total) * 100).toFixed(0)}% of the shot`);
  });
  return problems;
}

async function audio(): Promise<string> {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil((DURATION + 0.5) * rate), rate);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 2;
  const master = ctx.createGain();
  master.gain.value = 0.42; // headroom: loudness is set afterwards (scripts/trailer.mjs)
  comp.connect(master).connect(ctx.destination);
  renderMusic(ctx, comp);
  const sfx = ctx.createGain();
  sfx.gain.value = 0.6;
  sfx.connect(comp);
  for (const h of hits) impact(ctx, comp, h.t, h.big);
  let when = 0;
  const sound = createSound({ ctx, out: sfx, now: () => when });
  for (const s of sounds) {
    when = s.t;
    sound.play(s.e);
  }
  const buf = await ctx.startRendering();
  const bytes = new Uint8Array(toWav(buf));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const frames = Math.ceil(DURATION * FPS);
window.trailer = {
  scan: (spec: MatchSpec, ticks: number, key: Key) => scan(spec, ticks, key),
  dryRun: (spec: MatchSpec, from: number, ticks: number) => dryRun(spec, from, ticks),
  check,
  segments: () => SEGMENTS.map((s) => ({ t0: s.t0, t1: s.t1, key: s.shot?.key ?? null })),
  frames,
  fps: FPS,
  ready: () => document.fonts.ready.then(() => true),
  /** Draws frame i and returns it as a JPEG data URL. */
  frame: (i: number) => {
    frame(i);
    return out.toDataURL('image/jpeg', 0.92);
  },
  audio,
};

// Opened with ?play: runs in real time (no sound), handy while editing the story. ?at=<seconds> starts later.
const q = new URLSearchParams(location.search);
if (q.has('play')) {
  let i = Math.round(Number(q.get('at') ?? 0) * FPS);
  void document.fonts.ready.then(() => {
    const tick = () => {
      frame(i++);
      if (i < frames) requestAnimationFrame(tick);
    };
    tick();
  });
}
