import { cloneGame, step, type Game } from '@crateball/sim';

/**
 * Client-side prediction of the WHOLE world (players, ball, bullets, crates).
 *
 * Why: in a host-authoritative game the ball only moves on the client after a round trip, so a kick
 * feels late and the ball jumps. Here the client simulates every tick locally with its own input
 * immediately; other players repeat their last known input. When an authoritative snapshot arrives
 * we roll back to it, drop acknowledged inputs and re-simulate the rest. The visual difference
 * between the old and the new prediction becomes an offset that decays over a few frames, so
 * corrections glide instead of snapping.
 */

export interface Vec {
  x: number;
  y: number;
}

/** A single correction bigger than this is a real teleport (respawn, kickoff reset) and is not smoothed. */
const SNAP_DISTANCE = 80;
/** The visual offset never trails the true position by more than this. */
const MAX_OFFSET = 40;
/** The ball is different: someone else's hard kick reaches us a ping late, by which time the ball is
 * easily 100+ px further on. That must glide, not jump; only the kickoff reset (≥ 400 px) is a teleport. */
const BALL_SNAP_DISTANCE = 250;
const BALL_MAX_OFFSET = 140;
/** Offset decay rates. Others and the ball: ≈ 90 ms half-life, since their corrections come from
 * guessing someone else's input. Own player: small offsets close fast (≈ 50 ms) so control stays
 * tight, but a bump from a collision closes slower (down to ≈ 120 ms) so it reads as a push. */
const SMOOTH_RATE = 7.5;
/** The ball away from us (someone else is playing it): its corrections come from guessing their keys and
 * are often 20-40 px. A slower glide (≈ 200 ms half-life) reads as movement instead of a jerk. Only within
 * touching distance of our own player (radius 15 + ball 10 + kick reach and a margin) does the normal rate
 * apply, so our own touches stay crisp; an opponent dribbling a few metres away still glides. */
const BALL_FAR_RATE = 3.4;
const BALL_NEAR_PX = 45;
const SMOOTH_RATE_ME = 14;
const SMOOTH_RATE_ME_MIN = 5.8;
/** Below this own-player offset (px) the fast rate applies; above it the rate slows in proportion. */
const ME_FAST_UNDER = 3;
/** Never re-simulate more than this many ticks (≈ 1 s) — a hopelessly late client just snaps. */
const MAX_PENDING = 60;

export interface Predictor {
  readonly game: Game | null;
  readonly me: string | null;
  readonly pending: number;
  readonly corrections: number;
  /** Total distance (px) our own player was corrected by — the number that matters for feel. */
  readonly myCorrection: number;
  /** Largest single correction (px) of our player, the ball and anyone else since the last call. */
  takeMaxCorrection(): { me: number; ball: number; others: number };
  setMe(id: string): void;
  /** Back to the lobby: no game until the next snapshot. */
  reset(): void;
  /** One local tick with this input; returns the sequence number to send. */
  tick(bits: number): number | null;
  snapshot(ack: number, g: Game): void;
  /** Interpolated + smoothed render position of a player id or 'ball'. */
  pos(id: string, alpha: number): Vec | null;
  decay(dtSec: number): void;
}

type Positions = Map<string, Vec>;

function positions(g: Game): Positions {
  const m: Positions = new Map([['ball', { x: g.ball.x, y: g.ball.y }]]);
  for (const p of g.players) if (p.dead === 0) m.set(p.id, { x: p.x, y: p.y });
  return m;
}

export function createPredictor(): Predictor {
  let game: Game | null = null;
  let me: string | null = null;
  let seq = 0;
  let pending: Array<[number, number]> = [];
  let prev: Positions = new Map();
  let cur: Positions = new Map();
  const err: Positions = new Map();
  let corrections = 0;
  let myCorrection = 0;
  let maxCorrection = { me: 0, ball: 0, others: 0 };

  const advance = (bits: number) => {
    if (!game) return;
    prev = cur;
    step(game, me ? new Map([[me, bits]]) : undefined);
    cur = positions(game);
  };

  return {
    get game() {
      return game;
    },
    get me() {
      return me;
    },
    get pending() {
      return pending.length;
    },
    get corrections() {
      return corrections;
    },
    get myCorrection() {
      return myCorrection;
    },
    takeMaxCorrection() {
      const m = { ...maxCorrection };
      maxCorrection = { me: 0, ball: 0, others: 0 };
      return m;
    },
    reset() {
      game = null;
      pending = [];
      prev = new Map();
      cur = new Map();
      err.clear();
    },
    setMe(id) {
      me = id;
      pending = [];
    },
    tick(bits) {
      if (!game) return null;
      seq++;
      pending.push([seq, bits]);
      if (pending.length > MAX_PENDING) pending.shift();
      advance(bits);
      return seq;
    },
    snapshot(ack, g) {
      const before = game ? cur : null;
      // The server counted stand-in ticks for us (we were late): continue numbering after them.
      if (ack > seq) seq = ack;
      pending = pending.filter(([s]) => s > ack);
      game = cloneGame(g);
      cur = positions(game);
      prev = cur;
      for (const [, bits] of pending) advance(bits);
      for (const id of err.keys()) if (!cur.has(id)) err.delete(id);
      if (!before) return;
      for (const [id, now] of cur) {
        const old = before.get(id);
        if (!old) continue;
        const dx = old.x - now.x;
        const dy = old.y - now.y;
        const e = err.get(id) ?? { x: 0, y: 0 };
        const snapAt = id === 'ball' ? BALL_SNAP_DISTANCE : SNAP_DISTANCE;
        const maxOffset = id === 'ball' ? BALL_MAX_OFFSET : MAX_OFFSET;
        if (dx * dx + dy * dy > snapAt * snapAt) {
          // A real teleport in this one correction (respawn, kickoff reset): show it as is.
          e.x = e.y = 0;
        } else {
          // Small corrections stack up; cap the total offset instead of dropping it, because
          // dropping it would jump the object by the whole accumulated amount in one frame.
          e.x += dx;
          e.y += dy;
          const len = Math.sqrt(e.x * e.x + e.y * e.y);
          if (len > maxOffset) {
            e.x *= maxOffset / len;
            e.y *= maxOffset / len;
          }
          if (dx * dx + dy * dy > 0.25) corrections++;
          const d = Math.sqrt(dx * dx + dy * dy);
          const who = id === me ? 'me' : id === 'ball' ? 'ball' : 'others';
          maxCorrection[who] = Math.max(maxCorrection[who], d);
          if (id === me) myCorrection += d;
        }
        err.set(id, e);
      }
    },
    pos(id, alpha) {
      const c = cur.get(id);
      if (!c) return null;
      const p = prev.get(id) ?? c;
      const e = err.get(id);
      return {
        x: p.x + (c.x - p.x) * alpha + (e?.x ?? 0),
        y: p.y + (c.y - p.y) * alpha + (e?.y ?? 0),
      };
    },
    decay(dt) {
      const k = Math.exp(-dt * SMOOTH_RATE);
      const mine = me ? cur.get(me) : undefined;
      const ball = cur.get('ball');
      const ballFar =
        !mine || !ball || (mine.x - ball.x) ** 2 + (mine.y - ball.y) ** 2 > BALL_NEAR_PX * BALL_NEAR_PX;
      const kBallFar = Math.exp(-dt * BALL_FAR_RATE);
      for (const [id, e] of err) {
        let f = id === 'ball' && ballFar ? kBallFar : k;
        if (id === me) {
          const len = Math.sqrt(e.x * e.x + e.y * e.y);
          const rate =
            len <= ME_FAST_UNDER
              ? SMOOTH_RATE_ME
              : Math.max(SMOOTH_RATE_ME_MIN, (SMOOTH_RATE_ME * ME_FAST_UNDER) / len);
          f = Math.exp(-dt * rate);
        }
        e.x *= f;
        e.y *= f;
      }
    },
  };
}
