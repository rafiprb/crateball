// Trailer renderer (dev only): scripts/trailer.mjs drives it frame by frame and encodes the video.
// Each frame: advance the shot's replayed match, draw it with the game's own renderer and particles,
// frame it with the camera, then the motion graphics on top. Game sounds are logged with their time
// and mixed with the soundtrack offline at the end.
import { FIELD } from '@crateball/sim';
import type { GameEvent } from '../events';
import { createParticles, type Particles } from '../particles';
import { createRenderer } from '../render';
import { createSound } from '../sound';
import { OUT_H, OUT_W } from './fx';
import { replay, scan, type MatchSpec } from './match';
import { BEAT, renderMusic, toWav } from './music';
import { DURATION, SEGMENTS, enterFx, exitFx, vignette, type Segment } from './story';

declare global {
  interface Window {
    trailer: Record<string, unknown>;
  }
}

const FPS = 60;
const out = document.querySelector<HTMLCanvasElement>('#out')!;
const o = out.getContext('2d')!;
const gameCanvas = document.createElement('canvas');
const renderer = createRenderer(gameCanvas);
const RES = 2; // render the game at 2x so zoomed shots stay sharp
renderer.resize(OUT_W, OUT_H, RES);
// Where the renderer puts the field on its canvas (render.ts resize(), in output pixels).
const HUD = 56;
const VIEW = { w: (FIELD.halfW + FIELD.marginX + 10) * 2, h: (FIELD.halfH + FIELD.margin + 10) * 2 };
const SCALE = Math.min(OUT_W / VIEW.w, (OUT_H - HUD - 30) / VIEW.h);
const ORIGIN = { x: OUT_W / 2, y: (HUD + OUT_H - 30) / 2 };

const sounds: Array<{ t: number; e: GameEvent }> = [];
let seg: Segment | null = null;
let run: ReturnType<typeof replay> | null = null;
let fx: Particles = createParticles();
let acc = 0;
const cam = { x: 0, y: 0 };

function startSegment(s: Segment) {
  seg = s;
  run = s.shot ? replay(s.shot.spec, s.shot.from) : null;
  fx = createParticles();
  acc = 0;
  const b = run?.game.ball;
  cam.x = s.shot?.follow && b ? b.x : 0;
  cam.y = s.shot?.follow && b ? b.y * 0.6 : 0;
}

function drawShot(s: Segment, t: number) {
  if (!run || !s.shot) return;
  const r = run;
  const speed = s.shot.speed ?? 1;
  acc += speed;
  while (acc >= 1) {
    acc -= 1;
    for (const e of r.advance()) {
      fx.emit(e);
      if (e.type !== 'scrape' && e.type !== 'locked') sounds.push({ t, e });
    }
  }
  fx.ambient(r.game, (id) => r.pred.pos(id, acc), speed / FPS);
  fx.update(speed / FPS);
  renderer.draw(r.pred, acc, fx, { rtt: null });

  const k = (t - s.t0) / (s.t1 - s.t0);
  const [z0, z1] = s.shot.zoom ?? [1.12, 1.12];
  let zoom = z0 + (z1 - z0) * k;
  if (s.pulse) zoom *= 1 + 0.035 * Math.exp(-(t % BEAT) / 0.07);
  if (s.shot.follow) {
    const b = r.pred.pos('ball', acc) ?? { x: 0, y: 0 };
    cam.x += (b.x - cam.x) * 0.1;
    cam.y += (b.y * 0.6 - cam.y) * 0.1;
  }
  // Field point → output pixel at zoom 1; the view stays inside the canvas and below the HUD bar.
  const vw = OUT_W / zoom;
  const vh = OUT_H / zoom;
  const sx = Math.max(0, Math.min(OUT_W - vw, ORIGIN.x + cam.x * SCALE - vw / 2));
  const sy = Math.max(HUD, Math.min(OUT_H - vh, ORIGIN.y + cam.y * SCALE - vh / 2));
  o.drawImage(gameCanvas, sx * RES, sy * RES, vw * RES, vh * RES, 0, 0, OUT_W, OUT_H);
  vignette(o, 0.5);
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
  if (s.shot) drawShot(s, t);
  s.over?.(o, lt, t, 1 / FPS);
  enterFx(o, s, lt);
  exitFx(o, SEGMENTS[idx + 1], s.t1 - t);
}

async function audio(): Promise<string> {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil((DURATION + 0.5) * rate), rate);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master).connect(ctx.destination);
  renderMusic(ctx, comp);
  const sfx = ctx.createGain();
  sfx.gain.value = 0.55;
  sfx.connect(comp);
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
  scan: (spec: MatchSpec, ticks: number) => scan(spec, ticks),
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
