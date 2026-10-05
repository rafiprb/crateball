import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Logger } from 'pino';
import { WebSocketServer } from 'ws';
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
export const CLOSE_TOO_MANY = 4010;

/** Abuse limits. Normal play sends ~62 messages/s (60 inputs + ping + stats). */
export const LIMITS = {
  /** Token bucket per connection: burst size and refill per second. */
  msgBurst: 240,
  msgPerSec: 120,
  /** Open connections from one address. */
  connectionsPerIp: 12,
  /** Room creations from one address per minute, and per connection at most one every N ms. */
  createsPerIpPerMin: 10,
  createGapMs: 2000,
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

  wss.on('connection', (socket, req) => {
    const ip = clientIp(req);
    const open = (connectionsByIp.get(ip) ?? 0) + 1;
    connectionsByIp.set(ip, open);
    if (open > LIMITS.connectionsPerIp) {
      log.warn({ ip }, 'bir adresten çok fazla bağlantı');
      socket.close(CLOSE_TOO_MANY, 'too many connections');
    }

    let clientId = randomUUID().slice(0, 8);
    let clog = log.child({ clientId });
    let token: string | null = null;
    let tokens = LIMITS.msgBurst;
    let refilledAt = Date.now();
    let lastStatsAt = 0;
    let lastReportAt = 0;
    let lastCreateAt = 0;

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

    let greeted = false;
    const timer = setTimeout(() => {
      if (!greeted) socket.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
    }, opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    socket.on('close', (code) => {
      clearTimeout(timer);
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
      // Keep the slot for a reconnect only if this connection could come back with its token.
      if (token && rooms.isMember(clientId)) rooms.disconnect(clientId);
      else rooms.leave(clientId);
      clog.info({ code }, 'ws kapandı');
    });
    socket.on('error', (err) => clog.warn({ err }, 'ws hatası'));
    socket.on('message', (data, isBinary) => {
      const now = Date.now();
      tokens = Math.min(LIMITS.msgBurst, tokens + ((now - refilledAt) / 1000) * LIMITS.msgPerSec);
      refilledAt = now;
      if (--tokens < 0) {
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
          // Only an away slot can be taken over (a duplicated tab shares the token but must not steal it).
          if (previous && rooms.isAway(previous) && rooms.reattach(previous, sendRaw)) {
            clientId = previous;
            clog = log.child({ clientId });
            clog.info('oyuncu yeniden bağlandı');
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
          );
          if (typeof r !== 'string') send({ t: 'joined', code: r.code, playerId: clientId });
          else fail(r);
          break;
        }
        case 'join': {
          const r = rooms.join(msg.code, clientId, msg.name, sendRaw, token ?? clientId);
          if (typeof r !== 'string') send({ t: 'joined', code: r.code, playerId: clientId });
          else fail(r);
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
  }, 60_000);
  prune.unref();
  wss.on('close', () => clearInterval(prune));
  return wss;
}
