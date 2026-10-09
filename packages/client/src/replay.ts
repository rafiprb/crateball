/**
 * Plays a goal clip (protocol replay.ts) with the real sim: from the clip's first state, each human's
 * keys, the server's loot draws and the odd jump (a player who left) step it exactly as the server did.
 * `verify` runs it once headless and checks the server's state hashes on the way; playback then steps
 * it again, frame by frame, keeping checkpoints so the progress bar can seek.
 */
import { snapState, stateHash, type GoalClip, type Plain } from '@crateball/protocol';
import { cloneGame, step, type Game } from '@crateball/sim';
import type { Predictor } from './predict';

/** A checkpoint every this many ticks (seeking re-steps from the one before). */
const CHECK_EVERY = 60;

interface Compiled {
  inputs: Map<number, Array<[string, number]>>;
  loot: Map<number, number>;
  jumps: Map<number, Plain>;
  hashes: Map<number, number>;
}

function compile(c: GoalClip): Compiled {
  const inputs = new Map<number, Array<[string, number]>>();
  for (let i = 0; i < c.inputs.length; i += 3) {
    const t = c.inputs[i]!;
    const id = c.ids[c.inputs[i + 1]!];
    if (id === undefined) continue;
    const at = inputs.get(t) ?? [];
    at.push([id, c.inputs[i + 2]!]);
    inputs.set(t, at);
  }
  const loot = new Map<number, number>();
  for (let i = 0; i < c.loot.length; i += 2) loot.set(c.loot[i]!, c.loot[i + 1]!);
  const hashes = new Map<number, number>();
  for (let i = 0; i < c.hashes.length; i += 2) hashes.set(c.hashes[i]!, c.hashes[i + 1]!);
  return { inputs, loot, jumps: new Map(c.jumps), hashes };
}

/** −1: no input given that tick (the player's carries on). */
const setInput = (given: Map<string, number>, id: string, bits: number) => {
  if (bits < 0) given.delete(id);
  else given.set(id, bits);
};

const fromPlain = (s: Plain): Game => structuredClone(s) as unknown as Game;
const hashOf = (g: Game) => stateHash(snapState(g));

export interface ClipRun {
  readonly clip: GoalClip;
  /** Ticks in the clip; the goal is at `goalAt`. */
  readonly length: number;
  readonly goalAt: number;
  /** Ticks played so far (0 … length). */
  readonly at: number;
  readonly game: Game;
  /** The state a tick before (for interpolation). */
  readonly prev: Game;
  /** One tick; false at the end. */
  advance(): boolean;
  /** Back to tick `t` of the clip (0 … length). */
  seek(t: number): void;
  /** The renderer's view of it. */
  readonly pred: Predictor;
}

interface Check {
  at: number;
  game: Game;
  given: Map<string, number>;
}

/** Steps a clip, checking hashes as they come; returns where it went wrong (or null) and checkpoints. */
function runAll(clip: GoalClip, c: Compiled): { ok: boolean; checks: Check[] } {
  const length = clip.end - clip.start;
  let g = fromPlain(clip.state);
  const given = new Map<string, number>();
  const checks: Check[] = [];
  for (let t = 0; ; t++) {
    const jump = c.jumps.get(t);
    if (jump) g = fromPlain(jump);
    const want = c.hashes.get(t);
    if (want !== undefined && hashOf(g) !== want) return { ok: false, checks };
    if (t >= length) break;
    for (const [id, bits] of c.inputs.get(t) ?? []) setInput(given, id, bits);
    if (t % CHECK_EVERY === 0) checks.push({ at: t, game: cloneGame(g), given: new Map(given) });
    g.lootRng = c.loot.get(t) ?? 0;
    step(g, given);
  }
  return { ok: true, checks };
}

/** Plays the clip through once and compares it with the server's hashes. */
export function verifyClip(clip: GoalClip): boolean {
  try {
    return runAll(clip, compile(clip)).ok;
  } catch {
    return false;
  }
}

/** A verified run of the clip, ready to draw; null if it does not play out as on the server. */
export function playClip(clip: GoalClip): ClipRun | null {
  const c = compile(clip);
  let checks: Check[];
  try {
    const r = runAll(clip, c);
    if (!r.ok || r.checks.length === 0) return null;
    checks = r.checks;
  } catch {
    return null;
  }
  const length = clip.end - clip.start;
  let at = 0;
  let game = cloneGame(checks[0]!.game);
  let prev = game;
  let given = new Map(checks[0]!.given);

  /** The step from tick `at` (its inputs were applied when `at` was reached). */
  const stepOnce = () => {
    game.lootRng = c.loot.get(at) ?? 0;
    step(game, given);
    at++;
    const jump = c.jumps.get(at);
    if (jump) game = fromPlain(jump);
    if (at < length) for (const [id, bits] of c.inputs.get(at) ?? []) setInput(given, id, bits);
  };

  const seek = (t: number) => {
    t = Math.max(0, Math.min(length, Math.round(t)));
    const from = checks.findLast((k) => k.at <= t) ?? checks[0]!;
    game = cloneGame(from.game);
    given = new Map(from.given);
    at = from.at;
    while (at < t) stepOnce();
    prev = game;
  };

  const posIn = (g: Game, id: string) => {
    if (id === 'ball') return { x: g.ball.x, y: g.ball.y };
    const p = g.players.find((o) => o.id === id && o.dead === 0);
    return p ? { x: p.x, y: p.y } : null;
  };

  const pred: Predictor = {
    get game() {
      return game;
    },
    me: null,
    pending: 0,
    corrections: 0,
    myCorrection: 0,
    takeMaxCorrection: () => ({ me: 0, ball: 0, others: 0 }),
    setMe() {},
    reset() {},
    tick: () => null,
    snapshot() {},
    remoteInput() {},
    pos(id, alpha) {
      const b = posIn(game, id);
      const a = posIn(prev, id);
      if (!b) return null;
      // Teleports, respawns and the kickoff reset jump instead of sliding across the pitch.
      if (!a || Math.abs(a.x - b.x) > 60 || Math.abs(a.y - b.y) > 60) return b;
      return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha };
    },
    decay() {},
  };

  return {
    clip,
    length,
    goalAt: clip.tick - clip.start,
    get at() {
      return at;
    },
    get game() {
      return game;
    },
    get prev() {
      return prev;
    },
    advance() {
      if (at >= length) return false;
      prev = cloneGame(game);
      stepOnce();
      return true;
    },
    seek,
    pred,
  };
}
