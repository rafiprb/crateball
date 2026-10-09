/**
 * Goal replays (protocol replay.ts): per room, the last seconds of play in memory, cut into a clip when a
 * goal goes in, and handed out once at the final whistle. Nothing is written anywhere: the room forgets
 * it all when the next match starts or the room closes.
 *
 * Memory per room: a key frame (the state, as plain data) every second for the last ~11 s, the key changes
 * and loot draws since the oldest of them, and the finished clips of the match (a few KB each).
 */
import {
  REPLAY_MAX_GOALS,
  encodeReplays,
  snapState,
  stateHash,
  type GoalClip,
  type Plain,
} from '@crateball/protocol';
import { TICK_HZ, type Game, type Team } from '@crateball/sim';

/** A clip starts this long before the goal (or at the kickoff, if that came later). */
export const CLIP_BEFORE = 10 * TICK_HZ;
/** Key frames this far apart: a clip starts on one, up to this much before CLIP_BEFORE. */
export const KEY_EVERY = TICK_HZ;

interface Key {
  tick: number;
  state: Plain;
  /** Taken because something outside a step changed the game: a replay must jump to it. */
  jump: boolean;
  /** Each human's input as given for the step from this tick on (−1: none given), before this tick's. */
  held: Map<string, number>;
}

interface Pending {
  key: Key;
  tick: number;
  team: Team;
  by: string | null;
  assist: string | null;
  ownGoal: boolean;
  second: number;
  arena: string;
}

/** Per player (and per player who left): goals, own goals, assists. */
type Counts = Map<string, { name: string; goals: number; own: number; assists: number }>;

export interface Recorder {
  /** Just before a step, with the inputs it will be given. */
  before(g: Game, inputs: ReadonlyMap<string, number>): void;
  /** Just after it; `lootSeed`: the secret loot randomness the step was given. */
  after(g: Game, lootSeed: number): void;
  /** The game was changed outside a step (a player left or dropped): the next step starts a key frame
   * that replays jump to. */
  touched(): void;
  /** The goals of the match so far, encoded (null if none). `at`: the time to stamp them with. */
  bundle(g: Game, at: number): Uint8Array | null;
  /** A new match: forget everything. */
  reset(): void;
}

function counts(g: Game): Counts {
  const out: Counts = new Map();
  for (const p of [...g.scoring.gone, ...g.players])
    out.set(p.id, { name: p.name, goals: p.goals, own: p.stats.ownGoals, assists: p.stats.assists });
  return out;
}

export function createRecorder(): Recorder {
  let keys: Key[] = [];
  let inputs: Array<[tick: number, id: string, bits: number]> = [];
  let loot: Array<[tick: number, seed: number]> = [];
  /** Inputs as last given (−1: none), per human id. */
  let held = new Map<string, number>();
  let clips: GoalClip[] = [];
  let pending: Pending | null = null;
  let kickoffAt = 0;
  let dirty = false;
  let before: { score: [number, number]; counts: Counts } | null = null;

  const reset = () => {
    keys = [];
    inputs = [];
    loot = [];
    held = new Map();
    clips = [];
    pending = null;
    kickoffAt = 0;
    dirty = false;
    before = null;
  };

  /** The clip from `p`'s key frame to tick `end` (the state of the game now). */
  const cut = (p: Pending, g: Game): GoalClip => {
    const start = p.key.tick;
    const end = g.tick;
    const ids = [...new Set([...p.key.held.keys(), ...inputs.map(([, id]) => id)])];
    const index = new Map(ids.map((id, i) => [id, i]));
    const flat: number[] = [];
    for (const [id, bits] of p.key.held) if (bits !== -1) flat.push(0, index.get(id)!, bits);
    for (const [t, id, bits] of inputs) if (t >= start && t < end) flat.push(t - start, index.get(id)!, bits);
    const hashes: number[] = [];
    const jumps: Array<[number, Plain]> = [];
    for (const k of keys) {
      if (k.tick <= start || k.tick >= end) continue;
      if (k.jump) jumps.push([k.tick - start, k.state]);
      hashes.push(k.tick - start, stateHash(k.state));
    }
    hashes.push(end - start, stateHash(snapState(g)));
    return {
      tick: p.tick,
      team: p.team,
      by: p.by,
      assist: p.assist,
      ownGoal: p.ownGoal,
      second: p.second,
      arena: p.arena,
      start,
      end,
      state: p.key.state,
      ids,
      inputs: flat,
      loot: loot.filter(([t]) => t >= start && t < end).flatMap(([t, seed]) => [t - start, seed]),
      jumps,
      hashes,
    };
  };

  return {
    reset,
    touched() {
      dirty = true;
    },
    before(g, given) {
      const kickoff = g.phase === 'kickoff' && g.phaseT === 0;
      if (kickoff) kickoffAt = g.tick;
      if (dirty || kickoff || g.tick % KEY_EVERY === 0)
        keys.push({ tick: g.tick, state: snapState(g), jump: dirty, held: new Map(held) });
      dirty = false;
      for (const p of g.players) {
        if (p.bot) continue; // bots decide inside the step
        const bits = given.get(p.id) ?? -1;
        if (held.get(p.id) === bits || (!held.has(p.id) && bits === -1)) continue;
        held.set(p.id, bits);
        inputs.push([g.tick, p.id, bits]);
      }
      before = g.phase === 'play' ? { score: [g.score[0], g.score[1]], counts: counts(g) } : null;
    },
    after(g, lootSeed) {
      if (g.lootRng !== lootSeed) loot.push([g.tick - 1, lootSeed]);
      if (pending && g.phase !== 'goal') {
        if (clips.length < REPLAY_MAX_GOALS) clips.push(cut(pending, g));
        pending = null;
      }
      if (before && (g.score[0] !== before.score[0] || g.score[1] !== before.score[1])) {
        const team: Team = g.score[0] !== before.score[0] ? 'red' : 'blue';
        const now = counts(g);
        const grew = (k: 'goals' | 'own' | 'assists') => {
          for (const [id, c] of now) if (c[k] > (before!.counts.get(id)?.[k] ?? 0)) return c.name;
          return null;
        };
        const scorer = grew('goals');
        const own = scorer ? null : grew('own');
        const from = Math.max(g.tick - CLIP_BEFORE, kickoffAt);
        const key = keys.findLast((k) => k.tick <= from) ?? keys[0];
        const played = g.settings.minutes > 0 ? g.settings.minutes * 60 * TICK_HZ - g.clock : g.clock;
        if (key)
          pending = {
            key,
            tick: g.tick,
            team,
            by: scorer ?? own,
            assist: scorer ? grew('assists') : null,
            ownGoal: own !== null,
            second: Math.max(0, Math.floor(played / TICK_HZ)),
            arena: g.arena.kind,
          };
      }
      // Keep what a clip starting at the oldest needed key frame uses.
      const need = pending ? pending.key.tick : g.tick - CLIP_BEFORE;
      while (keys.length > 1 && keys[1]!.tick <= need) keys.shift();
      const oldest = keys[0]?.tick ?? g.tick;
      while (inputs.length && inputs[0]![0] < oldest) inputs.shift();
      while (loot.length && loot[0]![0] < oldest) loot.shift();
    },
    bundle(g, at) {
      if (clips.length === 0) return null;
      return encodeReplays({ at, score: [g.score[0], g.score[1]], goals: clips });
    },
  };
}
