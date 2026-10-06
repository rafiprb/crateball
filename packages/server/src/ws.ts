import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type ErrorCode,
  type ServerMessage,
} from '@crateball/protocol';
import type { Rooms } from './rooms';

export const HELLO_TIMEOUT_MS = 5000;
export const CLOSE_HELLO_TIMEOUT = 4000;
export const CLOSE_VERSION_MISMATCH = 4001;
export const CLOSE_RATE_LIMIT = 4008;
export const CLOSE_TOO_SLOW = 4009;
/** The same tab (session token) connected again: this older socket is replaced. */
export const CLOSE_TAKEN_OVER = 4011;
/** Heartbeat: a socket that misses this many pings in a row is dead (sleeping laptop, network switch). */
const PING_EVERY_MS = 5000;
const MISSED_PINGS = 2;
export const CLOSE_TOO_MANY = 4010;

/** Abuse limits. Normal play sends ~62 messages/s (60 inputs + ping + stats). */
export const LIMITS = {
  /** Token bucket per connection: burst size and refill per second. The burst covers ~10 s of normal
   * traffic: after a network stall TCP hands over everything the client sent meanwhile at once, and
   * that is a laggy player, not a flood. A real flood (over 2x normal, sustained) is still cut. */
  msgBurst: 720,
  msgPerSec: 120,
  /** Open connections from one address. */
  connectionsPerIp: 12,
  /** Room creations from one address per minute, and per connection at most one every N ms. */
  createsPerIpPerMin: 10,
  createGapMs: 2000,
  /** Lobby/room actions (everything but inputs, pings and stats) per connection: burst and per second.
   * Each one can rebuild every member's lobby, so a flood must not fan out. */
  actionBurst: 20,
  actionsPerSec: 8,
  /** Joins to a code that does not exist, per address per minute (guessing private codes). */
  failedJoinsPerIpPerMin: 20,
  /** R reports per connection: at most one every N ms. */
  reportGapMs: 2000,
  /** Outgoing buffer: above this snapshots are skipped, above the hard cap the client is dropped. */
  softBufferBytes: 256 * 1024,
  hardBufferBytes: 2 * 1024 * 1024,
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
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Behind Caddy the client address is in X-Forwarded-For (Caddy sets it; it does not trust incoming ones). */
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export function attachWebSocket(
  server: Server,
  log: Logger,
  rooms: Rooms,
  opts: { helloTimeoutMs?: number; version?: string } = {},
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });
  /** sessionToken → player id, so a reconnect within the grace period gets its slot back. */
  const sessions = new Map<string, string>();
  const connectionsByIp = new Map<string, number>();
  const createsByIp = new Map<string, number[]>();
  const failedJoinsByIp = new Map<string, number[]>();
  /** Player id → the socket that currently speaks for it (a takeover replaces it). */
  const owners = new Map<string, WebSocket>();
  const missed = new WeakMap<WebSocket, number>();

  // Heartbeat: browsers answer pings on their own. A socket that stops answering is gone even if TCP
  // has not noticed yet; closing it starts the reconnect grace instead of leaving a ghost player.
  const heartbeat = setInterval(() => {
    for (const s of wss.clients) {
      const n = (missed.get(s) ?? 0) + 1;
      if (n > MISSED_PINGS) {
        s.terminate();
        continue;
      }
      missed.set(s, n);
      s.ping();
    }
  }, PING_EVERY_MS);
  heartbeat.unref();

  /** An id nobody in a room or on a socket is using (ids are short to keep snapshots small). */
  const freshId = () => {
    for (;;) {
      const id = randomUUID().replaceAll('-', '').slice(0, 12);
      if (!owners.has(id) && !rooms.isMember(id)) return id;
    }
  };

  wss.on('connection', (socket, req) => {
    const ip = clientIp(req);
    const open = (connectionsByIp.get(ip) ?? 0) + 1;
    if (open > LIMITS.connectionsPerIp) {
      // Refused outright: no handlers, nothing it sends is read.
      log.warn({ ip }, 'bir adresten çok fazla bağlantı');
      socket.close(CLOSE_TOO_MANY, 'too many connections');
      setTimeout(() => socket.terminate(), 1000).unref();
      return;
    }
    connectionsByIp.set(ip, open);
    socket.on('pong', () => missed.set(socket, 0));

    let clientId = freshId();
    owners.set(clientId, socket);
    let clog = log.child({ clientId });
    let token: string | null = null;
    let tokens = LIMITS.msgBurst;
    let rateLimited = false;
    let refilledAt = Date.now();
    let lastStatsAt = 0;
    let lastReportAt = 0;
    let lastCreateAt = 0;
    let actions = LIMITS.actionBurst;
    let actionsAt = Date.now();

    const send = (m: ServerMessage) => sendRaw(encode(m));
    const sendRaw = (raw: string, droppable = false) => {
      if (socket.readyState !== socket.OPEN) return;
      // A client that stops reading must not make the server buffer snapshots forever.
      if (socket.bufferedAmount > LIMITS.hardBufferBytes) {
        clog.warn({ buffered: socket.bufferedAmount }, 'istemci yetişemiyor, bağlantı kesildi');
        socket.terminate();
        return;
      }
      if (droppable && socket.bufferedAmount > LIMITS.softBufferBytes) return;
      socket.send(raw);
    };
    const fail = (code: ErrorCode | null) => {
      if (code) send({ t: 'error', code, message: ERROR_TEXT[code] });
    };
    const mayCreate = () => {
      const now = Date.now();
      if (now - lastCreateAt < LIMITS.createGapMs) return false;
      const recent = (createsByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= LIMITS.createsPerIpPerMin) return false;
      recent.push(now);
      createsByIp.set(ip, recent);
      lastCreateAt = now;
      return true;
    };

    const mayJoin = () => {
      const now = Date.now();
      return (
        (failedJoinsByIp.get(ip) ?? []).filter((t) => now - t < 60_000).length < LIMITS.failedJoinsPerIpPerMin
      );
    };
    const joinFailed = () => {
      const now = Date.now();
      failedJoinsByIp.set(ip, [...(failedJoinsByIp.get(ip) ?? []).filter((t) => now - t < 60_000), now]);
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
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
      // Replaced by a newer socket of the same tab: the player is not ours to drop any more.
      if (owners.get(clientId) === socket) {
        owners.delete(clientId);
        // Keep the slot for a reconnect only if this connection could come back with its token.
        if (token && rooms.isMember(clientId)) rooms.disconnect(clientId);
        else rooms.leave(clientId);
      }
      clog.info({ code }, 'ws kapandı');
    });
    socket.on('error', (err) => clog.warn({ err }, 'ws hatası'));
    socket.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(LIMITS.msgBurst, tokens + ((now - refilledAt) / 1000) * LIMITS.msgPerSec);
      refilledAt = now;
      if (rateLimited) return; // closing: whatever was still in flight is ignored (and not logged again)
      if (--tokens < 0) {
        rateLimited = true;
        clog.warn('mesaj sınırı aşıldı, bağlantı kesildi');
        socket.close(CLOSE_RATE_LIMIT, 'rate limit');
        return;
      }
      const msg = isBinary ? null : decodeClientMessage(data.toString());
      if (!msg) {
        clog.warn('bozuk mesaj atıldı');
        send({ t: 'error', code: 'bad_message', message: 'Could not read message' });
        return;
      }
      if (
        msg.t !== 'hello' &&
        msg.t !== 'in' &&
        msg.t !== 'ping' &&
        msg.t !== 'stats' &&
        msg.t !== 'report'
      ) {
        actions = Math.min(LIMITS.actionBurst, actions + ((now - actionsAt) / 1000) * LIMITS.actionsPerSec);
        actionsAt = now;
        if (actions < 1) {
          fail('rate_limited');
          return;
        }
        actions--;
      }
      if (msg.t === 'hello') {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          clog.warn({ theirs: msg.protocolVersion, ours: PROTOCOL_VERSION }, 'sürüm uyuşmazlığı');
          send({ t: 'error', code: 'version_mismatch', message: 'The game was updated — reload the page' });
          socket.close(CLOSE_VERSION_MISMATCH, 'version mismatch');
          return;
        }
        if (greeted) return;
        greeted = true;
        clearTimeout(timer);
        if (msg.sessionToken) {
          token = msg.sessionToken;
          // Same browser tab back within the grace period: continue as the same player.
          const previous = sessions.get(token);
          if (previous && rooms.isMember(previous)) {
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
              clog.info(old ? 'oyuncu yeni bağlantıyla devraldı' : 'oyuncu yeniden bağlandı');
              if (old && old !== socket) {
                old.close(CLOSE_TAKEN_OVER, 'taken over');
                setTimeout(() => old.terminate(), 1000).unref();
              }
            }
          }
          sessions.set(token, clientId);
        }
        clog.info('oyuncu bağlandı');
        send({
          t: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          clientId,
          serverTime: Date.now(),
          version: opts.version,
        });
        return;
      }
      if (!greeted) {
        send({ t: 'error', code: 'bad_message', message: 'Send hello first' });
        return;
      }
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
            token ?? clientId,
            // Local development (tests, several tabs) shares one address: no per-address room cap there.
            LOOPBACK.has(ip) ? clientId : ip,
          );
          if (typeof r !== 'string') send({ t: 'joined', code: r.code, playerId: clientId });
          else fail(r);
          break;
        }
        case 'join': {
          if (!mayJoin()) {
            fail('rate_limited');
            break;
          }
          const r = rooms.join(msg.code, clientId, msg.name, sendRaw, token ?? clientId);
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
          if (now - lastStatsAt < 1000) break; // at most 1/s per client, whatever it sends
          lastStatsAt = now;
          clog.info({ ...rooms.whereIs(clientId), ...msg.s }, 'istemci istatistik');
          break;
        case 'report':
          if (now - lastReportAt < LIMITS.reportGapMs) break;
          lastReportAt = now;
          clog.warn({ ...rooms.whereIs(clientId), note: msg.note, recent: msg.recent }, 'oyuncu raporu (R)');
          break;
      }
    });
  });

  // Tokens of players who are gone for good are forgotten.
  const prune = setInterval(() => {
    for (const [t, id] of sessions) if (!rooms.isMember(id)) sessions.delete(t);
    const now = Date.now();
    for (const [ip, ts] of createsByIp) if (ts.every((t) => now - t > 60_000)) createsByIp.delete(ip);
    for (const [ip, ts] of failedJoinsByIp) if (ts.every((t) => now - t > 60_000)) failedJoinsByIp.delete(ip);
  }, 60_000);
  prune.unref();
  wss.on('close', () => {
    clearInterval(prune);
    clearInterval(heartbeat);
  });
  return wss;
}
