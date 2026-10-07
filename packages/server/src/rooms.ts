import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import {
  CODE_ALPHABET,
  encode,
  encodeGame,
  encodeSnap,
  type ErrorCode,
  type RoomInfo,
  type RoomListing,
  type ServerMessage,
  type Seat,
} from '@crateball/protocol';
import {
  MATCH,
  TICK_HZ,
  addPlayer,
  createGame,
  freeRole,
  newArenaPlan,
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
/** Stand-in inputs cover at most this many silent ticks (network jitter, a Wi-Fi blip of up to ~300 ms);
 * longer silences (a background tab) pause. At 6 (100 ms) ordinary Wi-Fi hiccups released the keys on the
 * server and the whole world snapped back on the client. */
export const STAND_IN_TICKS = 18;
/**
 * Clock sync (adaptive input buffer). A client's inputs wait in its queue by however far ahead it started
 * or drifted; nothing used to shrink that, so after one long Wi-Fi stall (silence beyond STAND_IN_TICKS
 * freezes `ack`) a client could keep 5+ inputs waiting for the rest of the match, predicting that much
 * further ahead and seeing every kick by someone else that much more wrong. Now after each tick we note
 * the client's "slack": inputs still waiting once this tick's one was taken (0 = it came just in time), or
 * minus the ticks in a row it was missing. If the smallest slack over LEAD_BLOCKS × LEAD_BLOCK ticks (2 s)
 * stays above LEAD_TARGET, the snapshots say `lead` = that surplus and the client ticks a few percent
 * slower until it is gone. The depth thus adapts to each client's measured arrival jitter: a steady link
 * ends at 1-2 waiting, a clumpy one (whose slack keeps dipping to 0) is left alone. It is never asked to
 * run faster: measured, a deeper buffer for a jittery link hurt its owner more (every remote correction
 * grows with it) than the occasional stand-in tick it avoids.
 */
export const LEAD_BLOCK = 30;
const LEAD_BLOCKS = 4;
export const LEAD_TARGET = 1;
const LEAD_MAX = 30;
/** Input relay budget per player (messages): a burst and a refill per second. A person changes keys a few
 * times a second; a client flooding changes only loses its relay (others fall back to snapshots). */
export const RELAY_BURST = 20;
export const RELAY_PER_SEC = 20;
const TICK_MS = 1000 / TICK_HZ;
const MAX_CATCHUP = 5;
/** A room stats log line every 5 s of play. */
const ROOM_STATS_EVERY = TICK_HZ * 5;
/** An empty room survives this long so a shared link still works after a refresh. */
export const EMPTY_ROOM_TTL_MS = 2 * 60_000;
/** A room that never had a match is cheap to recreate: it goes sooner (room slots are limited). */
export const EMPTY_UNUSED_ROOM_TTL_MS = 30_000;
/** Rooms one address may hold open at once (several friends behind one router still fit). */
export const ROOMS_PER_OWNER = 20;
/** Everyone in a room (players and spectators), server-wide. */
export const MAX_MEMBERS_TOTAL = 600;
/** Kicks a room remembers (by session key), and for how long. */
export const MAX_BANS = 64;
export const BAN_MS = 30 * 60_000;
/** Chat for the whole room (on top of each person's own budget): a fresh identity per line cannot flood. */
const ROOM_CHAT_BURST = 15;
const ROOM_CHAT_REFILL_MS = 500;
/** New arrivals per room: burst, then one per N ms (a kicked griefer coming back under new names). */
export const JOIN_BURST = 12;
const JOIN_REFILL_MS = 5000;

interface Member {
  id: string;
  name: string;
  /** Who to ban if kicked: the tab's session token (survives a reload), else the connection id. */
  key: string;
  /** Watching, not playing: no player in the game. Everyone who arrives mid-match starts here. */
  spectator: boolean;
  send: Send;
  queue: Array<[seq: number, bits: number]>;
  ack: number;
  /** Ticks played with a stand-in input since the last stats line. */
  starved: number;
  /** Consecutive ticks without a fresh input. */
  gap: number;
  /** Last input applied; stands in when the queue runs dry. */
  last: number;
  /** Clock sync: smallest slack in the current block, ticks counted in it, minima of recent blocks, and
   * the resulting feedback. */
  slackMin: number;
  slackTicks: number;
  slackMins: number[];
  lead: number;
  /** Input relay: what everyone else has been told about this player's keys, as they keep it: [tick,
   * bits] changes in order (a new one replaces those at or after its tick), starting with the one in
   * effect now. */
  sched: Array<[tick: number, bits: number]>;
  /** The schedule may be wrong (queue trimmed or cleared, budget ran out): resend it at the next tick. */
  relayDirty: boolean;
  relayTokens: number;
  /** Newest sequence number taken: from the queue, or late (each late sequence corrects once). */
  lateSeq: number;
  /** Tick of the last late relay: at most one per tick. */
  lateRelayAt: number;
  /** Input in effect in the last step (what snapshots report as held: see `h`). */
  applied: number;
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
  /** Players the host kicked (by session key) → until when: they cannot come back to this room. */
  banned: Map<string, number>;
  /** Room-wide chat and join budgets. */
  roomChat: { tokens: number; at: number };
  joins: { tokens: number; at: number };
  /** Recent chat, replayed to whoever joins. */
  chat: ChatLine[];
  /** Chat lines sent so far (numbers each line, so a client never shows one twice). */
  chatCount: number;
  /** Chat flood control per session key (survives leaving and rejoining). */
  chatBuckets: Map<string, { tokens: number; at: number }>;
  emptySince: number | null;
  /** Address that created it (a cap per address keeps one client from taking every room slot). */
  owner: string;
  /** A match has been played here. */
  started: boolean;
  /** Slowest tick (step + snapshot) since the last stats line. */
  stepMsMax: number;
}

type Result = Room | ErrorCode;
type ChatLine = Extract<ServerMessage, { t: 'chat' }>;

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
    key?: string,
    owner?: string,
  ): Result;
  join(code: string, id: string, name: string, send: Send, key?: string): Result;
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
  move(by: string, id: string, team: Seat): ErrorCode | null;
  swap(by: string, a: string, b: string): ErrorCode | null;
  setRole(id: string, role: Role): void;
  setSettings(id: string, settings: Settings): ErrorCode | null;
  setMeta(id: string, name: string, isPublic: boolean): ErrorCode | null;
  /** Host: remove a player from the room for good. */
  kick(by: string, id: string): ErrorCode | null;
  start(id: string): ErrorCode | null;
  /** Host: end the match now; everyone goes back to the lobby. */
  stopMatch(id: string): ErrorCode | null;
  chat(id: string, text: string): ErrorCode | null;
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
/** Players plus spectators. */
const MAX_MEMBERS = 12;
const CHAT_HISTORY = 30;
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;
/** Hard cap on rooms held in memory (anyone can create one). */
export const MAX_ROOMS = 100;
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
      // Ids stay unique; names reuse the lowest free number (no "Bot 4821" after many moves).
      let n = 1;
      while (g.players.some((p) => p.bot && p.name === `Bot ${n}`)) n++;
      addPlayer(g, `bot-${room.bots}`, `Bot ${n}`, team, true);
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
    arenaPlan: room.game.arenaPlan,
    players: room.game.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      bot: p.bot,
    })),
    spectators: [...room.members.values()]
      .filter((m) => m.spectator)
      .map((m) => ({ id: m.id, name: m.name })),
  };
}

export function createRooms(
  log: Logger,
  opts: {
    seed?: () => number;
    random?: () => number;
    now?: () => number;
    /** Secret randomness for loot (32 bits per call). Default: crypto, never derivable from anything
     * clients see. */
    secret?: () => number;
  } = {},
): Rooms {
  const seed = opts.seed ?? (() => Date.now() >>> 0);
  // Room codes from crypto randomness: a private room's code must not be guessable from earlier ones.
  const random = opts.random ?? (() => randomInt(0, 0x100000000) / 0x100000000);
  const secret = opts.secret ?? (() => randomInt(0, 0x100000000));
  const now = opts.now ?? Date.now;
  const rooms = new Map<string, Room>();
  const byClient = new Map<string, Room>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = 0;
  let acc = 0;

  const memberCount = () => byClient.size;
  /** Takes one from a refilling budget (`refillMs` per token); false if empty. */
  const refill = (b: { tokens: number; at: number }, burst: number, refillMs: number) => {
    const t = now();
    b.tokens = Math.min(burst, b.tokens + (t - b.at) / refillMs);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  };

  const announce = (room: Room) => {
    const raw = encode({ t: 'room', room: info(room) });
    for (const m of room.members.values()) m.send(raw);
  };

  const broadcastSnap = (room: Room) => {
    const json = encodeGame(room.game);
    // Every human's input in effect, authoritative: a kickoff zeroes `input` in the state while the key
    // stays held, and a relay the budget held back must not outlive the snapshot either.
    const held: Record<string, number> = {};
    for (const m of room.members.values())
      if (!m.spectator && room.game.players.some((p) => p.id === m.id)) held[m.id] = m.applied;
    const heldJson = JSON.stringify(held);
    for (const m of room.members.values())
      // Never more surplus than is actually waiting right now (a stall drained it meanwhile).
      m.send(
        encodeSnap(room.game.tick, m.ack, m.queue.length, Math.min(m.lead, m.queue.length), heldJson, json),
        true,
      );
  };

  /** Clock sync: nothing measured, no feedback (match start, reconnect, a long silence). */
  const resetSlack = (m: Member) => {
    m.slackMin = Infinity;
    m.slackTicks = 0;
    m.slackMins = [];
    m.lead = 0;
  };

  /** A fresh input timeline (match start, reconnect). On a reconnect the others still hold what they
   * were told about this player: keep it, so that the next tick cancels whatever no longer holds. */
  const resetTimeline = (m: Member, keepSched = false) => {
    resetSlack(m);
    if (keepSched) m.relayDirty = true;
    else {
      m.sched = []; // nothing told yet: the first input applied is announced in any case
      m.relayDirty = false;
    }
    m.lateSeq = 0;
    m.lateRelayAt = -1;
  };

  /**
   * Input relay: a change of keys goes to everyone else the moment it arrives, tagged with the tick the
   * server will apply it at. Their predictions then learn of a kick a queue length plus up to a snapshot
   * interval earlier, and a change still in their future costs them no correction at all. Only changes
   * are sent (a few per second per player), within a budget per player.
   *
   * Receivers keep each player's changes as [tick, bits], a new one replacing those at or after its tick;
   * `sched` mirrors exactly that. Every tick `verifyRelay` checks the input really applied against it and,
   * if they differ (a queue trimmed or cleared, a late input, keys released after a long silence, budget
   * ran out), resends the schedule from this tick: the input applied now, then the queued changes. So a
   * wrong announcement lives at most until the tick it was about, and a trim cancels it at once.
   */
  const sendRelay = (room: Room, m: Member, k: number, bits: number, force = false): boolean => {
    if (m.relayTokens < 1 && !force) {
      m.relayDirty = true;
      return false;
    }
    m.relayTokens = Math.max(0, m.relayTokens - 1);
    while (m.sched.length > 0 && m.sched[m.sched.length - 1]![0] >= k) m.sched.pop();
    m.sched.push([k, bits]);
    const raw = encode({ t: 'ri', id: m.id, k, b: bits });
    for (const o of room.members.values()) if (o !== m) o.send(raw);
    return true;
  };

  /** A new arrival: announce it if it changes the keys (nothing while a resend is due anyway). */
  const relay = (room: Room, m: Member, k: number, bits: number) => {
    if (m.spectator || m.relayDirty) return;
    if (m.sched.at(-1)?.[1] === bits && m.sched.at(-1)![0] <= k) return;
    sendRelay(room, m, k, bits);
  };

  /** Bits the others believe this player plays in the step from tick `t` (undefined: never told). */
  const believed = (m: Member, t: number): number | undefined => {
    let b: number | undefined;
    for (const [k, v] of m.sched) if (k <= t) b = v;
    return b;
  };

  /** After choosing the input applied in the step from tick `t`: correct the others if they were told
   * otherwise, then forget changes that are history. */
  const verifyRelay = (room: Room, m: Member, t: number, applied: number) => {
    m.relayTokens = Math.min(RELAY_BURST, m.relayTokens + RELAY_PER_SEC / TICK_HZ);
    if (m.spectator) return;
    if (m.relayDirty || believed(m, t) !== applied) {
      m.relayDirty = false;
      // Replaces everything from t on: what is applied now, then each queued change at its tick. Changes
      // already announced for later ticks are cancelled even over budget (announcing them took budget).
      const ghosts = (m.sched.at(-1)?.[0] ?? -1) > t;
      let ok = sendRelay(room, m, t, applied, ghosts);
      let prevBits = applied;
      m.queue.forEach(([, bits], i) => {
        if (ok && bits !== prevBits) ok = sendRelay(room, m, t + 1 + i, bits);
        prevBits = bits;
      });
      if (!ok) m.relayDirty = true;
    }
    while (m.sched.length > 1 && m.sched[1]![0] <= t) m.sched.shift();
  };

  const noteSlack = (m: Member, slack: number) => {
    m.slackMin = Math.min(m.slackMin, slack);
    if (++m.slackTicks < LEAD_BLOCK) return;
    m.slackMins.push(m.slackMin);
    if (m.slackMins.length > LEAD_BLOCKS) m.slackMins.shift();
    const window = m.slackMins.length < LEAD_BLOCKS ? LEAD_TARGET : Math.min(...m.slackMins);
    m.lead = Math.max(0, Math.min(LEAD_MAX, window - LEAD_TARGET));
    m.slackMin = Infinity;
    m.slackTicks = 0;
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
    const t0 = performance.now(); // the tick's cost includes relay checks and resends
    const inputs = new Map<string, number>();
    for (const m of room.members.values()) {
      if (m.queue.length > QUEUE_MAX) {
        m.queue.splice(0, m.queue.length - QUEUE_KEEP);
        m.relayDirty = true; // the rest now lands on earlier ticks than announced
      }
      const next = m.queue.shift();
      if (next) {
        m.ack = next[0];
        m.lateSeq = Math.max(m.lateSeq, next[0]);
        m.last = next[1];
        m.gap = 0;
        inputs.set(m.id, next[1]);
        noteSlack(m, m.queue.length);
      } else if (m.ack > 0 && ++m.gap <= STAND_IN_TICKS) {
        // Starved by network jitter: play the last input AND count it as the client's next sequence
        // number. Server and client stay on the same timeline, so the only possible misprediction is a
        // key change landing exactly on this tick. (Waiting instead would shift the whole world by a
        // tick: measured 3× more own-player correction at 40 ms jitter.)
        m.ack++;
        m.starved++;
        inputs.set(m.id, m.last);
        noteSlack(m, -m.gap);
      } else if (m.ack > 0) {
        // Silent for longer than jitter explains (tab in the background, connection stalled): stop
        // counting, or every input after the client wakes up would arrive "late" and its own
        // prediction would be thrown away. The keys count as released until it is heard from again.
        if (m.gap === STAND_IN_TICKS + 1) {
          m.last = 0;
          // No inputs, no measure: an old surplus must not keep slowing a client that is not there.
          resetSlack(m);
        }
        inputs.set(m.id, m.last);
      }
      if (m.spectator) continue;
      // Not heard from yet (or dropped before its first input was taken): its `input` simply carries on.
      // Checked all the same, so that inputs announced before a drop are cancelled.
      const p = g.players.find((o) => o.id === m.id);
      if (!p) continue;
      m.applied = inputs.get(m.id) ?? p.input;
      verifyRelay(room, m, g.tick, m.applied);
    }
    // Fresh secret loot randomness every step: snapshots carry the public `rng` (weather, spawns), so loot
    // must not follow from it, nor from any state a client could reconstruct from past openings.
    g.lootRng = secret();
    step(g, inputs);
    if (g.tick % SNAP_EVERY === 0) broadcastSnap(room);
    room.stepMsMax = Math.max(room.stepMsMax, performance.now() - t0);
    if (g.tick % ROOM_STATS_EVERY === 0) {
      const starved = Object.fromEntries([...room.members.values()].map((m) => [m.name, m.starved]));
      const queued = Object.fromEntries([...room.members.values()].map((m) => [m.name, m.queue.length]));
      const lead = Object.fromEntries([...room.members.values()].map((m) => [m.name, m.lead]));
      log.info(
        {
          room: room.code,
          tick: g.tick,
          phase: g.phase,
          score: g.score,
          starved,
          queued,
          lead,
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
      const ttl = r.started ? EMPTY_ROOM_TTL_MS : EMPTY_UNUSED_ROOM_TTL_MS;
      if (r.emptySince !== null && t - r.emptySince > ttl) {
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

  const enter = (room: Room, id: string, name: string, send: Send, key: string) => {
    const g = room.game;
    const red = teamCount(g, 'red', false);
    const blue = teamCount(g, 'blue', false);
    // Mid-match (or with both teams full) you watch; you can take a seat in the lobby afterwards.
    const spectator = room.state === 'playing' || red + blue >= MAX_PLAYERS;
    const team: Team = blue < red ? 'blue' : 'red';
    if (!spectator) addPlayer(g, id, name, team);
    room.members.set(id, {
      id,
      name,
      key,
      spectator,
      send,
      queue: [],
      ack: 0,
      starved: 0,
      gap: 0,
      last: 0,
      slackMin: Infinity,
      slackTicks: 0,
      slackMins: [],
      lead: 0,
      sched: [],
      relayDirty: false,
      relayTokens: RELAY_BURST,
      lateSeq: 0,
      lateRelayAt: -1,
      applied: 0,
      awayTimer: null,
    });
    // Someone arriving mid-match knows nobody's keys yet: everyone's schedule is resent next tick.
    if (room.state === 'playing') for (const o of room.members.values()) o.relayDirty = true;
    room.emptySince = null;
    byClient.set(id, room);
    rebalance(room);
    log.info({ room: room.code, id, name, team: spectator ? 'spec' : team }, 'oyuncu odaya girdi');
    announce(room);
    for (const line of room.chat) send(encode(line));
  };

  /** Self, or the host moving anyone; lobby only. Humans per team are capped; bots rebalance around them. */
  const moveTo = (by: string, id: string, team: Seat): ErrorCode | null => {
    const room = byClient.get(by);
    if (!room) return 'room_not_found';
    if (by !== id && room.host !== by) return 'not_host';
    // Teams are fixed once the match starts.
    if (room.state !== 'lobby') return 'bad_message';
    const m = room.members.get(id);
    if (team === 'spec') {
      if (!m || m.spectator) return null;
      m.spectator = true;
      removePlayer(room.game, id);
      rebalance(room);
      announce(room);
      return null;
    }
    if (m?.spectator) {
      if (teamCount(room.game, team, false) >= MATCH.maxPerTeam) return 'room_full';
      m.spectator = false;
      addPlayer(room.game, id, m.name, team);
      rebalance(room);
      announce(room);
      return null;
    }
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
    // The last player left mid-match (bots off): nothing left to play, back to the lobby.
    if (room.state === 'playing' && room.game.players.length === 0) room.state = 'lobby';
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
    resetTimeline(m, true);
    // A reloaded page lost everyone's relayed keys too.
    for (const o of room.members.values()) o.relayDirty = true;
    log.info({ room: room.code, id }, 'oyuncu geri döndü');
    announce(room);
    // A reloaded page lost its chat log; a client that kept it skips lines it already has (by number).
    for (const line of room.chat) send(encode(line));
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
      // Nothing to stand in for any more: the keys count as released from now on, and any queued change
      // already announced to the others is void.
      m.last = 0;
      m.gap = STAND_IN_TICKS + 1;
      m.relayDirty = true;
      resetSlack(m);
      const p = room.game.players.find((o) => o.id === id);
      if (p) p.input = 0;
      if (m.awayTimer) clearTimeout(m.awayTimer);
      m.awayTimer = setTimeout(() => leave(id, true), RECONNECT_GRACE_MS);
      log.info({ room: room.code, id }, 'oyuncu koptu, yeri tutuluyor');
    },
    reattach,
    isMember: (id) => byClient.has(id),
    isAway: (id) => !!byClient.get(id)?.members.get(id)?.awayTimer,
    create(id, name, roomName, isPublic, settings, send, key = id, owner = id) {
      if (rooms.size >= MAX_ROOMS || (!byClient.has(id) && memberCount() >= MAX_MEMBERS_TOTAL))
        return 'server_full';
      let mine = 0;
      for (const r of rooms.values()) if (r.owner === owner && r !== byClient.get(id)) mine++;
      if (mine >= ROOMS_PER_OWNER) return 'rate_limited';
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
        banned: new Map(),
        roomChat: { tokens: ROOM_CHAT_BURST, at: now() },
        joins: { tokens: JOIN_BURST, at: now() },
        chat: [],
        chatCount: 0,
        chatBuckets: new Map(),
        emptySince: null,
        stepMsMax: 0,
        owner,
        started: false,
      };
      rooms.set(code, room);
      log.info({ room: code, isPublic }, 'oda kuruldu');
      ensureTimer();
      enter(room, id, name, send, key);
      return room;
    },
    join(code, id, name, send, key = id) {
      const room = rooms.get(code);
      if (!room) return 'room_not_found';
      const current = byClient.get(id);
      if (current === room) {
        // A reconnect that kept its slot takes the new socket; already here and connected: nothing to do
        // (repeating it must not reset the input timeline or spam everyone with room updates).
        if (current.members.get(id)?.awayTimer) return reattach(id, send) ?? 'room_not_found';
        current.members.get(id)?.send(encode({ t: 'room', room: info(room) }));
        return room;
      }
      if ((room.banned.get(key) ?? 0) > now()) return 'kicked';
      if (room.members.size >= MAX_MEMBERS) return 'room_full';
      if (!byClient.has(id) && memberCount() >= MAX_MEMBERS_TOTAL) return 'server_full';
      if (!refill(room.joins, JOIN_BURST, JOIN_REFILL_MS)) return 'rate_limited';
      // Only now leave the old room: a wrong code must not throw you out of the one you are in.
      leave(id);
      if (room.members.size === 0) room.host = id;
      enter(room, id, name, send, key);
      return room;
    },
    input(id, seq, bits) {
      const room = byClient.get(id);
      const m = room?.members.get(id);
      if (room?.state !== 'playing' || !m) return;
      // Arrived after a stand-in already played its tick: still the freshest intent, while the
      // stand-in window lasts. After it the keys were released; a straggler must not latch them again.
      if (seq <= m.ack) {
        // Each late sequence corrects once, and only if newer than anything already taken: a client
        // resending an old number with other keys cannot make the server (and everyone's prediction) churn.
        if (m.gap <= STAND_IN_TICKS && seq > m.lateSeq) {
          m.lateSeq = seq;
          m.last = bits;
          // Stands in from the next tick on, unless a newer input is already waiting. One relay per tick
          // at most; a later one in the same tick is caught by the check when it is applied.
          if (m.queue.length === 0 && m.lateRelayAt !== room.game.tick) {
            m.lateRelayAt = room.game.tick;
            relay(room, m, room.game.tick, bits);
          }
        }
      } else if (seq > (m.queue.at(-1)?.[0] ?? m.ack)) {
        m.queue.push([seq, bits]);
        // Bounded on arrival too, not only at the next tick: a flood cannot grow it.
        if (m.queue.length > QUEUE_MAX * 2) {
          m.queue.splice(0, m.queue.length - QUEUE_MAX);
          m.relayDirty = true;
        }
        // One input per tick: the last in the queue is taken in the step from tick + its index.
        relay(room, m, room.game.tick + m.queue.length - 1, bits);
      }
    },
    move: moveTo,
    swap(by, a, b) {
      const room = byClient.get(by);
      if (!room) return 'room_not_found';
      if (room.host !== by) return 'not_host';
      if (room.state !== 'lobby') return 'bad_message';
      // Spectators have no seat to trade: drag them onto a team column instead.
      const pa = room.game.players.find((p) => p.id === a);
      const pb = room.game.players.find((p) => p.id === b);
      if (!pa || !pb) return 'bad_message';
      [pa.team, pb.team] = [pb.team, pa.team];
      [pa.role, pb.role] = [pb.role, pa.role];
      [pa.x, pb.x, pa.y, pb.y] = [pb.x, pa.x, pb.y, pa.y];
      rebalance(room); // a human for a bot changes how many bots each side needs
      announce(room);
      return null;
    },
    setRole(id, role) {
      const room = byClient.get(id);
      if (!room || room.state !== 'lobby') return; // positions are locked once the match starts
      const p = room.game.players.find((o) => o.id === id);
      if (!p || p.role === role) return; // spectators and no-op changes: nothing to tell anyone
      if (!setRole(room.game, id, role)) return; // a human teammate already plays it
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
    kick(by, id) {
      const room = byClient.get(by);
      if (!room) return 'room_not_found';
      if (room.host !== by) return 'not_host';
      if (id === by || !room.members.has(id)) return 'bad_message';
      const target = room.members.get(id);
      if (target) {
        const t = now();
        for (const [k, until] of room.banned) if (until <= t) room.banned.delete(k);
        room.banned.set(target.key, t + BAN_MS);
        // Oldest kicks go first beyond the cap (insertion order).
        while (room.banned.size > MAX_BANS) room.banned.delete(room.banned.keys().next().value as string);
      }
      target?.send(encode({ t: 'error', code: 'kicked', message: 'The host removed you from this room' }));
      log.info({ room: room.code, id }, 'oyuncu atıldı');
      leave(id);
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
      // Everyone watching and no bots: there would be nobody on the pitch (and a 0-0 never ends).
      if (room.game.players.length === 0) return 'no_players';
      // The arena order is drawn as the match starts, from the pool the host picked.
      newArenaPlan(room.game);
      restartMatch(room.game);
      room.state = 'playing';
      room.started = true;
      // Nothing from the last match carries over: no queued or held keys at the new kickoff.
      for (const m of room.members.values()) {
        m.queue = [];
        m.last = 0;
        m.gap = 0;
        resetTimeline(m);
      }
      // Settings per match start: `pnpm crate-stats` counts which crate mixes people actually pick.
      const humans = room.game.players.filter((p) => !p.bot).length;
      log.info({ room: room.code, humans, settings: room.game.settings }, 'maç başladı');
      announce(room);
      broadcastSnap(room);
      return null;
    },
    stopMatch(id) {
      const room = byClient.get(id);
      if (!room) return 'room_not_found';
      if (room.host !== id) return 'not_host';
      if (room.state !== 'playing') return null;
      room.state = 'lobby';
      log.info({ room: room.code, score: room.game.score }, 'host maçı durdurdu');
      announce(room);
      return null;
    },
    chat(id, text) {
      const room = byClient.get(id);
      const m = room?.members.get(id);
      if (!room || !m) return 'room_not_found';
      const t = now();
      const bucket = room.chatBuckets.get(m.key) ?? { tokens: CHAT_BURST, at: t };
      bucket.tokens = Math.min(CHAT_BURST, bucket.tokens + (t - bucket.at) / CHAT_REFILL_MS);
      bucket.at = t;
      room.chatBuckets.set(m.key, bucket);
      // Sessions come and go while a room lives: forget buckets that have long been full again.
      if (room.chatBuckets.size > 64)
        for (const [k, b] of room.chatBuckets)
          if (t - b.at > CHAT_BURST * CHAT_REFILL_MS) room.chatBuckets.delete(k);
      if (bucket.tokens < 1) return 'rate_limited';
      if (!refill(room.roomChat, ROOM_CHAT_BURST, ROOM_CHAT_REFILL_MS)) return 'rate_limited';
      bucket.tokens--;
      const team = m.spectator ? 'spec' : (room.game.players.find((p) => p.id === id)?.team ?? 'spec');
      const line: ChatLine = { t: 'chat', n: ++room.chatCount, id, name: m.name, team, text };
      room.chat.push(line);
      if (room.chat.length > CHAT_HISTORY) room.chat.shift();
      const raw = encode(line);
      for (const o of room.members.values()) o.send(raw);
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
      return { room: room?.code, name: room?.members.get(id)?.name };
    },
    list() {
      return [...rooms.values()]
        .filter((r) => r.isPublic && r.members.size > 0)
        .map((r) => ({
          code: r.code,
          name: r.name,
          humans: r.game.players.filter((p) => !p.bot).length,
          max: MAX_PLAYERS,
          full: r.members.size >= MAX_MEMBERS,
          state: r.state,
        }));
    },
  };
}
