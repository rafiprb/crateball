// The trailer, bar by bar. Every cut lands on the music (music.ts); every shot is a real bot match
// replayed from a seed, anchored on the event its label talks about (found with scan()/dryRun()) and
// checked by check() in main.ts: the event happens while the shot is up, inside the frame and never
// under the text.
//
// House rules (trailer conventions):
// - Hook in the first second (a bazooka exchange), the name within two seconds.
// - Only real gameplay; every label is shown happening; no claim the game does not back up.
// - One brand lock-up (fx.ts lockup) at both ends; two typefaces (Baloo 2, Nunito); brand colours only.
// - Two text positions: statements top centre, feature tags in the lower third on the left. The
//   camera puts the action away from them (Segment.subject). Everything inside the 10% title-safe area.
// - At most three words per beat; every line stays up at least a beat and a half.
// - Hard cuts inside a group, a wipe between groups, a flash where the music changes section.
// - End card: lock-up, one call to action, the address and a legal line, held for 3+ seconds.
import type { Key, MatchSpec } from './match';
import { BAR, BEAT, SECTION } from './music';
import {
  BLUE,
  CREAM,
  GOLD,
  INK,
  ORANGE,
  OUT_H,
  OUT_W,
  RED,
  VIOLET,
  backdrop,
  burst,
  drawBits,
  easeIn,
  easeOut,
  flash,
  lockup,
  slam,
  tag,
  vignette,
  wipe,
  type Bit,
} from './fx';

export interface Shot {
  spec: MatchSpec;
  /** Sim tick the shot starts at. */
  from: number;
  /** The event the shot is about, and the tick it happens. */
  key?: Key;
  keyTick?: number;
  /** Ticks per frame (0.4 = slow motion). */
  speed?: number;
  /** Camera zoom at the start and the end of the shot. */
  zoom: [number, number];
}

type Rect = [number, number, number, number];

export interface Segment {
  t0: number;
  t1: number;
  shot?: Shot;
  /** Where in the frame the action sits (fractions); keeps it away from the text. */
  subject?: [number, number];
  /** Text areas the key event must stay out of (checked). */
  clear?: Rect[];
  /** Blur of the footage in px (the break). */
  blur?: (lt: number) => number;
  /** Draws over the shot; `lt` = seconds since the segment started. */
  over?: (o: CanvasRenderingContext2D, lt: number, t: number, dt: number) => void;
  /** How the segment comes in. */
  enter?: 'cut' | 'wipe' | 'flash';
}

const bar = (b: number, beat = 0) => b * BAR + beat * BEAT;
const CX = OUT_W / 2;
/** Title-safe area (10%). */
const SAFE = { x: OUT_W * 0.1, y: OUT_H * 0.1 };
const FPS = 60;

// The two text positions and the frame areas they cover.
const TOP_1 = SAFE.y + 70;
const TOP_2 = SAFE.y + 195;
const TOP_RECT: Rect = [0, 0, OUT_W, SAFE.y + 270];
const TOP_SUBJECT: [number, number] = [0.5, 0.64];
const TAG_Y = OUT_H - SAFE.y - 75;
const TAG_RECT: Rect = [0, TAG_Y - 120, OUT_W * 0.55, OUT_H];
const TAG_SUBJECT: [number, number] = [0.6, 0.52];

/** A shot whose key event lands `at` seconds into it. */
function shot(
  spec: MatchSpec,
  key: Key,
  keyTick: number,
  at: number,
  zoom: [number, number],
  speed = 1,
): Shot {
  return { spec, key, keyTick, from: keyTick - Math.round(at * FPS * speed), zoom, speed };
}
const classic = (seed: number): MatchSpec => ({ seed, arena: 'classic' });
const only = (seed: number, items: MatchSpec['items'], chaos = true): MatchSpec => ({
  seed,
  arena: 'classic',
  items,
  chaos,
});

/** A soft dark band behind the top text: readable on any frame, and play behind it stays visible. */
function band(o: CanvasRenderingContext2D, lt: number) {
  const g = o.createLinearGradient(0, 0, 0, TOP_RECT[3] + 40);
  const a = 0.5 * easeOut(lt / 0.25);
  g.addColorStop(0, `rgba(9,13,34,${a})`);
  g.addColorStop(0.75, `rgba(9,13,34,${a * 0.75})`);
  g.addColorStop(1, 'rgba(9,13,34,0)');
  o.fillStyle = g;
  o.fillRect(0, 0, OUT_W, TOP_RECT[3] + 40);
}

/** A top-centre statement: one or two lines, the second a beat later. */
function statement(o: CanvasRenderingContext2D, lt: number, a: string, b: string, colorB: string) {
  band(o, lt);
  slam(o, a, CX, TOP_1, lt, { size: 96, from: 1.4 });
  slam(o, b, CX, TOP_2, lt - BEAT, { size: 130, color: colorB, from: 1.6 });
}

export const SEGMENTS: Segment[] = [];
const add = (s: Segment) => SEGMENTS.push(s);

// ── Cold open: a bazooka exchange, rocket already in the air ────────────────────────────────────
add({ t0: bar(0), t1: bar(1), shot: shot(only(1, ['bazooka']), 'rocket', 2064, 0.4, [1.75, 1.95]) });

// ── Title card ──────────────────────────────────────────────────────────────────────────────────
add({
  t0: bar(1),
  t1: bar(2),
  enter: 'flash',
  over(o, lt, t) {
    backdrop(o, t);
    lockup(o, CX, OUT_H / 2 + 20, {
      markScale: 0.8 + 0.2 * easeOut(lt / 0.35),
      titleT: lt - 0.05,
      tagT: lt - BEAT,
    });
  },
});

// ── Intro: plain football first, then the twist ─────────────────────────────────────────────────
add({
  t0: bar(2),
  t1: bar(3),
  enter: 'cut',
  subject: TOP_SUBJECT,
  clear: [TOP_RECT],
  shot: shot(classic(14), 'goal', 865, 1.5, [1.3, 1.42]),
  over(o, lt) {
    band(o, lt);
    // Three words on three beats, spaced by their measured widths.
    o.font = "800 100px 'Baloo 2', sans-serif";
    const words = ['MOVE.', 'KICK.', 'SCORE.'];
    const gap = 40;
    const widths = words.map((w) => o.measureText(w).width);
    let x = CX - (widths.reduce((a, b) => a + b, 0) + gap * 2) / 2;
    words.forEach((w, i) => {
      slam(o, w, x + widths[i]! / 2, TOP_1 + 40, lt - i * BEAT, { size: 100, from: 1.5 });
      x += widths[i]! + gap;
    });
  },
});
add({
  t0: bar(3),
  t1: bar(4),
  enter: 'wipe',
  subject: TOP_SUBJECT,
  clear: [TOP_RECT],
  shot: shot(only(9, ['gun', 'bazooka', 'teleport'], false), 'loot', 970, 1.25, [1.75, 1.95]),
  over: (o, lt) => statement(o, lt, 'THEN OPEN', 'THE CRATES', GOLD),
});

// ── Drop: what comes out of crates ──────────────────────────────────────────────────────────────
type Feature = { shot: Shot; label: string; small: string; color: string; size?: number };
const feature = (b: number, f: Feature, enter: Segment['enter']) =>
  add({
    t0: bar(b),
    t1: bar(b + 1),
    enter,
    subject: TAG_SUBJECT,
    clear: [TAG_RECT],
    shot: f.shot,
    over(o, lt) {
      tag(o, f.label, SAFE.x, TAG_Y, lt - 0.05, { size: f.size ?? 120, bg: f.color, small: f.small });
    },
  });
const loot: Feature[] = [
  {
    shot: shot(only(6, ['gun']), 'gun', 2238, 0.85, [1.9, 2.05]),
    label: 'GUNS',
    small: 'CRATE LOOT',
    color: GOLD,
  },
  {
    shot: shot(only(7, ['bazooka']), 'rocket', 1922, 0.95, [1.7, 1.85]),
    label: 'BAZOOKAS',
    small: 'CRATE LOOT',
    color: ORANGE,
  },
  {
    shot: shot(
      { seed: 30, arena: 'classic', items: ['teleport', 'shield'] },
      'teleport',
      2319,
      1.0,
      [1.85, 2.0],
    ),
    label: 'TELEPORTS',
    small: 'CRATE LOOT',
    color: VIOLET,
  },
];
loot.forEach((f, i) => feature(SECTION.drop + i, f, i === 0 ? 'flash' : 'cut'));

// Traps: "some crates bite back".
add({
  t0: bar(SECTION.traps),
  t1: bar(SECTION.traps + 1),
  enter: 'wipe',
  subject: TOP_SUBJECT,
  clear: [TOP_RECT],
  shot: shot(only(6, ['dizzy']), 'dizzy', 1972, 1.0, [1.9, 2.05]),
  over: (o, lt) => statement(o, lt, 'SOME CRATES', 'BITE BACK', RED),
});
const traps: Feature[] = [
  {
    shot: shot(only(2, ['mine']), 'mine', 757, 1.05, [2.0, 2.15]),
    label: 'BOOM',
    small: 'TRAP CRATE',
    color: RED,
  },
  {
    shot: shot(only(5, ['ice']), 'ice', 1741, 1.0, [1.9, 2.05]),
    label: 'FREEZE',
    small: 'TRAP CRATE',
    color: BLUE,
  },
];
traps.forEach((f, i) => feature(SECTION.traps + 1 + i, f, 'cut'));

// ── Arenas, then positions ──────────────────────────────────────────────────────────────────────
const arenas: Feature[] = [
  {
    shot: shot({ seed: 5, arena: 'volcano' }, 'erupt', 1071, 1.3, [1.55, 1.7]),
    label: 'VOLCANO',
    small: 'ARENA',
    color: ORANGE,
  },
  {
    shot: shot(
      { seed: 2, arena: 'rain', items: ['bazooka'], chaos: true },
      'rocket',
      2857,
      0.95,
      [1.55, 1.7],
    ),
    label: 'RAIN',
    small: 'ARENA',
    color: BLUE,
  },
  {
    shot: shot({ seed: 7, arena: 'ice' }, 'goal', 1494, 1.2, [1.45, 1.6]),
    label: 'ICE RINK',
    small: 'ARENA',
    color: CREAM,
  },
  {
    shot: shot(classic(4), 'save', 1543, 0.9, [1.8, 1.95]),
    label: 'KEEPERS',
    small: 'POSITIONS',
    color: GOLD,
  },
];
arenas.forEach((f, i) => feature(SECTION.arenas + i, f, i === 0 ? 'wipe' : 'cut'));

// ── Break: a goal in slow motion, then it blurs behind the pitch to friends ─────────────────────
add({
  t0: bar(SECTION.brk),
  t1: bar(SECTION.drop2),
  enter: 'flash',
  shot: shot(classic(3), 'goal', 3996, 1.6, [1.6, 1.95], 0.4),
  blur: (lt) => 10 * easeOut((lt - BAR) / 0.5),
  over(o, lt) {
    const k = easeOut((lt - BAR) / 0.5);
    o.fillStyle = `rgba(9,13,34,${0.6 * k})`;
    o.fillRect(0, 0, OUT_W, OUT_H);
    slam(o, 'PLAY WITH FRIENDS', CX, OUT_H / 2 - 50, lt - BAR, { size: 140, color: GOLD, from: 1.5 });
    slam(o, 'JUST SHARE THE LINK', CX, OUT_H / 2 + 90, lt - BAR - BEAT * 2, { size: 84, from: 1.3 });
  },
});

// ── Drop 2: half-bar cuts ───────────────────────────────────────────────────────────────────────
const drop2: Shot[] = [
  shot({ seed: 6, arena: 'classic', chaos: true }, 'goal', 4582, 0.55, [1.5, 1.6]),
  shot(only(9, ['gun'], false), 'gun', 1001, 0.45, [1.9, 2.0]),
  shot(only(1, ['bazooka']), 'rocket', 887, 0.5, [1.7, 1.8]),
  shot({ seed: 1, arena: 'volcano' }, 'goal', 1825, 0.55, [1.45, 1.55]),
  shot({ seed: 16, arena: 'classic', items: ['mine', 'boost'] }, 'mine', 416, 0.45, [1.9, 2.0]),
  shot({ seed: 27, arena: 'classic', items: ['teleport', 'shield'] }, 'teleport', 1936, 0.45, [1.7, 1.8]),
  shot({ seed: 9, arena: 'wind' }, 'goal', 1229, 0.55, [1.45, 1.55]),
  shot({ seed: 4, arena: 'classic', chaos: true }, 'goal', 2232, 0.55, [1.5, 1.6]),
];
drop2.forEach((s, i) =>
  add({
    t0: bar(SECTION.drop2, i * 2),
    t1: bar(SECTION.drop2, i * 2 + 2),
    enter: i === 0 ? 'flash' : 'cut',
    subject: TOP_SUBJECT,
    clear: [TOP_RECT],
    shot: s,
    over(o, _lt, t) {
      const st = t - bar(SECTION.drop2);
      band(o, st);
      if (st < BAR * 2) {
        slam(o, 'PLAY FREE', CX, TOP_1, st, { size: 110, color: GOLD, from: 1.6 });
        slam(o, 'IN YOUR BROWSER', CX, TOP_2, st - BEAT * 2, { size: 96, from: 1.4 });
      } else {
        slam(o, 'COMING TO STEAM', CX, TOP_1 + 50, st - BAR * 2, { size: 120, from: 1.5 });
      }
    },
  }),
);

// ── End card ────────────────────────────────────────────────────────────────────────────────────
const bits: Bit[] = [];
let popped = false;
add({
  t0: bar(SECTION.outro),
  t1: bar(SECTION.end),
  enter: 'flash',
  over(o, lt, t, dt) {
    backdrop(o, t, 1.6);
    // The crate falls in on the first beat, rattles, and bursts open on the third (the big hit).
    const land = BEAT;
    const open = BEAT * 2;
    const fall = easeIn(lt / land);
    const bounce = lt > land ? Math.abs(Math.sin((lt - land) * 12)) * 16 * Math.exp(-(lt - land) * 7) : 0;
    const rattle = lt > land && lt < open ? Math.sin(lt * 70) * 6 * ((lt - land) / (open - land)) : 0;
    if (lt >= open && !popped) {
      popped = true;
      burst(bits, CX, OUT_H / 2 - 170, 160, 1500, [RED, BLUE, GOLD, CREAM, ORANGE]);
    }
    if (lt < open) popped = false;
    o.save();
    o.translate(rattle, 0);
    lockup(o, CX, OUT_H / 2 - 20, {
      crateY: -(1 - fall) * 900 - bounce,
      ballK: lt >= open ? (lt - open) / 0.5 : 0,
      open: lt >= open ? easeOut((lt - open) / 0.25) : 0,
      titleT: lt - open - 0.08,
      tagT: lt - open - BEAT,
    });
    o.restore();
    drawBits(o, bits, dt);
    const ctaT = lt - open - BEAT * 2;
    if (ctaT > 0) {
      const k = easeOut(ctaT / 0.3);
      o.save();
      o.globalAlpha = k;
      o.translate(CX, OUT_H / 2 + 240 + (1 - k) * 30);
      o.font = "800 48px 'Baloo 2', sans-serif";
      o.textAlign = 'center';
      o.textBaseline = 'middle';
      const cta = 'WISHLIST ON STEAM';
      const w = o.measureText(cta).width + 96;
      o.fillStyle = GOLD;
      o.beginPath();
      o.roundRect(-w / 2, -42, w, 84, 42);
      o.fill();
      o.lineWidth = 5;
      o.strokeStyle = INK;
      o.stroke();
      o.fillStyle = INK;
      o.fillText(cta, 0, 3);
      o.font = '700 38px Nunito, sans-serif';
      o.fillStyle = CREAM;
      o.fillText('playcrateball.com', 0, 88);
      o.restore();
      o.save();
      o.globalAlpha = 0.8 * k;
      o.font = '600 22px Nunito, sans-serif';
      o.textAlign = 'center';
      o.fillStyle = CREAM;
      o.fillText('© 2026 RafiBuilds. Gameplay recorded with bots.', CX, OUT_H - SAFE.y - 30);
      o.fillText(
        'Steam is a trademark and/or registered trademark of Valve Corporation in the U.S. and/or other countries.',
        CX,
        OUT_H - SAFE.y,
      );
      o.restore();
    }
    const endK = (t - (bar(SECTION.end) - 0.5)) / 0.5;
    if (endK > 0) {
      o.fillStyle = `rgba(0,0,0,${Math.min(1, endK)})`;
      o.fillRect(0, 0, OUT_W, OUT_H);
    }
  },
});

export const DURATION = bar(SECTION.end);

/** Transition drawn over the first moments of a segment. */
export function enterFx(o: CanvasRenderingContext2D, s: Segment, lt: number): void {
  // Flash starts at 85%, not pure white, and clears in 0.3 s.
  if (s.enter === 'flash') flash(o, 0.08 + lt / 0.3);
  // A wipe straddles the cut: its first half runs over the end of the previous segment.
  if (s.enter === 'wipe') wipe(o, 0.5 + lt / 0.5);
}
export function exitFx(o: CanvasRenderingContext2D, next: Segment | undefined, untilNext: number): void {
  if (next?.enter === 'wipe' && untilNext < 0.25) wipe(o, 0.5 - untilNext / 0.5);
}
export { vignette };
