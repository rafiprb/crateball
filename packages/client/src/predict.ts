import { cloneGame, step, type Game } from '@crateball/sim';

/**
 * Client-side prediction of the WHOLE world (players, ball, bullets, crates).
 *
 * Why: in a host-authoritative game the ball only moves on the client after a round trip, so a kick
 * feels late and the ball jumps. Here the client simulates every tick locally with its own input
 * immediately; other players repeat their last known input. When an authoritative snapshot arrives
 * we roll back to it, drop acknowledged inputs and re-simulate the rest. The server also relays every
 * other player's change of keys the moment it gets it, with the tick it will apply it at: one still in
 * our future is simply played when we get there; one in our already-predicted past rolls back to the
 * last snapshot and re-simulates at once, instead of waiting up to a snapshot interval. The visual
 * difference between the old and the new prediction becomes an offset that decays over a few frames,
 * so corrections glide instead of snapping.
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
  /** Relayed input: player `id` presses `bits` in the step from tick `k` on. */
  remoteInput(id: string, k: number, bits: number): void;
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
  /** The last snapshot, kept to roll back to when a relayed input lands in our predicted past. */
  let base: Game | null = null;
  /** Relayed key changes of other players, per id, in tick order: [tick, bits]; a new one replaces those
   * at or after its tick (the server re-times or cancels changes that way). The first entry is the one in
   * effect at `base.tick`: it is played every tick, because the snapshot's `input` can be wrong for the
   * next step (a kickoff zeroes it while the key is still held). */
  const remote = new Map<string, Array<[number, number]>>();
  /** A relayed change landed in our predicted past: re-simulate before the next use (once per frame,
   * however many arrived). */
  let stale = false;
  let me: string | null = null;
  let seq = 0;
  let pending: Array<[number, number]> = [];
  let prev: Positions = new Map();
  let cur: Positions = new Map();
  const err: Positions = new Map();
  /** Interpolation point of the last drawn frame (0..1 between the previous and current tick). */
  let drawnAlpha = 1;
  let corrections = 0;
  let myCorrection = 0;
  let maxCorrection = { me: 0, ball: 0, others: 0 };

  const advance = (bits: number) => {
    if (!game) return;
    prev = cur;
    const inputs = new Map<string, number>();
    for (const [id, changes] of remote) {
      // The newest relayed change at or before this tick (the list is short: a few per second).
      let b: number | undefined;
      for (const [k, v] of changes) if (k <= game.tick) b = v;
      if (b !== undefined) inputs.set(id, b);
    }
    if (me) inputs.set(me, bits);
    step(game, inputs);
    cur = positions(game);
  };

  /** Back to `base`, replay our pending inputs, and turn the change in what we show into offsets. */
  const rebuild = () => {
    if (!base) return;
    const before = game ? cur : null;
    const beforePrev = prev;
    game = cloneGame(base);
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
      // The offset keeps what is drawn right now in place: compare the two predictions where the last
      // frame drew them, between their previous and current tick. Comparing whole ticks only would move
      // the drawn ball by up to a tick's worth of a velocity change (a kick) at once.
      const oldPrev = beforePrev.get(id) ?? old;
      const nowPrev = prev.get(id) ?? now;
      const ox = dx + (1 - drawnAlpha) * (oldPrev.x - old.x - (nowPrev.x - now.x));
      const oy = dy + (1 - drawnAlpha) * (oldPrev.y - old.y - (nowPrev.y - now.y));
      const e = err.get(id) ?? { x: 0, y: 0 };
      const snapAt = id === 'ball' ? BALL_SNAP_DISTANCE : SNAP_DISTANCE;
      const maxOffset = id === 'ball' ? BALL_MAX_OFFSET : MAX_OFFSET;
      if (dx * dx + dy * dy > snapAt * snapAt) {
        // A real teleport in this one correction (respawn, kickoff reset): show it as is.
        e.x = e.y = 0;
      } else {
        // Small corrections stack up; cap the total offset instead of dropping it, because
        // dropping it would jump the object by the whole accumulated amount in one frame.
        e.x += ox;
        e.y += oy;
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
  };

  const flush = () => {
    if (!stale) return;
    stale = false;
    rebuild();
  };

  return {
    get game() {
      flush();
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
      base = null;
      remote.clear();
      stale = false;
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
      flush();
      if (!game) return null;
      seq++;
      pending.push([seq, bits]);
      if (pending.length > MAX_PENDING) pending.shift();
      advance(bits);
      return seq;
    },
    snapshot(ack, g) {
      // The server counted stand-in ticks for us (we were late): continue numbering after them.
      if (ack > seq) seq = ack;
      pending = pending.filter(([s]) => s > ack);
      base = cloneGame(g);
      for (const [id, changes] of remote) {
        // Older changes are history, except the newest of them: the one still in effect.
        if (!g.players.some((p) => p.id === id)) remote.delete(id);
        else while (changes.length > 1 && changes[1]![0] <= g.tick) changes.shift();
      }
      stale = false;
      rebuild();
    },
    remoteInput(id, k, bits) {
      if (!base || !game || id === me) return;
      const changes = remote.get(id) ?? [];
      // Arrives in order from one server; it replaces whatever was announced from its tick on.
      while (changes.length > 0 && changes[changes.length - 1]![0] >= k) changes.pop();
      changes.push([k, bits]);
      remote.set(id, changes);
      // Still ahead of our prediction: it is played when we get there. Already behind: re-simulate.
      if (k < game.tick) stale = true;
    },
    pos(id, alpha) {
      flush();
      drawnAlpha = alpha;
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
      flush();
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
