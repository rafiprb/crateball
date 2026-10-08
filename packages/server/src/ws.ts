import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from 'pino';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type ErrorCode,
  type ServerMessage,
} from '@crateball/protocol';
import { LOG_BUDGETS, createLogBudget, type LogBudget, type LogKind } from './log-budget';
import { BAN_MS, type Rooms } from './rooms';
import type { Metrics } from './metrics';

export const HELLO_TIMEOUT_MS = 5000;
export const CLOSE_HELLO_TIMEOUT = 4000;
export const CLOSE_VERSION_MISMATCH = 4001;
export const CLOSE_RATE_LIMIT = 4008;
export const CLOSE_TOO_SLOW = 4009;
/** The same tab (session token) connected again: this older socket is replaced. */
export const CLOSE_TAKEN_OVER = 4011;
/** No complete message for LIMITS.idleMs (a half-sent message, or a peer only answering heartbeats). */
export const CLOSE_IDLE = 4012;
/** Heartbeat: a socket that misses this many pings in a row is dead (sleeping laptop, network switch). */
const MISSED_PINGS = 2;
export const CLOSE_TOO_MANY = 4010;

/**
 * Abuse limits. Normal play sends ~62 messages/s (60 inputs + ping + stats), about 2 KB/s.
 * Per-address limits are sized for an office: one public address (NAT) with ~30 people, several rooms
 * and a few tabs each must never hit them. The global caps protect the one server process.
 */
export const LIMITS = {
  /** Token bucket per connection: burst size and refill per second. The burst covers ~10 s of normal
   * traffic: after a network stall TCP hands over everything the client sent meanwhile at once, and
   * that is a laggy player, not a flood. A real flood (over 2x normal, sustained) is still cut. */
  msgBurst: 720,
  msgPerSec: 120,
  /** Bytes, counted before anything is parsed: per connection, and per address (survives reconnects). */
  bytesBurst: 256 * 1024,
  bytesPerSec: 24 * 1024,
  ipBytesBurst: 4 * 1024 * 1024,
  ipBytesPerSec: 768 * 1024,
  /** Size cap per message type (bytes); anything else is far smaller than the default. */
  maxBytes: { report: 8192 } as Partial<Record<string, number>>,
  maxBytesDefault: 2048,
  /** Open sockets server-wide: 600 players plus spectators and people browsing rooms. */
  maxSockets: 1000,
  /** Open connections from one address (an office behind one NAT: ~30 people, a few tabs each). */
  connectionsPerIp: 96,
  /** New connections from one address: burst and per second (reloads, reconnects after a blip). */
  connectsPerIpBurst: 120,
  connectsPerIpPerSec: 2,
  /** Room creations from one address per minute, and per connection at most one every N ms. */
  createsPerIpPerMin: 30,
  createGapMs: 2000,
  /** Lobby/room actions (everything but inputs, pings and stats) per connection: burst and per second.
   * Each one can rebuild every member's lobby, so a flood must not fan out. */
  actionBurst: 20,
  actionsPerSec: 8,
  /** Joins to a code that does not exist (guessing private codes): per address per minute, and
   * server-wide per minute. Past the server-wide budget only addresses with no recent miss may try a
   * code, so a guesser cannot lock everyone else out and an office mistyping once is not punished. */
  failedJoinsPerIpPerMin: 60,
  failedJoinsPerMin: 300,
  /** R reports per connection: at most one every N ms. */
  reportGapMs: 2000,
  /** Outgoing buffer: above this snapshots are skipped, above the hard cap the client is dropped. */
  softBufferBytes: 256 * 1024,
  hardBufferBytes: 2 * 1024 * 1024,
  /** Native WebSocket pings and pongs a peer may send (we answer pings ourselves): burst, per second. */
  controlBurst: 10,
  controlPerSec: 1,
  /** A complete message at least this often (the client pings every second; a hidden tab's timers can
   * slow to one a minute). Control frames do not count: they cannot keep a half-sent message alive. */
  idleMs: 90_000,
  /** Heartbeat ping (and the sweep for idle or backed-up sockets) every N ms. */
  heartbeatMs: 5000,
  /** Server-wide budgets for log lines clients can cause, per kind (see log-budget.ts). */
  logBudgets: LOG_BUDGETS,
  /** Housekeeping (expired admission records, issued tokens, the dropped-lines summary) every N ms. */
  sweepMs: 60_000,
  /** Issued reconnect tokens of people who are gone (and not under a kick) remembered at most, oldest
   * forgotten first. Tokens of people in a room or connected (≤ sockets + members) and tokens under an
   * active kick (≤ 64 per room × 100 rooms) are kept on top of this, so no flood of new sessions can
   * push them out. */
  maxSessions: 50_000,
  /** Remembered addresses (admission maps) at most; the oldest are forgotten first. */
  maxTrackedIps: 20_000,
};

const ERROR_TEXT: Record<ErrorCode, string> = {
  version_mismatch: 'The game was updated — reload the page',
  bad_message: 'Could not read message',
  room_full: 'This room is full',
  room_not_found: 'Room not found — check the code',
  not_host: 'Only the host can do that',
  server_full: 'The server is full right now — try again in a minute',
  rate_limited: 'Slow down a little',
  kicked: 'The host removed you from this room',
  no_players: 'Nobody is on a team — take a seat or turn bots on',
  maintenance: 'Crateball is down for maintenance. Back soon',
};

/** Load test clients (tests/load) still get in during maintenance: a test runs while the doors are shut. */
const maintenanceOpen = (name: string) => name.startsWith('load-');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Browser pages allowed to open game sockets in production (the desktop app loads the same site). A
 * missing Origin (not a browser) is let through: native clients can claim any Origin anyway, this only
 * stops other websites from using their visitors' browsers. */
export const PROD_ORIGINS = ['https://playcrateball.com', 'https://www.playcrateball.com'];
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function originAllowed(
  origin: string | undefined,
  production: boolean,
  extra: string[] = [],
): boolean {
  if (!origin) return true;
  if (extra.includes(origin)) return true;
  return production ? PROD_ORIGINS.includes(origin) : DEV_ORIGIN.test(origin);
}

/** Behind Caddy the client address is in X-Forwarded-For (Caddy sets it; it does not trust incoming ones). */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** A refilling budget. */
export function bucket(burst: number, perSec: number, now: () => number) {
  let tokens = burst;
  let at = now();
  return {
    take(n = 1): boolean {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * perSec);
      at = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

/** Map with a size cap: the oldest entries go first (insertion order; re-set moves to the end). */
export function boundedSet<V>(m: Map<string, V>, key: string, value: V, max: number) {
  m.delete(key);
  m.set(key, value);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

/**
 * Who may open a game socket, decided before the upgrade: other websites, a full server, an address with
 * too many sockets or opening them too fast. A socket refused after the upgrade would still parse frames
 * while closing (and an invalid one with no error listener would crash the process). In several processes
 * the coordinator runs this for everyone, so the limits count the whole server.
 */
export function createAdmission(
  log: Logger,
  opts: {
    production: boolean;
    origins?: string[];
    /** Open sockets right now, and the cap. */
    sockets: () => number;
    maxSockets: () => number;
    now: () => number;
    logLimited: (write: () => void) => void;
  },
) {
  const connectsByIp = new Map<string, ReturnType<typeof bucket>>();
  const connectionsByIp = new Map<string, number>();
  return {
    /** An HTTP status to refuse with, or null to let it in. */
    check(ip: string, origin: string | undefined): number | null {
      if (!originAllowed(origin || undefined, opts.production, opts.origins)) {
        opts.logLimited(() => log.warn({ ip, origin }, 'yabancı Origin reddedildi'));
        return 403;
      }
      if (opts.sockets() >= opts.maxSockets()) return 503;
      if ((connectionsByIp.get(ip) ?? 0) >= LIMITS.connectionsPerIp) {
        opts.logLimited(() => log.warn({ ip }, 'bir adresten çok fazla bağlantı'));
        return 429;
      }
      let b = connectsByIp.get(ip);
      if (!b) {
        b = bucket(LIMITS.connectsPerIpBurst, LIMITS.connectsPerIpPerSec, opts.now);
        boundedSet(connectsByIp, ip, b, LIMITS.maxTrackedIps);
      }
      return b.take() ? null : 429;
    },
    /** A socket of this address opened; false if it is one too many (two upgrades raced the check). */
    opened(ip: string): boolean {
      const open = (connectionsByIp.get(ip) ?? 0) + 1;
      if (open > LIMITS.connectionsPerIp) return false;
      connectionsByIp.set(ip, open);
      return true;
    },
    closed(ip: string) {
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
    },
  };
}

/** Reconnect tokens: random, with a MAC under the server's secret. Every process of the server knows the
 * secret, so any of them can tell a token it issued from a made-up one. */
export function createTokens(secret: Buffer = randomBytes(32)) {
  const mac = (r: string) => createHmac('sha256', secret).update(r).digest('base64url').slice(0, 22);
  return {
    issue(): string {
      const r = randomBytes(18).toString('base64url');
      return `${r}.${mac(r)}`;
    },
    valid(token: string): boolean {
      const [r, m, extra] = token.split('.');
      if (!r || !m || extra !== undefined || r.length !== 24) return false;
      const want = Buffer.from(mac(r));
      const got = Buffer.from(m);
      return got.length === want.length && timingSafeEqual(got, want);
    },
  };
}

const typeOf = (data: Buffer) => /^\{"t":"([a-z]+)"/.exec(data.subarray(0, 24).toString('latin1'))?.[1];

/** `server`: the HTTP server to take upgrades from (one process), or null when a coordinator hands sockets
 * over (`handleUpgrade`, after its own admission check). */
export function attachWebSocket(
  server: Server | null,
  log: Logger,
  rooms: Rooms,
  opts: {
    helloTimeoutMs?: number;
    version?: string;
    production?: boolean;
    origins?: string[];
    /** Shared with the rooms (see log-budget.ts); one is made if not given. */
    budget?: LogBudget;
    /** Server-wide counters for the `sunucu istatistik` line. */
    metrics?: Metrics;
    /** While this file exists: no new rooms, no joins into other rooms (see `maintenanceOpen`). */
    maintenanceFile?: string;
    /** Open sockets server-wide (default LIMITS.maxSockets). */
    maxSockets?: number;
    /** Reconnect tokens (shared by every process of the server); one of its own if not given. */
    tokens?: ReturnType<typeof createTokens>;
    /** Several processes: does this one hold room `code`? A join elsewhere is answered with `moved`. */
    ownsCode?: (code: string) => boolean;
    now?: () => number;
  } = {},
): WebSocketServer {
  const now = opts.now ?? (() => Date.now());
  const budget = opts.budget ?? createLogBudget(log, LIMITS.logBudgets, now);
  const production = opts.production ?? process.env.NODE_ENV === 'production';
  const bytesByIp = new Map<string, ReturnType<typeof bucket>>();
  const mint = opts.tokens ?? createTokens();
  const admission = createAdmission(log, {
    production,
    origins: opts.origins,
    sockets: () => wss.clients.size,
    maxSockets: () => opts.maxSockets ?? LIMITS.maxSockets,
    now,
    logLimited: (write) => logLimited(write),
  });
  const wss = new WebSocketServer({
    ...(server
      ? {
          server,
          path: '/ws',
          verifyClient: (
            info: { origin: string; req: IncomingMessage },
            done: (ok: boolean, code?: number) => void,
          ) => {
            const refused = admission.check(clientIp(info.req), info.origin);
            done(refused === null, refused ?? undefined);
          },
        }
      : { noServer: true }),
    maxPayload: MAX_MESSAGE_BYTES,
    // Native pings are answered by us, within a budget (ws would answer every one, unmetered).
    autoPong: false,
  });
  /** sessionToken (server-issued) → player id and when it was last used. A reconnect within the grace
   * period gets its slot back; and a token is kept as long as a ban by it can last, so a kicked tab
   * returning with it later is still recognised (and still kicked). */
  const sessions = new Map<string, { id: string; at: number }>();
  const createsByIp = new Map<string, number[]>();
  const failedJoinsByIp = new Map<string, number[]>();
  let failedJoins: number[] = [];
  /** Player id → the socket that currently speaks for it (a takeover replaces it). */
  const owners = new Map<string, WebSocket>();
  const missed = new WeakMap<WebSocket, number>();
  /** Heartbeat challenge outstanding per socket: only a pong carrying it counts as an answer. */
  const challenges = new WeakMap<WebSocket, Buffer>();
  const lastMessageAt = new WeakMap<WebSocket, number>();

  // Server-wide budget for log lines clients can trigger; what does not fit is counted and summarised.
  function logLimited(write: () => void, kind: LogKind = 'warn') {
    budget.line(write, kind);
  }

  // Heartbeat: browsers answer pings on their own. A socket that stops answering is gone even if TCP
  // has not noticed yet; closing it starts the reconnect grace instead of leaving a ghost player. The
  // same sweep drops sockets whose output piled up (also from control frames) or that sent no complete
  // message for too long.
  const heartbeat = setInterval(() => {
    const t = now();
    for (const s of wss.clients) {
      if (s.bufferedAmount > LIMITS.hardBufferBytes) {
        s.terminate();
        continue;
      }
      if (t - (lastMessageAt.get(s) ?? t) > LIMITS.idleMs) {
        s.close(CLOSE_IDLE, 'idle');
        setTimeout(() => s.terminate(), 1000).unref();
        continue;
      }
      const n = (missed.get(s) ?? 0) + 1;
      if (n > MISSED_PINGS) {
        s.terminate();
        continue;
      }
      missed.set(s, n);
      const challenge = randomBytes(8);
      challenges.set(s, challenge);
      s.ping(challenge);
    }
  }, LIMITS.heartbeatMs);
  heartbeat.unref();

  /** A token whose holder is in a room, connected, or kicked from a room (still in force) must never be
   * forgotten: only plain history is evictable. */
  const keep = (token: string, id: string) => rooms.isMember(id) || owners.has(id) || rooms.isBanned(token);
  const remember = (token: string, id: string) => {
    sessions.delete(token);
    sessions.set(token, { id, at: now() });
    if (sessions.size <= LIMITS.maxSessions) return;
    for (const [tk, s] of sessions) {
      if (sessions.size <= LIMITS.maxSessions) break;
      if (!keep(tk, s.id)) sessions.delete(tk);
    }
  };

  /** An id nobody in a room or on a socket is using (ids are short to keep snapshots small). */
  const freshId = () => {
    for (;;) {
      const id = randomUUID().replaceAll('-', '').slice(0, 12);
      if (!owners.has(id) && !rooms.isMember(id)) return id;
    }
  };

  wss.on('connection', (socket, req) => {
    // First, before anything can return early: an invalid frame on a socket without an error listener
    // is an uncaught exception that takes every room down with the process.
    let onError = (err: Error) => logLimited(() => log.warn({ err }, 'ws hatası'));
    socket.on('error', (err) => onError(err));
    const ip = clientIp(req);
    if (!admission.opened(ip)) {
      // Two upgrades raced past the check: close this one (its error listener is in place).
      socket.close(CLOSE_TOO_MANY, 'too many connections');
      setTimeout(() => socket.terminate(), 1000).unref();
      return;
    }
    lastMessageAt.set(socket, now());
    const control = bucket(LIMITS.controlBurst, LIMITS.controlPerSec, now);
    const controlFlood = () => {
      logLimited(() => clog.warn('kontrol çerçevesi seli, bağlantı kesildi'));
      socket.terminate();
    };
    socket.on('ping', (data) => {
      if (!control.take()) return controlFlood();
      if (socket.bufferedAmount <= LIMITS.softBufferBytes) socket.pong(data);
    });
    socket.on('pong', (data) => {
      const expected = challenges.get(socket);
      if (expected && data.equals(expected)) {
        challenges.delete(socket);
        missed.set(socket, 0);
      } else if (!control.take()) controlFlood(); // unsolicited pongs cost budget, and prove nothing
    });

    let clientId = freshId();
    owners.set(clientId, socket);
    let clog = log.child({ clientId });
    let token: string | null = null;
    let tokens = LIMITS.msgBurst;
    let rateLimited = false;
    let refilledAt = now();
    const bytes = bucket(LIMITS.bytesBurst, LIMITS.bytesPerSec, now);
    let lastStatsAt = 0;
    let lastReportAt = 0;
    let lastCreateAt = 0;
    let actions = LIMITS.actionBurst;
    let actionsAt = now();
    let badMessages = 0;

    const send = (m: ServerMessage) => sendRaw(encode(m));
    const sendRaw = (raw: string | Uint8Array, droppable = false): boolean => {
      if (socket.readyState !== socket.OPEN) return false;
      // A client that stops reading must not make the server buffer snapshots forever.
      if (socket.bufferedAmount > LIMITS.hardBufferBytes) {
        logLimited(() =>
          clog.warn({ buffered: socket.bufferedAmount }, 'istemci yetişemiyor, bağlantı kesildi'),
        );
        socket.terminate();
        return false;
      }
      if (droppable && socket.bufferedAmount > LIMITS.softBufferBytes) return false;
      if (opts.metrics) {
        opts.metrics.bytesOut += raw.length;
        opts.metrics.msgsOut++;
      }
      socket.send(raw);
      return true;
    };
    const fail = (code: ErrorCode | null) => {
      if (code) send({ t: 'error', code, message: ERROR_TEXT[code] });
    };
    const rejectBad = (why: string) => {
      // One line for the first, then one per 100: a malformed flood cannot flood the log.
      if (badMessages++ % 100 === 0)
        logLimited(() => clog.warn({ why, count: badMessages }, 'bozuk mesaj atıldı'));
      send({ t: 'error', code: 'bad_message', message: 'Could not read message' });
    };
    const mayCreate = () => {
      const t = now();
      if (t - lastCreateAt < LIMITS.createGapMs) return false;
      const recent = (createsByIp.get(ip) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= LIMITS.createsPerIpPerMin) return false;
      recent.push(t);
      boundedSet(createsByIp, ip, recent, LIMITS.maxTrackedIps);
      lastCreateAt = t;
      return true;
    };

    const myFailedJoins = () => (failedJoinsByIp.get(ip) ?? []).filter((x) => now() - x < 60_000);
    const mayJoin = () => {
      const mine = myFailedJoins();
      if (mine.length >= LIMITS.failedJoinsPerIpPerMin) return false;
      failedJoins = failedJoins.filter((x) => now() - x < 60_000);
      // Server-wide guessing budget spent: addresses that missed recently wait; everyone else joins.
      return failedJoins.length < LIMITS.failedJoinsPerMin || mine.length === 0;
    };
    const joinFailed = () => {
      boundedSet(failedJoinsByIp, ip, [...myFailedJoins(), now()], LIMITS.maxTrackedIps);
      failedJoins.push(now());
    };

    let greeted = false;
    const timer = setTimeout(() => {
      if (greeted) return;
      greeted = true; // a late hello must not greet a socket that is on its way out
      socket.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
      setTimeout(() => socket.terminate(), 1000).unref();
    }, opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    socket.on('close', (code) => {
      clearTimeout(timer);
      admission.closed(ip);
      // Replaced by a newer socket of the same tab: the player is not ours to drop any more.
      if (owners.get(clientId) === socket) {
        owners.delete(clientId);
        // Keep the slot for a reconnect only if this connection could come back with its token.
        if (token && rooms.isMember(clientId)) rooms.disconnect(clientId);
        else rooms.leave(clientId);
      }
      if (badMessages > 1) logLimited(() => clog.warn({ count: badMessages }, 'bozuk mesajlar (toplam)'));
      const session = token ? sessions.get(token) : undefined;
      if (session) session.at = now(); // the ban clock for this tab runs from its last connection
      logLimited(() => clog.info({ code }, 'ws kapandı'), 'life');
    });
    onError = (err) => logLimited(() => clog.warn({ err }, 'ws hatası'));
    socket.on('message', (data: RawData, isBinary) => {
      // Superseded by a newer socket of the same tab, or on its way out: nothing it sends counts.
      if (owners.get(clientId) !== socket || socket.readyState !== socket.OPEN) return;
      lastMessageAt.set(socket, now());
      const t = now();
      tokens = Math.min(LIMITS.msgBurst, tokens + ((t - refilledAt) / 1000) * LIMITS.msgPerSec);
      refilledAt = t;
      if (rateLimited) return; // closing: whatever was still in flight is ignored (and not logged again)
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (opts.metrics) {
        opts.metrics.bytesIn += buf.length;
        opts.metrics.msgsIn++;
      }
      let ipBytes = bytesByIp.get(ip);
      if (!ipBytes) {
        ipBytes = bucket(LIMITS.ipBytesBurst, LIMITS.ipBytesPerSec, now);
        boundedSet(bytesByIp, ip, ipBytes, LIMITS.maxTrackedIps);
      }
      // Counted before anything is parsed: a message count limit alone lets 64 KB pings through.
      if (--tokens < 0 || !bytes.take(buf.length) || !ipBytes.take(buf.length)) {
        rateLimited = true;
        logLimited(() => clog.warn({ ip }, 'mesaj sınırı aşıldı, bağlantı kesildi'));
        socket.close(CLOSE_RATE_LIMIT, 'rate limit');
        return;
      }
      const type = isBinary ? undefined : typeOf(buf);
      if (buf.length > (LIMITS.maxBytes[type ?? ''] ?? LIMITS.maxBytesDefault)) return rejectBad('size');
      const msg = isBinary ? null : decodeClientMessage(buf.toString());
      if (!msg) return rejectBad('decode');
      if (
        msg.t !== 'hello' &&
        msg.t !== 'in' &&
        msg.t !== 'ping' &&
        msg.t !== 'stats' &&
        msg.t !== 'report'
      ) {
        actions = Math.min(LIMITS.actionBurst, actions + ((t - actionsAt) / 1000) * LIMITS.actionsPerSec);
        actionsAt = t;
        if (actions < 1) {
          fail('rate_limited');
          return;
        }
        actions--;
      }
      if (msg.t === 'hello') {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          logLimited(() =>
            clog.warn({ theirs: msg.protocolVersion, ours: PROTOCOL_VERSION }, 'sürüm uyuşmazlığı'),
          );
          send({ t: 'error', code: 'version_mismatch', message: 'The game was updated — reload the page' });
          socket.close(CLOSE_VERSION_MISMATCH, 'version mismatch');
          return;
        }
        if (greeted) return;
        greeted = true;
        clearTimeout(timer);
        // Only tokens this server issued count: a made-up one gets a fresh identity, so a kick or a chat
        // budget cannot be reset by choosing a new token (a fresh anonymous identity can still be had:
        // rooms also budget joins and chat room-wide).
        const known = msg.sessionToken !== undefined && mint.valid(msg.sessionToken);
        token = known ? msg.sessionToken! : mint.issue();
        // Same browser tab back within the grace period: continue as the same player.
        const previous = known ? sessions.get(token)?.id : undefined;
        // One live socket per token, in a room or not: otherwise two sockets would share the token while
        // the session record names only one of them (and protecting the token from eviction, a ban by it,
        // could follow the wrong one).
        const lobbyHolder = previous && !rooms.isMember(previous) ? owners.get(previous) : undefined;
        if (previous && lobbyHolder && lobbyHolder !== socket) {
          owners.delete(clientId);
          clientId = previous;
          owners.set(clientId, socket);
          clog = log.child({ clientId });
          logLimited(() => clog.info('oyuncu yeni bağlantıyla devraldı'), 'life');
          lobbyHolder.close(CLOSE_TAKEN_OVER, 'taken over');
          setTimeout(() => lobbyHolder.terminate(), 1000).unref();
        } else if (previous && rooms.isMember(previous)) {
          // The same tab is back. If its old socket still looks connected (a laptop that slept, a
          // network switch: TCP has not noticed yet), the token proves who it is: take the slot over
          // and close the old socket, which tells a duplicated tab it was replaced.
          const old = owners.get(previous);
          if (!rooms.isAway(previous)) rooms.disconnect(previous);
          if (rooms.reattach(previous, sendRaw)) {
            owners.delete(clientId);
            clientId = previous;
            owners.set(clientId, socket);
            clog = log.child({ clientId });
            logLimited(
              () => clog.info(old ? 'oyuncu yeni bağlantıyla devraldı' : 'oyuncu yeniden bağlandı'),
              'life',
            );
            if (old && old !== socket) {
              old.close(CLOSE_TAKEN_OVER, 'taken over');
              setTimeout(() => old.terminate(), 1000).unref();
            }
          }
        }
        remember(token, clientId);
        logLimited(() => clog.info('oyuncu bağlandı'), 'life');
        send({
          t: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          clientId,
          serverTime: Date.now(),
          version: opts.version,
          token,
          ...(maintenance ? { maintenance: true } : {}),
        });
        return;
      }
      if (!greeted) {
        send({ t: 'error', code: 'bad_message', message: 'Send hello first' });
        return;
      }
      const key = token ?? clientId;
      switch (msg.t) {
        case 'ping':
          send({ t: 'pong', id: msg.id, serverTime: Date.now() });
          break;
        case 'in':
          rooms.input(clientId, msg.s, msg.b);
          break;
        case 'team':
          rooms.move(clientId, clientId, msg.team); // T in the lobby; ignored mid-match
          break;
        case 'role':
          rooms.setRole(clientId, msg.role);
          break;
        case 'leave':
          rooms.leave(clientId);
          break;
        case 'create': {
          if (maintenance && !maintenanceOpen(msg.name)) {
            fail('maintenance');
            break;
          }
          if (!mayCreate()) {
            fail('rate_limited');
            break;
          }
          const r = rooms.create(
            clientId,
            msg.name,
            msg.roomName,
            msg.public,
            msg.settings,
            sendRaw,
            key,
            // Local development (tests, several tabs) shares one address: no per-address room cap there.
            LOOPBACK.has(ip) ? clientId : ip,
          );
          if (typeof r !== 'string') send({ t: 'joined', code: r.code, playerId: clientId });
          else fail(r);
          break;
        }
        case 'join': {
          // That room lives in another process of this server: reconnect there (nothing is revealed: the
          // process follows from the code alone, whether or not such a room exists).
          if (opts.ownsCode && !opts.ownsCode(msg.code)) {
            send({ t: 'moved', code: msg.code });
            break;
          }
          // A player coming back to the room they are in (a reconnect mid-match) is always let in.
          if (maintenance && !maintenanceOpen(msg.name) && rooms.whereIs(clientId).room !== msg.code) {
            fail('maintenance');
            break;
          }
          if (!mayJoin()) {
            fail('rate_limited');
            break;
          }
          const r = rooms.join(msg.code, clientId, msg.name, sendRaw, key);
          if (typeof r !== 'string') send({ t: 'joined', code: r.code, playerId: clientId });
          else {
            if (r === 'room_not_found') joinFailed();
            fail(r);
          }
          break;
        }
        case 'settings':
          fail(rooms.setSettings(clientId, msg.settings));
          break;
        case 'start':
          // Matches already running finish; no new one starts (the lobby shows the maintenance screen).
          if (maintenance && !maintenanceOpen(rooms.whereIs(clientId).name ?? '')) {
            fail('maintenance');
            break;
          }
          fail(rooms.start(clientId));
          break;
        case 'meta':
          fail(rooms.setMeta(clientId, msg.name, msg.public));
          break;
        case 'move':
          fail(rooms.move(clientId, msg.id, msg.team));
          break;
        case 'stop':
          fail(rooms.stopMatch(clientId));
          break;
        case 'chat':
          fail(rooms.chat(clientId, msg.text));
          break;
        case 'kick':
          fail(rooms.kick(clientId, msg.id));
          break;
        case 'swap':
          fail(rooms.swap(clientId, msg.a, msg.b));
          break;
        case 'stats':
          // Gameplay telemetry only from someone in a room, at most 1/s, within the log budget.
          if (!rooms.isMember(clientId) || t - lastStatsAt < 1000) break;
          lastStatsAt = t;
          logLimited(
            () => clog.info({ ...rooms.whereIs(clientId), ...msg.s }, 'istemci istatistik'),
            'telemetry',
          );
          break;
        case 'report':
          if (!rooms.isMember(clientId) || t - lastReportAt < LIMITS.reportGapMs) break;
          lastReportAt = t;
          logLimited(
            () =>
              clog.warn(
                { ...rooms.whereIs(clientId), note: msg.note, recent: msg.recent },
                'oyuncu raporu (R)',
              ),
            'life',
          );
          break;
      }
    });
  });

  // Maintenance: checked once a second; everyone connected hears of a change at once.
  let maintenance = opts.maintenanceFile ? existsSync(opts.maintenanceFile) : false;
  const maintenanceWatch = setInterval(() => {
    const on = opts.maintenanceFile ? existsSync(opts.maintenanceFile) : false;
    if (on === maintenance) return;
    maintenance = on;
    log.info({ on }, 'bakım modu');
    const raw = encode({ t: 'maintenance', on });
    for (const s of wss.clients) if (s.readyState === s.OPEN) s.send(raw);
  }, 1000);
  maintenanceWatch.unref();

  // Tokens of players who are gone for good (and not on a socket either) are forgotten; old admission
  // records expire; dropped log lines are summarised.
  const prune = setInterval(() => {
    const t = now();
    for (const [tk, { id, at }] of sessions) if (t - at > BAN_MS && !keep(tk, id)) sessions.delete(tk);
    for (const [ip, ts] of createsByIp) if (ts.every((x) => t - x > 60_000)) createsByIp.delete(ip);
    for (const [ip, ts] of failedJoinsByIp) if (ts.every((x) => t - x > 60_000)) failedJoinsByIp.delete(ip);
    budget.flush();
  }, LIMITS.sweepMs);
  prune.unref();
  wss.on('close', () => {
    clearInterval(prune);
    clearInterval(heartbeat);
    clearInterval(maintenanceWatch);
  });
  return wss;
}
