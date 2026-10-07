// Motion graphics for the trailer: slammed words, sliding tags, flashes, the logo. All drawn on the
// 1920x1080 output canvas in plain 2D.

export const OUT_W = 1920;
export const OUT_H = 1080;
export const INK = '#1B2133';
export const RED = '#E8574A';
export const BLUE = '#4A7DE8';
export const CREAM = '#FFF4E0';
export const ORANGE = '#FF9A3D';
export const GOLD = '#FFCF4A';
/** Teleport purple: the game's own warp colour, used for the teleport tag only. */
export const VIOLET = '#C77DFF';

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeOut = (k: number) => 1 - (1 - clamp01(k)) ** 3;
export const easeIn = (k: number) => clamp01(k) ** 3;
export const easeOutBack = (k: number) => {
  const c = 1.9;
  const x = clamp01(k) - 1;
  return 1 + (c + 1) * x ** 3 + c * x ** 2;
};

type Ctx = CanvasRenderingContext2D;

export interface WordOpts {
  size: number;
  color?: string;
  /** Scale it starts from (big → 1 = a slam). */
  from?: number;
  rot?: number;
  align?: CanvasTextAlign;
  /** Fade out over the last `out` seconds before `life`. */
  life?: number;
  out?: number;
  font?: string;
}

/** A word that slams in at local time 0 (scale + fade), with a thick ink outline and a drop shadow. */
export function slam(o: Ctx, text: string, x: number, y: number, lt: number, w: WordOpts): void {
  if (lt < 0) return;
  const k = clamp01(lt / 0.2);
  const s = (w.from ?? 1.9) + (1 - (w.from ?? 1.9)) * easeOutBack(k);
  let a = clamp01(lt / 0.06);
  if (w.life !== undefined) a *= clamp01((w.life - lt) / (w.out ?? 0.15));
  if (a <= 0) return;
  o.save();
  o.globalAlpha = a;
  o.translate(x, y);
  o.rotate(w.rot ?? 0);
  o.scale(s, s);
  o.font = w.font ?? `800 ${w.size}px 'Baloo 2', sans-serif`;
  o.textAlign = w.align ?? 'center';
  o.textBaseline = 'middle';
  o.lineJoin = 'round';
  o.fillStyle = 'rgba(0,0,0,.35)';
  o.fillText(text, w.size * 0.04, w.size * 0.07);
  o.lineWidth = w.size * 0.14;
  o.strokeStyle = INK;
  o.strokeText(text, 0, 0);
  o.fillStyle = w.color ?? CREAM;
  o.fillText(text, 0, 0);
  o.restore();
}

/** A slanted label box that slides in from the left (or right), text on it. */
export function tag(
  o: Ctx,
  text: string,
  x: number,
  y: number,
  lt: number,
  opt: { size: number; bg: string; color?: string; fromRight?: boolean; life?: number; small?: string },
): void {
  if (lt < 0) return;
  const k = easeOut(lt / 0.28);
  let a = 1;
  if (opt.life !== undefined) a = clamp01((opt.life - lt) / 0.15);
  if (a <= 0) return;
  o.save();
  o.globalAlpha = a;
  o.font = `800 ${opt.size}px 'Baloo 2', sans-serif`;
  const tw = o.measureText(text).width;
  const pad = opt.size * 0.45;
  const h = opt.size * 1.15;
  const dir = opt.fromRight ? 1 : -1;
  const off = (1 - k) * (tw + 600) * dir;
  o.translate(x + off, y);
  o.transform(1, 0, -0.18, 1, 0, 0);
  o.fillStyle = 'rgba(0,0,0,.35)';
  o.fillRect(-pad + 10, -h / 2 + 12, tw + pad * 2, h);
  o.fillStyle = opt.bg;
  o.fillRect(-pad, -h / 2, tw + pad * 2, h);
  o.lineWidth = 6;
  o.strokeStyle = INK;
  o.strokeRect(-pad, -h / 2, tw + pad * 2, h);
  o.setTransform(o.getTransform().multiply(new DOMMatrix([1, 0, 0.18, 1, 0, 0])));
  o.textAlign = 'left';
  o.textBaseline = 'middle';
  o.fillStyle = opt.color ?? INK;
  o.fillText(text, 0, opt.size * 0.06);
  if (opt.small) {
    o.font = `800 ${opt.size * 0.34}px Nunito, sans-serif`;
    o.fillStyle = CREAM;
    o.lineWidth = 6;
    o.strokeStyle = INK;
    o.strokeText(opt.small, 4, -h / 2 - opt.size * 0.28);
    o.fillText(opt.small, 4, -h / 2 - opt.size * 0.28);
  }
  o.restore();
}

/** Dark backdrop with slowly drifting diagonal team stripes. */
export function backdrop(o: Ctx, t: number, tint = 1): void {
  const g = o.createRadialGradient(OUT_W / 2, OUT_H / 2, 100, OUT_W / 2, OUT_H / 2, OUT_W * 0.7);
  g.addColorStop(0, '#1d2550');
  g.addColorStop(1, '#090d22');
  o.fillStyle = g;
  o.fillRect(0, 0, OUT_W, OUT_H);
  o.save();
  o.globalAlpha = 0.07 * tint;
  o.translate(OUT_W / 2, OUT_H / 2);
  o.rotate(-0.5);
  const step = 160;
  const shift = (t * 60) % (step * 2);
  for (let x = -2200 + shift; x < 2200; x += step) {
    o.fillStyle = Math.round((x - shift) / step) % 2 ? RED : BLUE;
    o.fillRect(x, -1600, step / 2, 3200);
  }
  o.restore();
}

export function flash(o: Ctx, k: number, color = '#fff'): void {
  if (k >= 1) return;
  o.save();
  o.globalAlpha = (1 - clamp01(k)) ** 2;
  o.fillStyle = color;
  o.fillRect(0, 0, OUT_W, OUT_H);
  o.restore();
}

export function vignette(o: Ctx, strength = 0.55): void {
  const g = o.createRadialGradient(OUT_W / 2, OUT_H / 2, OUT_H * 0.45, OUT_W / 2, OUT_H / 2, OUT_W * 0.65);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  o.fillStyle = g;
  o.fillRect(0, 0, OUT_W, OUT_H);
}

// The crate + ball icon (same art as favicon.svg, drawn in its 64-unit box).
const CRATE = new Path2D('M9 17 39 47M39 17 9 47');
const PENT = new Path2D('M43 31.5l5.5 4-2 6.5h-7l-2-6.5z');
const SEAMS = new Path2D('M43 25v6.5M48.5 35.5l6-1.5M46.5 42l3.5 5.5M39.5 42 36 47.5M37.5 35.5l-6-1.5');

/** The logo mark. `crateY`/`ballK` animate the drop and the ball popping out (0..1). */
export function logoMark(
  o: Ctx,
  x: number,
  y: number,
  size: number,
  crateY: number,
  ballK: number,
  open = 0,
): void {
  o.save();
  o.translate(x, y);
  o.scale(size / 64, size / 64);
  o.translate(-32, -32);
  // shadow
  o.fillStyle = 'rgba(0,0,0,.3)';
  o.beginPath();
  o.ellipse(30, 52, 20 - Math.min(14, Math.abs(crateY) * 0.1), 3.5, 0, 0, 7);
  o.fill();
  o.save();
  o.translate(0, crateY);
  // lid pops up a bit when it opens
  o.fillStyle = '#C88A4A';
  o.fillRect(9, 17, 30, 30);
  o.lineWidth = 3;
  o.strokeStyle = '#7A4E22';
  o.strokeRect(9, 17, 30, 30);
  o.stroke(CRATE);
  if (open > 0) {
    o.translate(24, 17 - open * 10);
    o.rotate(-open * 0.5);
    o.fillStyle = '#C88A4A';
    o.fillRect(-16, -4, 32, 6);
    o.strokeRect(-16, -4, 32, 6);
  }
  o.restore();
  if (ballK > 0) {
    const bx = 24 + (43 - 24) * easeOut(ballK);
    const by = 32 + (38 - 32) * easeOut(ballK) - Math.sin(clamp01(ballK) * Math.PI) * 26;
    o.save();
    o.translate(bx - 43, by - 38);
    o.beginPath();
    o.arc(43, 38, 13, 0, 7);
    o.fillStyle = '#fff';
    o.fill();
    o.lineWidth = 3;
    o.strokeStyle = INK;
    o.stroke();
    o.fillStyle = INK;
    o.fill(PENT);
    o.lineWidth = 2;
    o.stroke(SEAMS);
    o.restore();
  }
  o.restore();
}

/** Confetti / sparks for the logo and goal moments. */
export interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  vr: number;
  c: string;
  life: number;
}
export function burst(bits: Bit[], x: number, y: number, n: number, speed: number, colors: string[]): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.7);
    bits.push({
      x,
      y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - speed * 0.3,
      r: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[i % colors.length]!,
      life: 1.4 + Math.random(),
    });
  }
}
export function drawBits(o: Ctx, bits: Bit[], dt: number): void {
  for (const b of bits) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vy += 900 * dt;
    b.vx *= 0.99;
    b.r += b.vr;
    b.life -= dt;
    if (b.life <= 0) continue;
    o.save();
    o.globalAlpha = clamp01(b.life / 0.4);
    o.translate(b.x, b.y);
    o.rotate(b.r);
    o.fillStyle = b.c;
    o.fillRect(-9, -4, 18, 8);
    o.restore();
  }
  for (let i = bits.length - 1; i >= 0; i--) if (bits[i]!.life <= 0) bits.splice(i, 1);
}

/**
 * The brand lock-up: mark, name, tagline. One definition for the title card and the end card.
 * `ballK`/`open`/`crateY` animate the mark (see logoMark); `titleT`/`tagT` are the local times the
 * name and the tagline slam in (negative = not yet).
 */
export function lockup(
  o: Ctx,
  cx: number,
  cy: number,
  a: { crateY?: number; ballK?: number; open?: number; markScale?: number; titleT: number; tagT: number },
): void {
  const mark = 300 * (a.markScale ?? 1);
  logoMark(o, cx, cy - 190, mark, (a.crateY ?? 0) / (mark / 64), a.ballK ?? 1, a.open ?? 1);
  slam(o, 'CRATEBALL', cx, cy + 50, a.titleT, { size: 180, color: GOLD, from: 2 });
  slam(o, '3v3 ARCADE FOOTBALL', cx, cy + 165, a.tagT, { size: 60, color: CREAM, from: 1.25 });
}
