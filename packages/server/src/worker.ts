import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { LOAD_MS, codeOwner, share, type FromWorker, type ToWorker } from './cluster';
import { createLogBudget } from './log-budget';
import { createLogger } from './logger';
import { SERVER_STATS_MS, createMetrics, createSampler } from './metrics';
import { ROOMS_PER_OWNER, createRooms } from './rooms';
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
  const mine = (code: string) => codeOwner(code, n) === k;
  // This worker's shares: of the caps (they add up to the server's) and of the per-address budgets.
  const rooms = createRooms(log, {
    budget,
    metrics,
    caps: { rooms: share(cfg.caps.rooms, k, n), members: share(cfg.caps.players, k, n) },
    roomsPerOwner: Math.max(1, share(ROOMS_PER_OWNER, k, n)),
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
    perIp: (limit) => Math.max(1, share(limit, k, n)),
    onEntered: (key) => send({ t: 'entered', key }),
  });

  process.on('message', (m: ToWorker, handle?: unknown) => {
    if (m.t === 'release') rooms.releaseKey(m.key);
    else if (m.t === 'upgrade') {
      const socket = handle as Socket | undefined;
      // The socket died on its way over (the message arrives without it): still counted, so report it.
      if (!socket) return send({ t: 'closed', id: m.id });
      send({ t: 'accepted', id: m.id });
      // Counted by the coordinator from the handover: whatever happens next, it hears when this one ends.
      socket.once('close', () => send({ t: 'closed', id: m.id }));
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
