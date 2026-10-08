import type { ArenaKind, Game, ItemKind, Role, Settings, Team } from '@crateball/sim';
import { STATE_SCALE, decodeFrame, type DecodedSnap, type SnapDecoder } from './snap';

export * from './snap';

export const PROTOCOL_VERSION = 15;
/** A seat in the room: a team, or watching. */
export type Seat = Team | 'spec';
/** 4 letters, no look-alikes (I/O). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type ClientMessage =
  | { t: 'hello'; protocolVersion: number; sessionToken?: string }
  | { t: 'ping'; id: number }
  | { t: 'create'; name: string; roomName: string; public: boolean; settings: Settings }
  | { t: 'join'; code: string; name: string }
  | { t: 'leave' }
  | { t: 'settings'; settings: Settings }
  /** Host: rename the room or make it public/private. */
  | { t: 'meta'; name: string; public: boolean }
  | { t: 'start' }
  /** Host: remove a player from the room (they cannot rejoin it). */
  | { t: 'kick'; id: string }
  /** Host: swap two players (team + role). */
  | { t: 'swap'; a: string; b: string }
  /** Lobby only. Host (anyone) or self: move a player to a team, or to the spectators. */
  | { t: 'move'; id: string; team: Seat }
  /** Host: end the running match; everyone goes back to the lobby. */
  | { t: 'stop' }
  | { t: 'chat'; text: string }
  /** Telemetry window (every ~2 s while playing); the server only logs it. */
  | { t: 'stats'; s: ClientStats }
  /** F9: "something just happened" — recent windows plus an optional note. */
  | { t: 'report'; note: string; recent: ClientStats[] }
  /** One input byte per client tick; `s` is the client's sequence number. */
  | { t: 'in'; s: number; b: number }
  | { t: 'team'; team: Team }
  | { t: 'role'; role: Role };

export const STAT_KEYS = [
  'fps',
  'frameMsMax',
  'longFrames',
  'rtt',
  'pending',
  'serverQueue',
  'corrections',
  'myCorrectionPx',
  'myCorrectionMaxPx',
  'ballCorrectionMaxPx',
  'othersCorrectionMaxPx',
  /** Slowest single frame's work, split: prediction ticks, drawing, applying a snapshot (ms). */
  'simMsMax',
  'drawMsMax',
  'snapMsMax',
] as const;
export type ClientStats = Record<(typeof STAT_KEYS)[number], number>;

/** Every known key must be a finite, non-negative number below a sane bound; extra keys are dropped. */
export function decodeStats(v: unknown): ClientStats | null {
  if (!isObj(v)) return null;
  const out = {} as ClientStats;
  for (const k of STAT_KEYS) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e6) return null;
    out[k] = Math.round(n * 10) / 10;
  }
  return out;
}

export type ErrorCode =
  | 'version_mismatch'
  | 'bad_message'
  | 'room_full'
  | 'room_not_found'
  | 'not_host'
  | 'server_full'
  | 'rate_limited'
  | 'kicked'
  | 'no_players'
  | 'maintenance';

export interface RoomPlayer {
  id: string;
  name: string;
  team: Team;
  role: Role;
  bot: boolean;
}

export interface RoomInfo {
  code: string;
  name: string;
  public: boolean;
  host: string;
  state: 'lobby' | 'playing';
  settings: Settings;
  /** Arena for each kickoff of the current match, in order (drawn when it starts). */
  arenaPlan: ArenaKind[];
  players: RoomPlayer[];
  /** Watching, not playing (everyone who arrives mid-match starts here). */
  spectators: Array<{ id: string; name: string }>;
}

/** GET /rooms entry. */
export interface RoomListing {
  code: string;
  name: string;
  humans: number;
  max: number;
  /** No room for even a spectator. */
  full: boolean;
  state: 'lobby' | 'playing';
}

export type ServerMessage =
  /** `token`: the server-issued reconnect token for this tab (send it back in the next hello). */
  | {
      t: 'welcome';
      protocolVersion: number;
      clientId: string;
      serverTime: number;
      version?: string;
      token?: string;
      /** The server is under maintenance: new rooms and joins are refused (matches already running go on). */
      maintenance?: boolean;
    }
  | { t: 'pong'; id: number; serverTime: number }
  /** Maintenance turned on or off (sent to everyone connected the moment it changes). */
  | { t: 'maintenance'; on: boolean }
  /** That room lives in another server process: connect again with `?room=CODE` and join there. */
  | { t: 'moved'; code: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'joined'; code: string; playerId: string }
  | { t: 'room'; room: RoomInfo }
  /** `n` numbers the room's lines, so a replayed line is not shown twice. */
  | { t: 'chat'; n: number; id: string; name: string; team: Seat; text: string }
  /** Authoritative state at `tick`; `ack` = last input sequence of yours already applied; `q` = your inputs
   * still queued on the server; `lead` = clock-sync feedback: how many ticks further ahead of the server you
   * run than your link's jitter needs (tick a little slower while it is above 0); `h` = each human player's
   * input in effect in the last step (authoritative; the state's `input` is zeroed by a kickoff). */
  | { t: 'snap'; tick: number; ack: number; q: number; lead: number; h: Record<string, number>; g: Game }
  /** Input relay: player `id` changed its keys to `b`, applied on the server in the step from tick `k`.
   * Sent the moment it reaches the server (only changes), so other clients' predictions learn of a kick
   * before the snapshot that contains it. */
  | { t: 'ri'; id: string; k: number; b: number };

type Obj = Record<string, unknown>;
const ERROR_CODES: readonly string[] = [
  'version_mismatch',
  'bad_message',
  'room_full',
  'room_not_found',
  'not_host',
  'server_full',
  'rate_limited',
  'kicked',
  'no_players',
  'maintenance',
];
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
/** Clock-sync feedback in ticks; above 60 (1 s) is not a sane value. */
const isLead = (v: unknown): v is number => isUint(v) && v <= 60;
/** Held inputs per player id: at most a room's worth, each an input byte; anything else is dropped. */
function decodeHeld(v: unknown): Record<string, number> {
  if (!isObj(v)) return {};
  const entries = Object.entries(v);
  if (entries.length > 16) return {};
  // fromEntries defines own properties: a "__proto__" key cannot reach the prototype.
  return Object.fromEntries(
    entries.filter((e): e is [string, number] => e[0].length <= 64 && isUint(e[1]) && e[1] < 64),
  );
}
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function parse(raw: string): Obj | null {
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Strips control characters and trims; null when nothing is left. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // Control and format characters out (C0/C1, zero-width, right-to-left overrides that flip how a
  // name reads); the zero-width joiner stays, emoji sequences need it.
  const s = [...v]
    .filter((c) => c === '\u200D' || !/[\p{Cc}\p{Cf}]/u.test(c))
    .join('')
    .trim()
    .slice(0, max);
  return s || null;
}

const ARENA_KINDS: readonly string[] = ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'];
const ITEMS: readonly string[] = [
  'gun',
  'mine',
  'ice',
  'dizzy',
  'boost',
  'shield',
  'power',
  'teleport',
  'bazooka',
];

export function decodeSettings(v: unknown): Settings | null {
  if (!isObj(v)) return null;
  const { minutes, scoreLimit, crates, bots } = v;
  const weights = decodeWeights(v);
  if (!weights) return null;
  if (v.roles !== undefined && typeof v.roles !== 'boolean') return null;
  if (![2, 3, 5, 10, 0].includes(minutes as number) || ![3, 5, 7, 10].includes(scoreLimit as number))
    return null;
  if (crates !== 'off' && crates !== 'normal' && crates !== 'chaos') return null;
  if (typeof bots !== 'boolean') return null;
  // Missing = every arena (older clients); otherwise a non-empty list of known kinds.
  const arenaList = v.arenas ?? ARENA_KINDS;
  if (!Array.isArray(arenaList) || arenaList.length === 0 || arenaList.length > ARENA_KINDS.length)
    return null;
  if (!arenaList.every((k) => typeof k === 'string' && ARENA_KINDS.includes(k))) return null;
  const arenas = ARENA_KINDS.filter((k) => (arenaList as string[]).includes(k)) as ArenaKind[];
  return {
    minutes: minutes as number,
    scoreLimit: scoreLimit as number,
    crates,
    weights,
    roles: v.roles !== false,
    arenas,
    bots,
  };
}

/**
 * Crate shares: whole numbers 0..100 per item, adding up to 1..100 (missing items = 0). A settings
 * object without `weights` but with the older `loot` list keeps the standard shares of those items.
 */
/** The standard crate shares (sim CRATES.loot; a test keeps the two in step: protocol only takes types
 * from the sim). */
export const DEFAULT_WEIGHTS: Readonly<Settings['weights']> = {
  gun: 13,
  mine: 14,
  ice: 14,
  dizzy: 10,
  boost: 10,
  shield: 8,
  power: 12,
  teleport: 12,
  bazooka: 7,
};

function decodeWeights(v: Record<string, unknown>): Settings['weights'] | null {
  const out = { ...DEFAULT_WEIGHTS };
  if (v.weights === undefined) {
    if (v.loot === undefined) return out;
    const list = v.loot;
    if (!Array.isArray(list) || list.length === 0 || list.length > ITEMS.length) return null;
    if (!list.every((k) => typeof k === 'string' && ITEMS.includes(k))) return null;
    for (const k of ITEMS) if (!(list as string[]).includes(k)) out[k as ItemKind] = 0;
    return out;
  }
  const w = v.weights;
  if (!isObj(w)) return null;
  if (!Object.keys(w).every((k) => ITEMS.includes(k))) return null;
  let sum = 0;
  for (const k of ITEMS) {
    const n = w[k] ?? 0;
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100) return null;
    out[k as ItemKind] = n as number;
    sum += n as number;
  }
  return sum >= 1 && sum <= 100 ? out : null;
}

/** Güvenilmeyen girdi: doğrular ve yalnızca bilinen alanlarla yeni nesne döner. */
export function decodeClientMessage(raw: string): ClientMessage | null {
  const m = parse(raw);
  if (!m) return null;
  switch (m.t) {
    case 'hello': {
      if (!isUint(m.protocolVersion)) return null;
      if (m.sessionToken === undefined) return { t: 'hello', protocolVersion: m.protocolVersion };
      return isStr(m.sessionToken, 128)
        ? { t: 'hello', protocolVersion: m.protocolVersion, sessionToken: m.sessionToken }
        : null;
    }
    case 'ping':
      return isUint(m.id) ? { t: 'ping', id: m.id } : null;
    case 'create': {
      const settings = decodeSettings(m.settings);
      if (!settings || typeof m.public !== 'boolean') return null;
      const name = cleanText(m.name, 16) ?? 'Player';
      const roomName = cleanText(m.roomName, 24) ?? `${name}'s room`;
      return { t: 'create', name, roomName, public: m.public, settings };
    }
    case 'join':
      return isStr(m.code, 4) && CODE_RE.test(m.code)
        ? { t: 'join', code: m.code, name: cleanText(m.name, 16) ?? 'Player' }
        : null;
    case 'leave':
      return { t: 'leave' };
    case 'start':
      return { t: 'start' };
    case 'stop':
      return { t: 'stop' };
    case 'chat': {
      const text = cleanText(m.text, 120);
      return text ? { t: 'chat', text } : null;
    }
    case 'kick':
      return isStr(m.id, 64) ? { t: 'kick', id: m.id } : null;
    case 'swap':
      return isStr(m.a, 64) && isStr(m.b, 64) && m.a !== m.b ? { t: 'swap', a: m.a, b: m.b } : null;
    case 'move':
      return isStr(m.id, 64) && (m.team === 'red' || m.team === 'blue' || m.team === 'spec')
        ? { t: 'move', id: m.id, team: m.team }
        : null;
    case 'stats': {
      const st = decodeStats(m.s);
      return st ? { t: 'stats', s: st } : null;
    }
    case 'report': {
      if (!Array.isArray(m.recent) || m.recent.length > 10) return null;
      const recent = m.recent.map(decodeStats);
      if (recent.some((r) => r === null)) return null;
      return { t: 'report', note: cleanText(m.note, 200) ?? '', recent: recent as ClientStats[] };
    }
    case 'meta':
      return typeof m.public === 'boolean'
        ? { t: 'meta', name: cleanText(m.name, 24) ?? 'Room', public: m.public }
        : null;
    case 'settings': {
      const settings = decodeSettings(m.settings);
      return settings ? { t: 'settings', settings } : null;
    }
    case 'in':
      return isUint(m.s) && isUint(m.b) && m.b < 64 ? { t: 'in', s: m.s, b: m.b } : null;
    case 'team':
      return m.team === 'red' || m.team === 'blue' ? { t: 'team', team: m.team } : null;
    case 'role':
      return m.role === 'gk' || m.role === 'def' || m.role === 'mid' || m.role === 'fwd' || m.role === 'none'
        ? { t: 'role', role: m.role }
        : null;
    default:
      return null;
  }
}

/** The game as a client holds it, as JSON (numbers rounded to 1/STATE_SCALE, no loot randomness).
 * Snapshots are binary now (snap.ts); this stays as the reference a binary state must equal. */
export function encodeGame(g: Game): string {
  return JSON.stringify({ ...g, lootRng: null }, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * STATE_SCALE) / STATE_SCALE : v,
  );
}

/**
 * A message from the server: text frames are JSON, binary frames are snapshots (decoded against what
 * `dec` holds, one decoder per connection). Null if unreadable, or a delta this connection cannot apply.
 */
export function decodeServerData(data: unknown, dec: SnapDecoder): ServerMessage | null {
  if (typeof data === 'string') return decodeServerMessage(data);
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  if (!bytes) return null;
  let s: DecodedSnap | null;
  try {
    s = decodeFrame(bytes, dec);
  } catch {
    // A broken frame: start over from the next key frame.
    dec.state = null;
    dec.tick = -1;
    return null;
  }
  if (!s || !isGame(s.state)) return null;
  // The decoder keeps its copy for the next delta; prediction gets its own.
  const g = structuredClone(s.state) as unknown as Game;
  return {
    t: 'snap',
    tick: s.tick,
    ack: s.ack,
    q: s.q,
    lead: isLead(s.lead) ? s.lead : 0,
    h: decodeHeld(s.h),
    g,
  };
}

const isGame = (g: unknown): g is Game =>
  isObj(g) &&
  isUint(g.tick) &&
  Array.isArray(g.players) &&
  isObj(g.ball) &&
  Array.isArray(g.crates) &&
  Array.isArray(g.bullets) &&
  Array.isArray(g.blasts) &&
  Array.isArray(g.score);

export function decodeServerMessage(raw: string): ServerMessage | null {
  const m = parse(raw);
  if (!m) return null;
  switch (m.t) {
    case 'welcome':
      return isUint(m.protocolVersion) && isStr(m.clientId, 64) && typeof m.serverTime === 'number'
        ? {
            t: 'welcome',
            protocolVersion: m.protocolVersion,
            clientId: m.clientId,
            serverTime: m.serverTime,
            ...(isStr(m.version, 64) ? { version: m.version } : {}),
            ...(isStr(m.token, 128) ? { token: m.token } : {}),
            ...(m.maintenance === true ? { maintenance: true } : {}),
          }
        : null;
    case 'pong':
      return isUint(m.id) && typeof m.serverTime === 'number'
        ? { t: 'pong', id: m.id, serverTime: m.serverTime }
        : null;
    case 'error':
      return typeof m.code === 'string' && ERROR_CODES.includes(m.code) && isStr(m.message, 500)
        ? { t: 'error', code: m.code as ErrorCode, message: m.message }
        : null;
    case 'maintenance':
      return typeof m.on === 'boolean' ? { t: 'maintenance', on: m.on } : null;
    case 'moved':
      return typeof m.code === 'string' && CODE_RE.test(m.code) ? { t: 'moved', code: m.code } : null;
    case 'joined':
      return isStr(m.code, 4) && isStr(m.playerId, 64)
        ? { t: 'joined', code: m.code, playerId: m.playerId }
        : null;
    case 'room': {
      const r = m.room;
      return isObj(r) &&
        isStr(r.code, 4) &&
        isStr(r.name, 64) &&
        Array.isArray(r.players) &&
        Array.isArray(r.spectators) &&
        isObj(r.settings)
        ? { t: 'room', room: r as unknown as RoomInfo }
        : null;
    }
    case 'chat':
      return isUint(m.n) &&
        isStr(m.id, 64) &&
        isStr(m.name, 32) &&
        isStr(m.text, 200) &&
        (m.team === 'red' || m.team === 'blue' || m.team === 'spec')
        ? { t: 'chat', n: m.n, id: m.id, name: m.name, team: m.team, text: m.text }
        : null;
    case 'ri':
      return isStr(m.id, 64) && isUint(m.k) && isUint(m.b) && m.b < 64
        ? { t: 'ri', id: m.id, k: m.k, b: m.b }
        : null;
    default:
      return null;
  }
}
