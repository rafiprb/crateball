import type { ArenaKind, Game, Role, Settings, Team } from '@crateball/sim';

export const PROTOCOL_VERSION = 9;
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
  | 'no_players';

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
  | { t: 'welcome'; protocolVersion: number; clientId: string; serverTime: number; version?: string }
  | { t: 'pong'; id: number; serverTime: number }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'joined'; code: string; playerId: string }
  | { t: 'room'; room: RoomInfo }
  /** `n` numbers the room's lines, so a replayed line is not shown twice. */
  | { t: 'chat'; n: number; id: string; name: string; team: Seat; text: string }
  /** Authoritative state at `tick`; `ack` = last input sequence of yours already applied; `q` = your inputs still queued on the server (clock-sync feedback). */
  | { t: 'snap'; tick: number; ack: number; q: number; g: Game };

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
];
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
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

const ARENA_KINDS: readonly string[] = ['classic', 'rain', 'volcano', 'ice', 'wind'];
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
  // Older clients send nothing ('mixed') or a single kind; newer ones a list of kinds.
  const raw = v.loot ?? 'mixed';
  const list = raw === 'mixed' ? ITEMS : typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > ITEMS.length) return null;
  if (!list.every((k) => typeof k === 'string' && ITEMS.includes(k))) return null;
  const loot = ITEMS.filter((k) => (list as string[]).includes(k)) as Settings['loot'];
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
    loot: loot as Settings['loot'],
    arenas,
    bots,
  };
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
      return m.role === 'gk' || m.role === 'def' || m.role === 'mid' || m.role === 'fwd'
        ? { t: 'role', role: m.role }
        : null;
    default:
      return null;
  }
}

/** Server encodes the game once per tick and wraps it per client (ack differs). */
export function encodeSnap(tick: number, ack: number, q: number, gameJson: string): string {
  return `{"t":"snap","tick":${tick},"ack":${ack},"q":${q},"g":${gameJson}}`;
}

/** Positions/velocities rounded to 1/1000 px: smaller packets, harmless for prediction. */
export function encodeGame(g: Game): string {
  return JSON.stringify(g, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v,
  );
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
    case 'snap':
      return isUint(m.tick) && isUint(m.ack) && isGame(m.g)
        ? { t: 'snap', tick: m.tick, ack: m.ack, q: isUint(m.q) ? m.q : 0, g: m.g }
        : null;
    default:
      return null;
  }
}
