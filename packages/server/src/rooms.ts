import type { Logger } from 'pino';
import {
  CODE_ALPHABET,
  encode,
  encodeGame,
  encodeSnap,
  type ErrorCode,
  type RoomInfo,
  type RoomListing,
} from '@crateball/protocol';
import {
  MATCH,
  TICK_HZ,
  addPlayer,
  createGame,
  freeRole,
  removePlayer,
  restartMatch,
  setRole,
  step,
  teamCount,
  type Game,
  type Role,
  type Settings,
  type Team,
} from '@crateball/sim';

/** A snapshot every N ticks (60 Hz sim → 30 Hz snapshots). */
export const SNAP_EVERY = 2;
/** Input queue: beyond this a client is too far ahead; trim back to KEEP to cap latency. */
const QUEUE_MAX = 10;
const QUEUE_KEEP = 4;
const TICK_MS = 1000 / TICK_HZ;
const MAX_CATCHUP = 5;
/** A room stats log line every 5 s of play. */
const ROOM_STATS_EVERY = TICK_HZ * 5;
/** An empty room survives this long so a shared link still works after a refresh. */
export const EMPTY_ROOM_TTL_MS = 2 * 60_000;

interface Member {
  id: string;
  send: Send;
  queue: Array<[seq: number, bits: number]>;
  ack: number;
  /** Ticks played with a stand-in input since the last stats line. */
  starved: number;
  /** Last input applied; stands in when the queue runs dry. */
  last: number;
  /** Set while the socket is gone: the player keeps their slot (and host role) until it fires. */
  awayTimer: ReturnType<typeof setTimeout> | null;
}

export interface Room {
  code: string;
  name: string;
  isPublic: boolean;
  host: string;
  state: 'lobby' | 'playing';
  game: Game;
  members: Map<string, Member>;
  bots: number;
  emptySince: number | null;
  /** Slowest tick (step + snapshot) since the last stats line. */
  stepMsMax: number;
}

type Result = Room | ErrorCode;

/** `droppable`: a snapshot, which may be skipped for a client that is not keeping up. */
type Send = (raw: string, droppable?: boolean) => void;

export interface Rooms {
  create(
    id: string,
    name: string,
    roomName: string,
    isPublic: boolean,
    settings: Settings,
    send: Send,
  ): Result;
  join(code: string, id: string, name: string, send: Send): Result;
  /** Deliberate leave (menu, or switching rooms): the slot is freed now. */
  leave(id: string): void;
  /** Socket closed: keep the slot for a grace period so a reconnect gets it back. */
  disconnect(id: string): void;
  /** Same player is back on a new socket within the grace period. */
  reattach(id: string, send: Send): Room | null;
  isMember(id: string): boolean;
  /** In a room but without a socket (inside the reconnect grace period). */
  isAway(id: string): boolean;
  input(id: string, seq: number, bits: number): void;
  switchTeam(id: string, team: Team): void;
  move(by: string, id: string, team: Team): ErrorCode | null;
  swap(by: string, a: string, b: string): ErrorCode | null;
  setRole(id: string, role: Role): void;
  setSettings(id: string, settings: Settings): ErrorCode | null;
  setMeta(id: string, name: string, isPublic: boolean): ErrorCode | null;
  start(id: string): ErrorCode | null;
  list(): RoomListing[];
  /** For /health: lets a deploy wait until no match is running. */
  stats(): { rooms: number; playing: number; players: number };
  /** Room code and player name for log lines. */
  whereIs(id: string): { room?: string; name?: string };
  tickAll(): void;
  stop(): void;
  readonly rooms: ReadonlyMap<string, Room>;
}

const MAX_PLAYERS = MATCH.maxPerTeam * 2;
/** Hard cap on rooms held in memory (anyone can create one). */
export const MAX_ROOMS = 200;
/** How long a dropped player keeps their slot (and host role). */
export const RECONNECT_GRACE_MS = 20_000;

/** Bots (if enabled) fill the smaller side so every match is at least 1v1 and teams stay even. */
function rebalance(room: Room): void {
  const g = room.game;
  const humans = { red: teamCount(g, 'red', false), blue: teamCount(g, 'blue', false) };
  const size = g.settings.bots ? Math.min(MATCH.maxPerTeam, Math.max(1, humans.red, humans.blue)) : 0;
  for (const team of ['red', 'blue'] as const) {
    let bots = teamCount(g, team, true);
    while (bots > 0 && humans[team] + bots > size) {
      const bot = g.players.findLast((p) => p.bot && p.team === team);
      if (!bot) break;
      removePlayer(g, bot.id);
      bots--;
    }
    while (humans[team] + bots < size) {
      room.bots++;
      addPlayer(g, `bot-${room.bots}`, `Bot ${room.bots}`, team, true);
      bots++;
    }
  }
}

export function info(room: Room): RoomInfo {
  return {
    code: room.code,
    name: room.name,
    public: room.isPublic,
    host: room.host,
    state: room.state,
    settings: room.game.settings,
    players: room.game.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      bot: p.bot,
    })),
  };
}

export function createRooms(
  log: Logger,
  opts: { seed?: () => number; random?: () => number; now?: () => number } = {},
): Rooms {
  const seed = opts.seed ?? (() => Date.now() >>> 0);
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const rooms = new Map<string, Room>();
  const byClient = new Map<string, Room>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  let acc = 0;

  const announce = (room: Room) => {
    const raw = encode({ t: 'room', room: info(room) });
    for (const m of room.members.values()) m.send(raw);
  };

  const broadcastSnap = (room: Room) => {
    const json = encodeGame(room.game);
    for (const m of room.members.values())
      m.send(encodeSnap(room.game.tick, m.ack, m.queue.length, json), true);
  };

  const tickRoom = (room: Room) => {
    if (room.state !== 'playing') return;
    const g = room.game;
    if (g.phase === 'over' && g.phaseT >= MATCH.overPause) {
      room.state = 'lobby';
      log.info({ room: room.code, score: g.score }, 'maç bitti, lobiye dönüldü');
      announce(room);
      return;
    }
    const inputs = new Map<string, number>();
    for (const m of room.members.values()) {
      if (m.queue.length > QUEUE_MAX) m.queue.splice(0, m.queue.length - QUEUE_KEEP);
      const next = m.queue.shift();
      if (next) {
        m.ack = next[0];
        m.last = next[1];
        inputs.set(m.id, next[1]);
      } else if (m.ack > 0) {
        // Starved by network jitter: play the last input AND count it as the client's next sequence
        // number. Server and client stay on the same timeline, so the only possible misprediction is a
        // key change landing exactly on this tick. (Waiting instead would shift the whole world by a
        // tick: measured 3× more own-player correction at 40 ms jitter.)
        m.ack++;
        m.starved++;
        inputs.set(m.id, m.last);
      }
    }
    const t0 = performance.now();
    step(g, inputs);
    if (g.tick % SNAP_EVERY === 0) broadcastSnap(room);
    room.stepMsMax = Math.max(room.stepMsMax, performance.now() - t0);
    if (g.tick % ROOM_STATS_EVERY === 0) {
      const starved = Object.fromEntries(
        [...room.members.values()].map((m) => [
          g.players.find((p) => p.id === m.id)?.name ?? m.id,
          m.starved,
        ]),
      );
      const queued = Object.fromEntries(
        [...room.members.values()].map((m) => [
          g.players.find((p) => p.id === m.id)?.name ?? m.id,
          m.queue.length,
        ]),
      );
      log.info(
        {
          room: room.code,
          tick: g.tick,
          phase: g.phase,
          score: g.score,
          starved,
          queued,
          stepMsMax: Math.round(room.stepMsMax * 100) / 100,
        },
        'oda istatistik',
      );
      for (const m of room.members.values()) m.starved = 0;
      room.stepMsMax = 0;
    }
  };

  const tickAll = () => {
    for (const r of rooms.values()) tickRoom(r);
  };

  const sweep = () => {
    const t = now();
    for (const r of rooms.values()) {
      if (r.emptySince !== null && t - r.emptySince > EMPTY_ROOM_TTL_MS) {
        rooms.delete(r.code);
        log.info({ room: r.code }, 'boş oda kapandı');
      }
    }
    if (rooms.size === 0) stop();
  };

  const ensureTimer = () => {
    if (timer) return;
    last = performance.now();
    acc = 0;
    let sweepAt = 0;
    timer = setInterval(() => {
      const t = performance.now();
      acc = Math.min(acc + t - last, TICK_MS * MAX_CATCHUP);
      last = t;
      while (acc >= TICK_MS) {
        acc -= TICK_MS;
        tickAll();
      }
      if (t >= sweepAt) {
        sweepAt = t + 1000;
        sweep();
      }
    }, 4);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    for (const r of rooms.values())
      for (const m of r.members.values()) if (m.awayTimer) clearTimeout(m.awayTimer);
  };

  const newCode = () => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  const enter = (room: Room, id: string, name: string, send: Send) => {
    const g = room.game;
    const red = teamCount(g, 'red', false);
    const blue = teamCount(g, 'blue', false);
    const team: Team = blue < red ? 'blue' : 'red';
    addPlayer(g, id, name, team);
    room.members.set(id, { id, send, queue: [], ack: 0, starved: 0, last: 0, awayTimer: null });
    room.emptySince = null;
    byClient.set(id, room);
    rebalance(room);
    log.info({ room: room.code, id, name, team }, 'oyuncu odaya girdi');
    announce(room);
  };

  /** Self, or the host moving anyone. Humans per team are capped; bots rebalance around them. */
  const moveTo = (by: string, id: string, team: Team): ErrorCode | null => {
    const room = byClient.get(by);
    if (!room) return 'room_not_found';
    if (by !== id && room.host !== by) return 'not_host';
    // The host rearranges teams in the lobby only; anyone may switch their own team any time.
    if (by !== id && room.state !== 'lobby') return 'bad_message';
    const p = room.game.players.find((o) => o.id === id);
    if (!p || p.team === team) return null;
    if (!p.bot && teamCount(room.game, team, false) >= MATCH.maxPerTeam) return 'room_full';
    p.role = freeRole({ ...room.game, players: room.game.players.filter((o) => o !== p) }, team);
    p.team = team;
    p.x = -p.x;
    p.fx = -p.fx;
    rebalance(room);
    announce(room);
    return null;
  };

  const leave = (id: string, afterDisconnect = false) => {
    const room = byClient.get(id);
    if (!room) return;
    const m = room.members.get(id);
    if (m?.awayTimer) clearTimeout(m.awayTimer);
    byClient.delete(id);
    room.members.delete(id);
    removePlayer(room.game, id);
    if (room.members.size === 0) {
      room.state = 'lobby';
      // Walked away on purpose: nobody needs the room. Dropped: keep it a while so a refresh finds it.
      if (afterDisconnect) room.emptySince = now();
      else {
        rooms.delete(room.code);
        log.info({ room: room.code }, 'boş oda kapandı');
      }
      return;
    }
    if (room.host === id) room.host = room.members.keys().next().value as string;
    rebalance(room);
    announce(room);
  };

  const reattach = (id: string, send: Send): Room | null => {
    const room = byClient.get(id);
    const m = room?.members.get(id);
    if (!room || !m) return null;
    if (m.awayTimer) clearTimeout(m.awayTimer);
    m.awayTimer = null;
    m.send = send;
    // A reloaded page restarts its sequence numbers; a fresh count avoids treating them as late.
    m.ack = 0;
    m.queue = [];
    log.info({ room: room.code, id }, 'oyuncu geri döndü');
    announce(room);
    return room;
  };

  return {
    rooms,
    tickAll,
    stop,
    leave: (id) => leave(id),
    disconnect(id) {
      const room = byClient.get(id);
      const m = room?.members.get(id);
      if (!room || !m) return;
      m.send = () => {};
      m.queue = [];
      const p = room.game.players.find((o) => o.id === id);
      if (p) p.input = 0;
      if (m.awayTimer) clearTimeout(m.awayTimer);
      m.awayTimer = setTimeout(() => leave(id, true), RECONNECT_GRACE_MS);
      log.info({ room: room.code, id }, 'oyuncu koptu, yeri tutuluyor');
    },
    reattach,
    isMember: (id) => byClient.has(id),
    isAway: (id) => !!byClient.get(id)?.members.get(id)?.awayTimer,
    create(id, name, roomName, isPublic, settings, send) {
      if (rooms.size >= MAX_ROOMS) return 'server_full';
      leave(id);
      const code = newCode();
      const room: Room = {
        code,
        name: roomName,
        isPublic,
        host: id,
        state: 'lobby',
        game: createGame(seed(), settings),
        members: new Map(),
        bots: 0,
        emptySince: null,
        stepMsMax: 0,
      };
      rooms.set(code, room);
      log.info({ room: code, isPublic }, 'oda kuruldu');
      ensureTimer();
      enter(room, id, name, send);
      return room;
    },
    join(code, id, name, send) {
      const room = rooms.get(code);
      if (!room) return 'room_not_found';
      // Already in this very room (a reconnect that kept its slot): just take the new socket.
      const current = byClient.get(id);
      if (current === room) return reattach(id, send) ?? 'room_not_found';
      if (room.members.size >= MAX_PLAYERS) return 'room_full';
      // Only now leave the old room: a wrong code must not throw you out of the one you are in.
      leave(id);
      if (room.members.size === 0) room.host = id;
      enter(room, id, name, send);
      return room;
    },
    input(id, seq, bits) {
      const room = byClient.get(id);
      const m = room?.members.get(id);
      if (room?.state !== 'playing' || !m) return;
      // Arrived after a stand-in already played its tick: still the freshest intent.
      if (seq <= m.ack) m.last = bits;
      else if (seq > (m.queue.at(-1)?.[0] ?? m.ack)) {
        m.queue.push([seq, bits]);
        // Bounded on arrival too, not only at the next tick: a flood cannot grow it.
        if (m.queue.length > QUEUE_MAX * 2) m.queue.splice(0, m.queue.length - QUEUE_MAX);
      }
    },
    switchTeam(id, team) {
      moveTo(id, id, team);
    },
    move: moveTo,
    swap(by, a, b) {
      const room = byClient.get(by);
      if (!room) return 'room_not_found';
      if (room.host !== by) return 'not_host';
      if (room.state !== 'lobby') return 'bad_message';
      const pa = room.game.players.find((p) => p.id === a);
      const pb = room.game.players.find((p) => p.id === b);
      if (!pa || !pb) return 'bad_message';
      [pa.team, pb.team] = [pb.team, pa.team];
      [pa.role, pb.role] = [pb.role, pa.role];
      [pa.x, pb.x, pa.y, pb.y] = [pb.x, pa.x, pb.y, pa.y];
      announce(room);
      return null;
    },
    setRole(id, role) {
      const room = byClient.get(id);
      if (!room) return;
      setRole(room.game, id, role);
      announce(room);
    },
    setSettings(id, settings) {
      const room = byClient.get(id);
      if (!room) return 'room_not_found';
      if (room.host !== id) return 'not_host';
      if (room.state !== 'lobby') return 'bad_message';
      room.game.settings = { ...settings };
      rebalance(room);
      announce(room);
      return null;
    },
    setMeta(id, name, isPublic) {
      const room = byClient.get(id);
      if (!room) return 'room_not_found';
      if (room.host !== id) return 'not_host';
      room.name = name;
      room.isPublic = isPublic;
      announce(room);
      return null;
    },
    start(id) {
      const room = byClient.get(id);
      if (!room) return 'room_not_found';
      if (room.host !== id) return 'not_host';
      if (room.state === 'playing') return null;
      restartMatch(room.game);
      room.state = 'playing';
      for (const m of room.members.values()) m.queue = [];
      log.info({ room: room.code, settings: room.game.settings }, 'maç başladı');
      announce(room);
      broadcastSnap(room);
      return null;
    },
    stats() {
      const all = [...rooms.values()];
      return {
        rooms: all.length,
        playing: all.filter((r) => r.state === 'playing' && r.members.size > 0).length,
        players: all.reduce((n, r) => n + r.members.size, 0),
      };
    },
    whereIs(id) {
      const room = byClient.get(id);
      return { room: room?.code, name: room?.game.players.find((p) => p.id === id)?.name };
    },
    list() {
      return [...rooms.values()]
        .filter((r) => r.isPublic && r.members.size > 0)
        .map((r) => ({
          code: r.code,
          name: r.name,
          humans: r.members.size,
          max: MAX_PLAYERS,
          state: r.state,
        }));
    },
  };
}
