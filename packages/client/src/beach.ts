import {
  ARENAS,
  BALL,
  FIELD,
  PLAYER,
  inWater,
  nextRandom,
  shoreY,
  type Duck,
  type Game,
} from '@crateball/sim';

/**
 * The beach arena's look: sand with the pitch lines scratched into it, umbrellas, the sea coming in from
 * the top touchline (waves, foam, sparkles, wakes), rubber ducks, swimmers in rings and the beach ball.
 * Cosmetic only: the water changes nothing in the game; the ducks are sim state and drawn where they are.
 */

const INK = '#1B2133';
const SAND = {
  dry: '#EED7A1',
  pitchA: '#E2C17E',
  pitchB: '#DCB976',
  wet: 'rgba(150,110,55,.28)',
  line: 'rgba(255,255,255,.92)',
  lineShadow: 'rgba(120,80,30,.28)',
};
const SEA_DEEP = '#2A9CC4';
const UMBRELLAS: ReadonlyArray<readonly [string, string]> = [
  ['#E8574A', '#FFF4E0'],
  ['#4A7DE8', '#FFF4E0'],
  ['#FFD23F', '#FFF4E0'],
  ['#3FB6D3', '#FFF4E0'],
  ['#FF8FB1', '#FFF4E0'],
  ['#7CCB6B', '#FFF4E0'],
];
const DUCK_BODY = ['#FFD23F', '#FFC93A', '#FFDA55', '#FFD23F'];

/** The view the renderer draws (world units): the pitch plus its margins. */
const VW = FIELD.halfW + FIELD.marginX + 10;
const VH = FIELD.halfH + FIELD.margin + 10;

interface ShorePoint {
  x: number;
  y: number;
  /** Unit normal pointing onto the sand. */
  nx: number;
  ny: number;
}

/** The waterline across the view, with its normals (from the slope of the shoreline). */
const SHORE: ShorePoint[] = (() => {
  const pts: ShorePoint[] = [];
  for (let x = -VW - 10; x <= VW + 10; x += 6) {
    const y = shoreY(x);
    if (y < -VH - 20) continue;
    const slope = (shoreY(x + 0.5) - shoreY(x - 0.5)) / 1;
    // The water is above the line: the sand-side normal is (−slope, 1), normalised.
    const n = Math.sqrt(slope * slope + 1);
    pts.push({ x, y, nx: -slope / n, ny: 1 / n });
  }
  return pts;
})();

function waterPath(c: CanvasRenderingContext2D) {
  c.beginPath();
  c.moveTo(-VW - 20, -VH - 20);
  for (let x = -VW - 20; x <= VW + 20; x += 6) c.lineTo(x, Math.max(-VH - 20, shoreY(x)));
  c.lineTo(VW + 20, -VH - 20);
  c.closePath();
}

/** The pitch markings as polylines, sampled every few px. */
function linePaths(): Array<Array<[number, number]>> {
  const { halfW, halfH, centerRadius } = FIELD;
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
    return Array.from({ length: n + 1 }, (_, i): [number, number] => [
      x0 + ((x1 - x0) * i) / n,
      y0 + ((y1 - y0) * i) / n,
    ]);
  };
  const rect = (x: number, y: number, w: number, h: number) => [
    seg(x, y, x + w, y),
    seg(x + w, y, x + w, y + h),
    seg(x + w, y + h, x, y + h),
    seg(x, y + h, x, y),
  ];
  const n = Math.ceil((Math.PI * 2 * centerRadius) / 6);
  const circle = Array.from({ length: n + 1 }, (_, i): [number, number] => [
    Math.cos((i / n) * Math.PI * 2) * centerRadius,
    Math.sin((i / n) * Math.PI * 2) * centerRadius,
  ]);
  return [
    ...rect(-halfW, -halfH, halfW * 2, halfH * 2),
    seg(0, -halfH, 0, halfH),
    circle,
    ...rect(halfW - 90, -130, 90, 260),
    ...rect(-halfW, -130, 90, 260),
  ];
}

/** A line scratched into sand: a slow sideways wobble, scuffed gaps, uneven strength, loose grains. */
function scratchedLines(g: CanvasRenderingContext2D, r: () => number, style: string, w: number, off: number) {
  g.save();
  g.translate(off, off);
  g.strokeStyle = style;
  g.fillStyle = style;
  g.lineCap = 'round';
  for (const path of linePaths()) {
    const ph = r() * 10;
    let gap = 0;
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1]!;
      const [x1, y1] = path[i]!;
      if (gap > 0) {
        gap--;
        continue;
      }
      if (r() < 0.035) {
        gap = 1 + Math.floor(r() * 3);
        continue;
      }
      // No markings in the sea.
      if (inWater(x0, y0) && inWater(x1, y1)) continue;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      const j0 = Math.sin(ph + i * 0.35) * 1.6 + (r() - 0.5) * 0.8;
      const j1 = Math.sin(ph + (i + 1) * 0.35) * 1.6 + (r() - 0.5) * 0.8;
      g.globalAlpha = 0.55 + r() * 0.45;
      g.lineWidth = w * (0.7 + r() * 0.5);
      g.beginPath();
      g.moveTo(x0 + nx * j0, y0 + ny * j0);
      g.lineTo(x1 + nx * j1, y1 + ny * j1);
      g.stroke();
      if (r() < 0.25) g.fillRect(x0 + nx * (r() - 0.5) * 9, y0 + ny * (r() - 0.5) * 9, 1.6, 1.6);
    }
  }
  g.restore();
  g.globalAlpha = 1;
}

function umbrella(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  a: string,
  b: string,
  tilt: number,
) {
  c.save();
  c.translate(x, y);
  c.fillStyle = 'rgba(90,60,20,.22)';
  c.beginPath();
  c.ellipse(5, 7, r * 1.02, r * 0.95, 0, 0, Math.PI * 2);
  c.fill();
  c.rotate(tilt);
  const n = 8;
  for (let i = 0; i < n; i++) {
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, r, (i / n) * Math.PI * 2, ((i + 1) / n) * Math.PI * 2);
    c.closePath();
    c.fillStyle = i % 2 ? a : b;
    c.fill();
  }
  // Scalloped rim: the canopy sags between the ribs.
  c.strokeStyle = INK;
  c.lineWidth = 2;
  c.lineJoin = 'round';
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    if (i === 0) c.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
    c.quadraticCurveTo(Math.cos(am) * r * 0.9, Math.sin(am) * r * 0.9, Math.cos(a1) * r, Math.sin(a1) * r);
  }
  c.closePath();
  c.stroke();
  c.lineWidth = 1.1;
  c.strokeStyle = 'rgba(27,33,51,.45)';
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a0) * r * 0.97, Math.sin(a0) * r * 0.97);
    c.stroke();
  }
  c.beginPath();
  c.arc(0, 0, 2.8, 0, Math.PI * 2);
  c.fillStyle = '#FFF4E0';
  c.fill();
  c.lineWidth = 1.5;
  c.strokeStyle = INK;
  c.stroke();
  c.restore();
}

function towel(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  a: string,
  rot: number,
) {
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.beginPath();
  c.roundRect(-w / 2, -h / 2, w, h, 3);
  c.fillStyle = a;
  c.fill();
  c.save();
  c.clip();
  c.fillStyle = 'rgba(255,244,224,.85)';
  for (let i = -w / 2 + 4; i < w / 2; i += 9) c.fillRect(i, -h / 2, 4.5, h);
  c.restore();
  c.lineWidth = 1.6;
  c.strokeStyle = INK;
  c.stroke();
  c.restore();
}

/**
 * The still beach, drawn once into the renderer's cached pitch (in world coordinates): sand and its
 * grains, the packed-sand pitch with scratched lines, wet sand and the sea's resting colours, the nets,
 * towels and umbrellas along the bottom edge. Posts are drawn by the caller, as on every arena.
 */
export function drawBeachGround(g: CanvasRenderingContext2D, net: (side: -1 | 1) => void) {
  const { halfW, halfH } = FIELD;
  let s = 99;
  const r = () => {
    const [v, ns] = nextRandom(s);
    s = ns;
    return v;
  };
  g.fillStyle = SAND.dry;
  g.fillRect(-VW - 200, -VH - 200, VW * 2 + 400, VH * 2 + 400);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(160,120,60,.13)' : 'rgba(255,255,255,.22)';
    g.fillRect((r() * 2 - 1) * VW, (r() * 2 - 1) * VH, 1.6, 1.6);
  }
  const stripe = (halfW * 2) / 12;
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? SAND.pitchA : SAND.pitchB;
    g.fillRect(-halfW + i * stripe, -halfH, stripe + 0.5, halfH * 2);
  }
  for (let i = 0; i < 500; i++) {
    g.fillStyle = 'rgba(120,85,40,.12)';
    g.fillRect((r() * 2 - 1) * halfW, (r() * 2 - 1) * halfH, 1.5, 1.5);
  }
  scratchedLines(g, r, SAND.lineShadow, 4, 1.2);
  scratchedLines(g, r, SAND.line, 3, 0);
  // Wet sand along the waterline, then the sea and its shallow bands.
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  SHORE.forEach((p, i) =>
    i ? g.lineTo(p.x + p.nx * 4, p.y + p.ny * 4) : g.moveTo(p.x + p.nx * 4, p.y + p.ny * 4),
  );
  g.strokeStyle = SAND.wet;
  g.lineWidth = 16;
  g.stroke();
  g.save();
  waterPath(g);
  g.fillStyle = SEA_DEEP;
  g.fill();
  g.clip();
  for (const [w, col] of [
    [60, 'rgba(70,195,220,.55)'],
    [30, 'rgba(120,225,235,.6)'],
    [12, 'rgba(185,245,245,.7)'],
  ] as const) {
    g.beginPath();
    SHORE.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.strokeStyle = col;
    g.lineWidth = w;
    g.stroke();
  }
  g.restore();
  net(-1);
  net(1);
  // Beyond the bottom touchline, mostly past where anyone can run.
  const y = halfH + FIELD.margin - 1;
  for (const [x, i] of [
    [-300, 0],
    [60, 3],
    [330, 5],
  ] as const)
    towel(g, x, y - 4, 40, 15, UMBRELLAS[i]![0], (i - 2) * 0.05);
  for (let i = 0; i < 7; i++) {
    const [a, b] = UMBRELLAS[i % UMBRELLAS.length]!;
    umbrella(g, -420 + i * 140, y + 6, 17, a, b, i * 0.4);
  }
}

interface Ripple {
  x: number;
  y: number;
  r: number;
  grow: number;
  life: number;
  max: number;
  alpha: number;
}

/** Per-renderer state of the beach: wakes, the rings swimmers wear, the ball's roll. */
export function createBeach() {
  const ripples: Ripple[] = [];
  const ring = new Map<string, number>();
  let ballSpin = 0;
  let lastTick = -1;
  const sparkles: Array<{ x: number; y: number; ph: number; len: number }> = [];
  {
    let s = 7;
    const r = () => {
      const [v, ns] = nextRandom(s);
      s = ns;
      return v;
    };
    for (let k = 0; k < 400 && sparkles.length < 26; k++) {
      const x = (r() * 2 - 1) * VW;
      const y = (r() * 2 - 1) * VH;
      if (y < shoreY(x) - 14) sparkles.push({ x, y, ph: r() * 6.28, len: 4 + r() * 5 });
    }
  }
  const addRipple = (x: number, y: number, r0: number, grow: number, life: number, alpha: number) => {
    if (ripples.length < 120) ripples.push({ x, y, r: r0, grow, life, max: life, alpha });
  };

  /** Wakes behind swimmers, ducks and a moving ball; once per sim tick. */
  const wakes = (g: Game) => {
    if (g.tick === lastTick) return;
    const ticks = lastTick < 0 || g.tick < lastTick ? 1 : Math.min(5, g.tick - lastTick);
    lastTick = g.tick;
    for (let n = 0; n < ticks; n++)
      for (let i = ripples.length - 1; i >= 0; i--) {
        const p = ripples[i]!;
        p.r += p.grow;
        if (--p.life <= 0) ripples.splice(i, 1);
      }
    if (g.tick % 9 === 0) {
      for (const p of g.players) {
        if (p.dead > 0 || !inWater(p.x, p.y) || Math.hypot(p.vx, p.vy) < 0.25) continue;
        addRipple(p.x - p.vx * 6, p.y - p.vy * 6, PLAYER.radius + 4, 0.45, 40, 0.5);
      }
      for (const d of g.arena.ducks)
        if (Math.hypot(d.vx, d.vy) > 0.15) addRipple(d.x - d.hx * 9, d.y - d.hy * 9, 5, 0.32, 40, 0.45);
    }
    const b = g.ball;
    const bs = Math.hypot(b.vx, b.vy);
    if (inWater(b.x, b.y) && bs > 0.2 && g.tick % Math.max(3, Math.round(12 - bs * 2)) === 0)
      addRipple(b.x, b.y, BALL.radius, 0.5 + bs * 0.08, 36, 0.7);
    ballSpin += bs / BALL.radius / 2;
  };

  /** Waves rolling in, sparkles, wakes and the foam line; under everything that moves. */
  const drawWater = (c: CanvasRenderingContext2D, g: Game, t: number) => {
    wakes(g);
    keep(g);
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    waterPath(c);
    c.clip();
    for (let k = 0; k < 3; k++) {
      const ph = (t / 2600 + k / 3) % 1;
      const d = 8 + 46 * (1 - ph);
      c.strokeStyle = `rgba(255,255,255,${(Math.sin(ph * Math.PI) * 0.55).toFixed(3)})`;
      c.lineWidth = 2;
      c.beginPath();
      SHORE.forEach((p, i) => {
        const wob = Math.sin(i * 0.45 + t / 500 + k * 2) * 2.2;
        const x = p.x - p.nx * (d + wob);
        const y = p.y - p.ny * (d + wob);
        if (i) c.lineTo(x, y);
        else c.moveTo(x, y);
      });
      c.setLineDash([18 + k * 6, 10 + k * 4]);
      c.lineDashOffset = -t / 60 + k * 11;
      c.stroke();
    }
    c.setLineDash([]);
    c.strokeStyle = 'rgba(255,255,255,.75)';
    c.lineWidth = 1.6;
    for (const s of sparkles) {
      const a = Math.sin(t / 380 + s.ph);
      if (a < 0.4) continue;
      c.globalAlpha = (a - 0.4) / 0.6;
      c.beginPath();
      c.moveTo(s.x - s.len / 2, s.y);
      c.lineTo(s.x + s.len / 2, s.y);
      c.stroke();
    }
    c.globalAlpha = 1;
    c.lineWidth = 1.6;
    for (const p of ripples) {
      c.strokeStyle = `rgba(255,255,255,${(p.alpha * (p.life / p.max)).toFixed(3)})`;
      c.beginPath();
      c.ellipse(p.x, p.y, p.r, p.r * 0.8, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
    // Foam at the waterline: a swash line running up and back, with bubbles.
    const pts = SHORE.map((p, i) => {
      const run = 2.2 * Math.sin(t / 700 + i * 0.05) + 1.6 * Math.sin(i * 0.38 + t / 330);
      return { x: p.x + p.nx * run, y: p.y + p.ny * run };
    });
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.strokeStyle = 'rgba(255,255,255,.95)';
    c.lineWidth = 4;
    c.lineCap = 'round';
    c.stroke();
    c.lineCap = 'butt';
    c.fillStyle = 'rgba(255,255,255,.9)';
    pts.forEach((p, i) => {
      if (i % 3) return;
      const q = SHORE[i]!;
      const b = 1.2 + 1.3 * (0.5 + 0.5 * Math.sin(i * 1.7 + t / 260));
      c.beginPath();
      c.arc(p.x - q.nx * 4.5, p.y - q.ny * 4.5, b, 0, Math.PI * 2);
      c.fill();
    });
    // Buoys bobbing out at sea, past where anyone swims.
    for (const x of [-300, -170, 170, 300]) {
      const y = -FIELD.halfH - FIELD.margin + 4 + Math.sin(t / 600 + x) * 1.5;
      c.beginPath();
      c.arc(x, y, 5, 0, Math.PI * 2);
      c.fillStyle = '#FF8A3D';
      c.fill();
      c.lineWidth = 1.6;
      c.strokeStyle = INK;
      c.stroke();
    }
  };

  /** A rubber duck, top-down, facing its heading; spins while dazed. */
  const drawDuck = (c: CanvasRenderingContext2D, d: Duck, t: number) => {
    const b = ARENAS.beach;
    const bob = Math.sin(t / 420 + d.id * 1.7) * 0.8;
    let ang = Math.atan2(d.hy, d.hx) + Math.sin(t / 260 + d.id) * 0.06;
    if (d.stun > 0) ang += (d.stun / b.duckStun) ** 2 * 7;
    const body = DUCK_BODY[d.id % DUCK_BODY.length]!;
    c.save();
    c.translate(d.x, d.y + bob);
    c.beginPath();
    c.ellipse(0, 1.5 - bob, 14, 11, 0, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,.45)';
    c.lineWidth = 1.5;
    c.stroke();
    c.rotate(ang);
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(-9, -4.5);
    c.lineTo(-14.5, -1);
    c.lineTo(-10, 3);
    c.closePath();
    c.fillStyle = body;
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 2;
    c.stroke();
    c.beginPath();
    c.ellipse(-1, 0, 11, 8.6, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.beginPath();
    c.ellipse(-3.2, 0.6, 5.4, 4.2, -0.15, 0, Math.PI * 2);
    c.fillStyle = '#F2B41F';
    c.fill();
    c.beginPath();
    c.ellipse(-3.2, 0.6, 5.4, 4.2, -0.15, Math.PI * 1.15, Math.PI * 1.9);
    c.strokeStyle = 'rgba(27,33,51,.5)';
    c.lineWidth = 1.2;
    c.stroke();
    c.beginPath();
    c.ellipse(13, 0, 4.2, 2.9, 0, 0, Math.PI * 2);
    c.fillStyle = '#FF8A3D';
    c.fill();
    c.strokeStyle = INK;
    c.lineWidth = 1.6;
    c.stroke();
    c.beginPath();
    c.arc(7.2, 0, 6, 0, Math.PI * 2);
    c.fillStyle = body;
    c.fill();
    c.lineWidth = 2;
    c.stroke();
    for (const [x, y, r, col] of [
      [8.6, -3.1, 1.35, INK],
      [8.6, 3.1, 1.35, INK],
      [5.4, -2.2, 1.3, 'rgba(255,255,255,.85)'],
      [-5, -3.5, 1.6, 'rgba(255,255,255,.6)'],
    ] as const) {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = col;
      c.fill();
    }
    // Just hit: a white flash.
    if (d.cd > b.duckCooldown - 5) {
      c.globalAlpha = 0.55;
      c.beginPath();
      c.ellipse(1, 0, 14, 10, 0, 0, Math.PI * 2);
      c.fillStyle = '#FFFFFF';
      c.fill();
      c.globalAlpha = 1;
    }
    c.restore();
  };

  /** The inflatable ring, pink with white bands; `k` 0..1 as it pops on. */
  const drawRing = (c: CanvasRenderingContext2D, r: number, k: number, t: number, ph: number) => {
    const rr = (r + 4.5) * (0.6 + 0.4 * k);
    const w = 7 * k;
    c.save();
    c.rotate(Math.sin(t / 900 + ph) * 0.25);
    c.beginPath();
    c.arc(0, 0, rr + w / 2 + 1, 0, Math.PI * 2);
    c.strokeStyle = INK;
    c.lineWidth = 2;
    c.stroke();
    c.lineWidth = w;
    for (let i = 0; i < 8; i++) {
      c.beginPath();
      c.arc(0, 0, rr, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2 + 0.01);
      c.strokeStyle = i % 2 ? '#FFFFFF' : '#FF8FB1';
      c.stroke();
    }
    c.beginPath();
    c.arc(0, 0, rr + w * 0.15, -2.4, -1.5);
    c.strokeStyle = 'rgba(255,255,255,.75)';
    c.lineWidth = Math.max(1, w * 0.28);
    c.lineCap = 'round';
    c.stroke();
    c.lineCap = 'butt';
    c.restore();
  };

  /**
   * How far player `id` wears a ring (0 on sand, 1 swimming; it pops on and off over a few frames), so
   * the caller knows whether to draw the plain body.
   */
  /** Forget players who are gone (a swimmer leaving in the water would keep its ring entry forever). */
  const keep = (g: Game) => {
    if (ring.size === 0) return;
    for (const id of ring.keys()) if (!g.players.some((p) => p.id === id && p.dead === 0)) ring.delete(id);
  };

  const swim = (id: string, x: number, y: number): number => {
    const k = Math.max(0, Math.min(1, (ring.get(id) ?? 0) + (inWater(x, y) ? 0.12 : -0.12)));
    if (k === 0) ring.delete(id);
    else ring.set(id, k);
    return k;
  };

  /**
   * A swimmer and the ring as one floating piece with a gentle rock: a slight squash and a faint shade on
   * the low side, a bright wobbling meniscus, ripples spreading out and a few drops on the low side as it
   * dips deepest (more behind a fast swimmer). Only the drawing: reach and collisions are untouched.
   */
  const drawSwimmer = (
    c: CanvasRenderingContext2D,
    id: string,
    x: number,
    y: number,
    r: number,
    k: number,
    t: number,
    fill: string,
    outline: string,
    lw: number,
    vx: number,
    vy: number,
  ) => {
    let ph = 0;
    for (let i = 0; i < id.length; i++) ph = (ph * 31 + id.charCodeAt(i)) % 997;
    ph /= 97;
    const tilt = ph + t / 1700 + 1.1 * Math.sin(t / 2300 + ph * 0.7);
    const a = k * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 560 + ph * 1.3)));
    const ux = Math.cos(tilt);
    const uy = Math.sin(tilt);
    const R = r + 4.5 + 7 * k;
    for (let n = 0; n < 2; n++) {
      const f = (t / 1500 + ph * 0.37 + n * 0.5) % 1;
      c.beginPath();
      c.ellipse(x, y + 1, R + 2 + f * 16, (R + 2 + f * 16) * 0.92, 0, 0, Math.PI * 2);
      c.strokeStyle = `rgba(255,255,255,${(0.28 * (1 - f) * k).toFixed(3)})`;
      c.lineWidth = 1.2;
      c.stroke();
    }
    c.save();
    c.translate(x - ux * r * 0.05 * a, y - uy * r * 0.05 * a);
    c.rotate(tilt);
    c.scale(1 - 0.06 * a, 1 + 0.015 * a);
    c.rotate(-tilt);
    drawRing(c, r, k, t, ph);
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = lw;
    c.strokeStyle = outline;
    c.stroke();
    if (a > 0.02) {
      const gr = c.createLinearGradient(0, 0, ux * R, uy * R);
      gr.addColorStop(0, 'rgba(30,140,200,0)');
      gr.addColorStop(1, `rgba(30,140,200,${(0.3 * a).toFixed(3)})`);
      c.beginPath();
      c.arc(0, 0, R + 1, 0, Math.PI * 2);
      c.fillStyle = gr;
      c.fill();
    }
    c.restore();
    c.beginPath();
    for (let i = 0; i <= 28; i++) {
      const th = (i / 28) * Math.PI * 2;
      const w = R + 1.5 + Math.sin(th * 3 + t / 260 + ph) * 0.9 + Math.cos(th - tilt) * 1.2 * a;
      if (i) c.lineTo(x + Math.cos(th) * w, y + Math.sin(th) * w);
      else c.moveTo(x + Math.cos(th) * w, y + Math.sin(th) * w);
    }
    c.strokeStyle = `rgba(255,255,255,${(0.5 * k).toFixed(3)})`;
    c.lineWidth = 1.3;
    c.stroke();
    const sp = Math.hypot(vx, vy);
    const splash = Math.max(0, (a - 0.8) / 0.2) + Math.min(1, sp / 2.4) * 0.8;
    if (splash > 0.05) {
      const bx = sp > 0.3 ? -vx / sp : ux;
      const by = sp > 0.3 ? -vy / sp : uy;
      for (let d = 0; d < 4; d++) {
        const p = (t / 180 + d * 0.27 + ph) % 1;
        const spread = (d - 1.5) * 0.45;
        const dx = bx * Math.cos(spread) - by * Math.sin(spread);
        const dy = bx * Math.sin(spread) + by * Math.cos(spread);
        const dist = R + 2 + p * 9;
        c.beginPath();
        c.arc(x + dx * dist, y + dy * dist - Math.sin(p * Math.PI) * 4, 1.6 * (1 - p) + 0.4, 0, Math.PI * 2);
        c.fillStyle = `rgba(255,255,255,${(0.8 * splash * (1 - p) * k).toFixed(3)})`;
        c.fill();
      }
    }
  };

  /** In the water the ball is a beach ball (six panels turning as it rolls) with a ring of foam. Returns
   * false on sand: the caller draws the normal ball. */
  const drawBall = (c: CanvasRenderingContext2D, x: number, y: number, t: number): boolean => {
    if (!inWater(x, y)) return false;
    const r = BALL.radius;
    c.beginPath();
    c.arc(x, y + 1, r + 3.5, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,255,255,.7)';
    c.lineWidth = 2;
    c.stroke();
    const by = y + Math.sin(t / 300) * 0.8;
    const cols = ['#E8574B', '#FFFFFF', '#FFD23F', '#FFFFFF', '#3E8EDE', '#FFFFFF'];
    c.save();
    c.translate(x, by);
    c.rotate(ballSpin);
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.moveTo(0, 0);
      c.arc(0, 0, r, (i / 6) * Math.PI * 2, ((i + 1) / 6) * Math.PI * 2);
      c.closePath();
      c.fillStyle = cols[i]!;
      c.fill();
    }
    c.restore();
    c.beginPath();
    c.arc(x, by, r * 0.28, 0, Math.PI * 2);
    c.fillStyle = '#FFFFFF';
    c.fill();
    c.beginPath();
    c.arc(x, by, r, 0, Math.PI * 2);
    c.lineWidth = 2;
    c.strokeStyle = INK;
    c.stroke();
    c.beginPath();
    c.arc(x - r * 0.3, by - r * 0.3, r * 0.45, Math.PI * 1.1, Math.PI * 1.55);
    c.strokeStyle = 'rgba(255,255,255,.8)';
    c.lineWidth = 1.6;
    c.lineCap = 'round';
    c.stroke();
    c.lineCap = 'butt';
    return true;
  };

  return { drawWater, drawDuck, swim, drawSwimmer, drawBall };
}

export type Beach = ReturnType<typeof createBeach>;
