import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { LOAD_MS, codeOwner, type FromWorker, type ToWorker } from './cluster';
import { createLogBudget } from './log-budget';
import { createLogger } from './logger';
import { SERVER_STATS_MS, createMetrics, createSampler } from './metrics';
import { createRooms } from './rooms';
import { LIMITS, attachWebSocket, createTokens } from './ws';

/** To the coordinator, while it is there (after it is gone, the 'disconnect' handler ends this process). */
const send = (m: FromWorker) => {
  if (process.connected) process.send?.(m);
};

/** A game process (see cluster.ts): rooms and their sockets, handed over by the coordinator. */
export async function runWorker(): Promise<void> {
  const init = await new Promise<Extract<ToWorker, { t: 'init' }>>((resolve) => {
    const first = (m: ToWorker) => {
      if (m.t !== 'init') return;
      process.off('message', first);
      resolve(m);
    };
    process.on('message', first);
  });
  const { cfg, k, n } = init;
  const silent = new Writable({ write: (_c, _e, cb) => cb() });
  const log = createLogger(cfg, init.quiet ? { stdout: silent } : {}).child({ worker: k });
  const budget = createLogBudget(log, LIMITS.logBudgets);
  const metrics = createMetrics();
  let elsewhere = { rooms: 0, members: 0 };
  const mine = (code: string) => codeOwner(code, n) === k;
  const rooms = createRooms(log, {
    budget,
    metrics,
    caps: { rooms: cfg.caps.rooms, members: cfg.caps.players },
    elsewhere: () => elsewhere,
    codeOk: mine,
  });
  const wss = attachWebSocket(null, log, rooms, {
    version: cfg.version,
    production: cfg.mode === 'production',
    origins: cfg.extraOrigins,
    budget,
    metrics,
    maintenanceFile: cfg.maintenanceFile,
    // The coordinator counts sockets and refuses beyond the cap before handing any over.
    maxSockets: Infinity,
    tokens: createTokens(Buffer.from(init.secret, 'base64')),
    ownsCode: mine,
  });

  process.on('message', (m: ToWorker, handle?: unknown) => {
    if (m.t === 'elsewhere') elsewhere = { rooms: m.rooms, members: m.members };
    else if (m.t === 'upgrade') {
      const socket = handle as Socket | undefined;
      if (!socket) return;
      // Counted by the coordinator from the handover: whatever happens next, it hears when this one ends.
      socket.once('close', () => send({ t: 'closed', ip: m.ip }));
      const req = { method: 'GET', url: m.url, headers: m.headers, socket } as unknown as IncomingMessage;
      wss.handleUpgrade(req, socket, Buffer.from(m.head, 'base64'), (ws) => wss.emit('connection', ws, req));
    }
  });

  const counts = () => {
    const s = rooms.stats();
    return { rooms: s.rooms, playing: s.playing, players: s.players, sockets: wss.clients.size };
  };
  const load = setInterval(() => {
    const c = counts();
    send({
      t: 'load',
      rooms: c.rooms,
      members: c.players,
      playing: c.playing,
      sockets: c.sockets,
      list: rooms.list(),
    });
  }, LOAD_MS);
  const sampler = createSampler(metrics);
  const stats = setInterval(() => send({ t: 'stats', sample: sampler.sample(counts()) }), SERVER_STATS_MS);
  // A report that raced the coordinator going away (EPIPE): the 'disconnect' below ends this process.
  process.on('error', () => {});
  // The coordinator is gone (it stopped, or crashed): so are we.
  process.on('disconnect', () => {
    clearInterval(load);
    clearInterval(stats);
    rooms.stop();
    for (const c of wss.clients) c.terminate();
    process.exit(0);
  });
  log.info({ of: n }, 'oyun süreci hazır');
  send({ t: 'ready' });
}
