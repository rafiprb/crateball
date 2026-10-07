// The trailer, beat by beat. Times are in bars/beats of the soundtrack (music.ts), so every cut and
// every word lands on the music. Shots are real bot matches replayed from a seed (found with scan()).
import type { MatchSpec } from './match';
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
  backdrop,
  burst,
  drawBits,
  easeIn,
  easeOut,
  flash,
  logoMark,
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
  /** Ticks per frame (0.35 = slow motion). */
  speed?: number;
  /** Camera zoom at the start and the end of the shot. */
  zoom?: [number, number];
  /** Follow the ball; otherwise the camera stays on the centre spot. */
  follow?: boolean;
}

export interface Segment {
  t0: number;
  t1: number;
  shot?: Shot;
  /** Draws over the shot; `lt` = seconds since the segment started. */
  over?: (o: CanvasRenderingContext2D, lt: number, t: number, dt: number) => void;
  /** How the segment comes in. */
  enter?: 'cut' | 'wipe' | 'flash';
  /** Zoom kick on every beat (drops). */
  pulse?: boolean;
}

const bar = (b: number, beat = 0) => b * BAR + beat * BEAT;
const CX = OUT_W / 2;

const S = {
  classic: (seed: number): MatchSpec => ({ seed, arena: 'classic' }),
  chaos: (seed: number, items: MatchSpec['items']): MatchSpec => ({
    seed,
    arena: 'classic',
    items,
    chaos: true,
  }),
};

export const SEGMENTS: Segment[] = [];
const add = (s: Segment) => SEGMENTS.push(s);

// ── Intro ─────────────────────────────────────────────────────────────────────────────────────
add({
  t0: bar(0),
  t1: bar(1),
  over(o, lt, t) {
    backdrop(o, t);
    slam(o, '3', CX - 330, OUT_H / 2 - 30, lt, { size: 330, color: RED, rot: -0.06 });
    slam(o, 'VS', CX, OUT_H / 2 - 10, lt - BEAT, { size: 170, color: CREAM });
    slam(o, '3', CX + 330, OUT_H / 2 - 30, lt - 2 * BEAT, { size: 330, color: BLUE, rot: 0.06 });
    slam(o, 'ARCADE FOOTBALL', CX, OUT_H / 2 + 200, lt - 3 * BEAT, { size: 80, color: ORANGE, from: 1.3 });
  },
});
add({
  t0: bar(1),
  t1: bar(2),
  enter: 'flash',
  shot: { spec: S.classic(6), from: 300, zoom: [1.12, 1.3] },
  over(o, lt) {
    const words = ['MOVE.', 'KICK.', 'SCORE.'];
    words.forEach((w, i) =>
      slam(o, w, 150 + i * 330, OUT_H - 130, lt - i * BEAT, { size: 96, align: 'left', from: 1.5 }),
    );
  },
});
add({
  t0: bar(2),
  t1: bar(3),
  enter: 'wipe',
  shot: { spec: S.classic(4), from: 360, zoom: [1.7, 2.1], follow: true },
  over(o, lt) {
    slam(o, 'BUT...', CX, 200, lt, { size: 110, from: 1.4, life: BEAT * 2 });
    slam(o, 'THERE ARE CRATES', CX, 200, lt - BEAT * 2, { size: 120, color: GOLD });
  },
});
// Four one-beat flashes of what comes out of them, under a growing question.
const teasers: Shot[] = [
  { spec: S.chaos(1, ['ice', 'mine']), from: 381 - 16, zoom: [2.2, 2.4], follow: true },
  { spec: S.chaos(1, ['teleport', 'power']), from: 381 - 16, zoom: [2.2, 2.4], follow: true },
  { spec: S.chaos(1, ['bazooka']), from: 388 - 20, zoom: [2, 2.3], follow: true },
  { spec: S.chaos(4, ['ice', 'mine']), from: 1512 - 18, zoom: [2, 2.3], follow: true },
];
teasers.forEach((shot, i) =>
  add({
    t0: bar(3, i),
    t1: bar(3, i + 1),
    enter: 'flash',
    shot,
    over(o, lt) {
      slam(o, "WHAT'S INSIDE?", CX, OUT_H / 2, lt + i * BEAT, {
        size: 120 + i * 30,
        from: i === 0 ? 1.6 : 1.04,
      });
    },
  }),
);

// ── Drop 1: one shot per bar, each with its label ────────────────────────────────────────────────
const drop1: Array<[Shot, string, string, string]> = [
  [
    { spec: S.chaos(1, ['bazooka']), from: 850, zoom: [1.5, 1.7], follow: true },
    'BAZOOKAS',
    'CRATE LOOT',
    ORANGE,
  ],
  [
    { spec: S.chaos(4, ['ice', 'mine']), from: 1452, zoom: [1.6, 1.8], follow: true },
    'MINES',
    'CRATE LOOT',
    RED,
  ],
  [
    { spec: S.chaos(2, ['ice', 'mine']), from: 425, zoom: [1.6, 1.8], follow: true },
    'FREEZE',
    'CRATE LOOT',
    '#9BE3FF',
  ],
  [
    { spec: S.chaos(2, ['teleport', 'power']), from: 1628, zoom: [1.5, 1.7], follow: true },
    'TELEPORTS',
    'CRATE LOOT',
    '#C77DFF',
  ],
  [
    { spec: { seed: 1, arena: 'volcano' }, from: 1385, zoom: [1.3, 1.5], follow: true },
    'VOLCANO',
    'ARENA',
    '#FF6A3D',
  ],
  [
    { spec: { seed: 3, arena: 'rain' }, from: 745, zoom: [1.3, 1.5], follow: true },
    'RAIN',
    'ARENA',
    '#7FB6FF',
  ],
  [
    { spec: { seed: 6, arena: 'wind' }, from: 1680, zoom: [1.3, 1.5], follow: true },
    'WIND',
    'ARENA',
    '#CFE8D8',
  ],
  [
    { spec: { seed: 4, arena: 'ice' }, from: 2140, zoom: [1.3, 1.5], follow: true },
    'ICE RINK',
    'ARENA',
    '#D3EAF5',
  ],
];
drop1.forEach(([shot, label, small, color], i) =>
  add({
    t0: bar(SECTION.drop + i),
    t1: bar(SECTION.drop + i + 1),
    enter: i === 0 ? 'flash' : 'wipe',
    pulse: true,
    shot,
    over(o, lt) {
      tag(o, label, 130, OUT_H - 150, lt - 0.05, { size: 120, bg: color, small, fromRight: i % 2 === 1 });
    },
  }),
);

// ── Break: a goal in slow motion, then how you play ─────────────────────────────────────────────
add({
  t0: bar(SECTION.brk),
  t1: bar(SECTION.drop2),
  enter: 'flash',
  shot: { spec: S.classic(6), from: 3418, speed: 0.4, zoom: [1.9, 2.4], follow: true },
  over(o, lt) {
    o.fillStyle = `rgba(9,13,34,${0.2 + 0.35 * easeOut(lt / BAR)})`;
    o.fillRect(0, 0, OUT_W, OUT_H);
    const lines: Array<[string, string]> = [
      ['CREATE A ROOM', CREAM],
      ['SHARE THE LINK', CREAM],
      ['PLAY WITH FRIENDS', GOLD],
    ];
    lines.forEach(([s, c], i) =>
      slam(o, s, 150, 330 + i * 170, lt - i * BEAT * 2.5, { size: 120, color: c, align: 'left', from: 1.3 }),
    );
  },
});

// ── Drop 2: half-bar cuts ───────────────────────────────────────────────────────────────────────
const drop2: Shot[] = [
  { spec: S.chaos(1, ['gun']), from: 1405, zoom: [1.6, 1.8], follow: true },
  { spec: S.chaos(2, ['bazooka']), from: 1812, zoom: [1.7, 1.9], follow: true },
  { spec: { seed: 2, arena: 'volcano' }, from: 1212, zoom: [1.5, 1.7], follow: true },
  { spec: S.chaos(1, ['ice', 'mine']), from: 378, zoom: [1.5, 1.7], follow: true },
  { spec: S.chaos(5, ['bazooka']), from: 1768, zoom: [1.6, 1.8], follow: true },
  { spec: S.chaos(3, ['teleport', 'power']), from: 2084, zoom: [1.5, 1.7], follow: true },
  { spec: { seed: 3, arena: 'wind' }, from: 1680, zoom: [1.5, 1.7], follow: true },
  { spec: S.classic(2), from: 3632, zoom: [1.6, 1.9], follow: true },
];
drop2.forEach((shot, i) =>
  add({
    t0: bar(SECTION.drop2, i * 2),
    t1: bar(SECTION.drop2, i * 2 + 2),
    enter: i === 0 ? 'flash' : 'cut',
    pulse: true,
    shot,
    over(o, lt, t) {
      const st = t - bar(SECTION.drop2);
      if (st < BAR * 2) {
        slam(o, 'FREE', CX, OUT_H - 250, st, { size: 150, color: GOLD, from: 1.6 });
        slam(o, 'IN YOUR BROWSER', CX, OUT_H - 120, st - BEAT * 2, { size: 100, from: 1.4 });
      } else {
        slam(o, 'AND ON STEAM', CX, OUT_H - 160, st - BAR * 2, { size: 140, color: CREAM, from: 1.5 });
      }
      void lt;
    },
  }),
);

// ── Outro: the logo ─────────────────────────────────────────────────────────────────────────────
const bits: Bit[] = [];
let popped = 0;
add({
  t0: bar(SECTION.outro),
  t1: bar(SECTION.end),
  enter: 'flash',
  over(o, lt, t, dt) {
    backdrop(o, t, 1.6);
    const land = BAR; // the crate lands on the first hit, opens on the second
    const fall = easeIn(lt / (BEAT * 0.9));
    const bounce =
      lt > BEAT * 0.9 ? Math.abs(Math.sin((lt - BEAT * 0.9) * 9)) * 18 * Math.exp(-(lt - BEAT * 0.9) * 5) : 0;
    const crateY = -(1 - fall) * 900 - bounce;
    const open = easeOut((lt - land) / 0.25);
    const ballK = (lt - land) / 0.55;
    if (lt >= land && popped < 1) {
      popped = 1;
      burst(bits, CX - 120, OUT_H / 2 - 130, 160, 1500, [RED, BLUE, GOLD, CREAM, ORANGE]);
    }
    // Before it opens the crate rattles harder and harder.
    const rattle =
      lt < land ? Math.sin(lt * 70) * 7 * Math.max(0, (lt - BEAT * 1.5) / (land - BEAT * 1.5)) : 0;
    logoMark(
      o,
      CX + rattle,
      OUT_H / 2 - 130,
      420,
      crateY / (420 / 64),
      lt >= land ? ballK : 0,
      lt >= land ? open : 0,
    );
    drawBits(o, bits, dt);
    slam(o, 'CRATEBALL', CX, OUT_H / 2 + 170, lt - land - 0.1, { size: 190, color: GOLD, from: 2.2 });
    slam(o, '3v3 arcade football', CX, OUT_H / 2 + 290, lt - land - BEAT * 2, {
      size: 56,
      from: 1.2,
      font: '800 56px Nunito, sans-serif',
    });
    if (lt > land + BAR) {
      const k = easeOut((lt - land - BAR) / 0.3);
      o.save();
      o.globalAlpha = k;
      o.translate(CX, OUT_H - 110 + (1 - k) * 40);
      o.font = '800 44px Nunito, sans-serif';
      o.textAlign = 'center';
      o.textBaseline = 'middle';
      const label = 'WISHLIST ON STEAM   ·   playcrateball.com';
      const w = o.measureText(label).width + 80;
      o.fillStyle = INK;
      o.beginPath();
      o.roundRect(-w / 2, -42, w, 84, 42);
      o.fill();
      o.fillStyle = CREAM;
      o.fillText(label, 0, 2);
      o.restore();
    }
    // fade to black at the very end
    const endK = (t - (bar(SECTION.end) - 0.6)) / 0.6;
    if (endK > 0) {
      o.fillStyle = `rgba(0,0,0,${Math.min(1, endK)})`;
      o.fillRect(0, 0, OUT_W, OUT_H);
    }
  },
});

export const DURATION = bar(SECTION.end);

/** Transition drawn over the first moments of a segment. */
export function enterFx(o: CanvasRenderingContext2D, s: Segment, lt: number): void {
  if (s.enter === 'flash') flash(o, lt / 0.3);
  // A wipe straddles the cut: its first half runs over the end of the previous segment (see main.ts).
  if (s.enter === 'wipe') wipe(o, 0.5 + lt / 0.5);
}
export function exitFx(o: CanvasRenderingContext2D, next: Segment | undefined, untilNext: number): void {
  if (next?.enter === 'wipe' && untilNext < 0.25) wipe(o, 0.5 - untilNext / 0.5);
}
export { vignette };
