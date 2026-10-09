/**
 * Goal replays. The server keeps the last few seconds of a room in memory; when a goal goes in it cuts a
 * clip from 10-11 s before it (the last key frame at least 10 s back, or the kickoff if later) to the next
 * kickoff (the final whistle for the winning goal). A clip is not a video: it is the
 * game state at its first tick plus what the sim cannot work out by itself (each human's keys, the secret
 * loot draws, and the state again wherever something outside a step changed it, like a player leaving).
 * The client steps the same sim through it and draws it with the game's own renderer; a few state hashes
 * along the way prove it played out as on the server.
 *
 * The same bytes travel over the socket (binary, after the final whistle: one frame with every goal of
 * the match) and sit in a downloaded `.crateball` file: a magic, the protocol version (a replay plays only
 * in the version it was made in), then the bundle as plain data (snap.ts codec).
 */
import { decodeSettings } from './index';
import { Reader, Writer, readValue, writeValue, type Plain } from './snap';
import { PROTOCOL_VERSION } from './version';

/** 'CRBL'. Its first byte also tells a replay frame from a snapshot frame on the socket (kinds 1 and 2). */
export const REPLAY_MAGIC = [0x43, 0x52, 0x42, 0x4c] as const;
/** File and message size limit: a match's worth of goals stays far below it. */
export const REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/** Goals one bundle may hold. */
export const REPLAY_MAX_GOALS = 64;

export interface GoalClip {
  /** Tick the ball crossed the line (the step that ended on it). */
  tick: number;
  /** The side the goal counts for. */
  team: 'red' | 'blue';
  /** Who put it in (for an own goal: the defender), and who set it up; null if nobody is credited. */
  by: string | null;
  assist: string | null;
  ownGoal: boolean;
  /** Seconds played when it went in. */
  second: number;
  arena: string;
  /** First tick (the state below is the game at it, before its step) and last tick of the clip. */
  start: number;
  end: number;
  state: Plain;
  /** Human player ids; `inputs` refers to them by index. */
  ids: string[];
  /** Input changes as triples [tick − start, id index, bits] for the step from that tick; bits −1 means
   * none given that tick (the player's input carries on). Every id starts at −1. */
  inputs: number[];
  /** Loot draws as pairs [tick − start, seed]: the server's secret randomness for that step. */
  loot: number[];
  /** States that replace the game at a tick, before its step: [tick − start, state]. */
  jumps: Array<[number, Plain]>;
  /** State hashes as pairs [tick − start, hash] (stateHash of the state at that tick, before its step). */
  hashes: number[];
}

export interface ReplayBundle {
  /** When the match ended (ms since 1970, server clock). */
  at: number;
  score: [number, number];
  goals: GoalClip[];
}

export type ReplayDecode =
  | { ok: true; bundle: ReplayBundle }
  /** `version`: made with another version of the game; `broken`: not a replay, or damaged. */
  | { ok: false; why: 'version' | 'broken' };

/**
 * A hash of a state as a client holds it: keys in sorted order, so two equal states hash the same however
 * their objects were built. Numbers as JavaScript prints them (the same everywhere).
 */
export function stateHash(v: Plain): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };
  const walk = (x: Plain) => {
    if (x === null) return mix('n');
    switch (typeof x) {
      case 'boolean':
        return mix(x ? 't' : 'f');
      case 'number':
        return mix(`#${x};`);
      case 'string':
        return mix(`"${x.length}:${x}`);
    }
    if (Array.isArray(x)) {
      mix(`[${x.length}`);
      for (const y of x) walk(y);
      return;
    }
    const keys = Object.keys(x).sort();
    mix(`{${keys.length}`);
    for (const k of keys) {
      mix(`${k.length}:${k}`);
      walk(x[k]!);
    }
  };
  walk(v);
  return h >>> 0;
}

export function encodeReplays(b: ReplayBundle): Uint8Array {
  const w = new Writer();
  for (const c of REPLAY_MAGIC) w.u8(c);
  w.uint(PROTOCOL_VERSION);
  writeValue(w, b as unknown as Plain);
  return w.bytes();
}

/** True if these bytes are a replay (the start of one, at least), not a snapshot frame. */
export const isReplay = (bytes: Uint8Array): boolean =>
  bytes.length >= REPLAY_MAGIC.length && REPLAY_MAGIC.every((c, i) => bytes[i] === c);

const isObj = (v: unknown): v is Record<string, Plain> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isInts = (v: unknown, group: number): v is number[] =>
  Array.isArray(v) && v.length % group === 0 && v.every((n) => typeof n === 'number' && Number.isInteger(n));
const nameOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && v.length <= 32);
const upTo = (v: unknown, n: number): boolean => Array.isArray(v) && v.length <= n;
/** Values in a state at most: a real one has under 1,000 (6 players on a lava pitch); this keeps every
 * step of a crafted one cheap however its values are spread over players, crates, puddles or lava. */
export const REPLAY_MAX_VALUES = 10_000;
function small(v: Plain): boolean {
  let left = REPLAY_MAX_VALUES;
  const stack: Plain[] = [v];
  while (stack.length) {
    if (--left < 0) return false;
    const x = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    const inner = Array.isArray(x) ? x : Object.values(x);
    if (inner.length > left) return false;
    stack.push(...inner);
  }
  return true;
}
const ARENA_KINDS: readonly string[] = ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'];
/**
 * Enough of a game state for the sim to step it. The sim trusts its own state, so what bounds its work is
 * checked here: settings a room could really have (a score limit of Infinity would make the arena plan
 * endless) and a plan of known arenas. A damaged file is then caught by the hashes; a crafted one only
 * plays wrong.
 */
const isState = (v: unknown): boolean =>
  isObj(v) &&
  decodeSettings(v.settings) !== null &&
  Array.isArray(v.arenaPlan) &&
  v.arenaPlan.length > 0 &&
  v.arenaPlan.length <= 64 &&
  v.arenaPlan.every((k) => typeof k === 'string' && ARENA_KINDS.includes(k)) &&
  upTo(v.players, 12) &&
  isUint(v.tick) &&
  isObj(v.ball) &&
  Array.isArray(v.crates) &&
  Array.isArray(v.bullets) &&
  Array.isArray(v.blasts) &&
  Array.isArray(v.score) &&
  isObj(v.arena) &&
  small(v) &&
  isObj(v.scoring);

function isClip(c: unknown): c is GoalClip {
  if (!isObj(c)) return false;
  return (
    isUint(c.tick) &&
    (c.team === 'red' || c.team === 'blue') &&
    nameOrNull(c.by) &&
    nameOrNull(c.assist) &&
    typeof c.ownGoal === 'boolean' &&
    isUint(c.second) &&
    typeof c.arena === 'string' &&
    isUint(c.start) &&
    isUint(c.end) &&
    c.start <= c.tick &&
    c.tick < c.end &&
    c.end - c.start <= 60 * 60 &&
    isState(c.state) &&
    (c.state as { tick: number }).tick === c.start &&
    Array.isArray(c.ids) &&
    c.ids.length <= 12 &&
    c.ids.every((id) => typeof id === 'string') &&
    isInts(c.inputs, 3) &&
    isInts(c.loot, 2) &&
    Array.isArray(c.jumps) &&
    c.jumps.length <= 32 &&
    c.jumps.every((j) => Array.isArray(j) && j.length === 2 && isUint(j[0]) && isState(j[1])) &&
    isInts(c.hashes, 2) &&
    c.hashes.length >= 2
  );
}

export function decodeReplays(bytes: Uint8Array): ReplayDecode {
  if (!isReplay(bytes) || bytes.length > REPLAY_MAX_BYTES) return { ok: false, why: 'broken' };
  try {
    const r = new Reader(bytes);
    r.pos = REPLAY_MAGIC.length;
    if (r.uint() !== PROTOCOL_VERSION) return { ok: false, why: 'version' };
    const v = readValue(r);
    if (!r.done) return { ok: false, why: 'broken' };
    if (
      !isObj(v) ||
      typeof v.at !== 'number' ||
      !Array.isArray(v.score) ||
      v.score.length !== 2 ||
      !v.score.every(isUint) ||
      !Array.isArray(v.goals) ||
      v.goals.length === 0 ||
      v.goals.length > REPLAY_MAX_GOALS ||
      !v.goals.every(isClip)
    )
      return { ok: false, why: 'broken' };
    return { ok: true, bundle: v as unknown as ReplayBundle };
  } catch {
    return { ok: false, why: 'broken' };
  }
}
