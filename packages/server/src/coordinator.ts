import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage } from 'node:http';
// Aliased: the production bundle's banner already declares a `createRequire` (build.mjs).
import { createRequire as requireFrom } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { CODE_RE } from '@crateball/protocol';
import { codeOwner, LOAD_MS, type FromWorker, type Load, type ToWorker } from './cluster';
import type { ServerConfig } from './config';
import { createHttpHandler, type Route } from './http';
import { createLogBudget } from './log-budget';
import { createMetrics, startServerStats, type Sample } from './metrics';
import { LIMITS, clientIp, createAdmission } from './ws';

interface Worker {
  k: number;
  proc: ChildProcess | null;
  ready: boolean;
  load: Load;
  stats: Sample | null;
  /** Sockets handed to it and not closed yet, per address (given back if it dies). */
  ips: Map<string, number>;
  sockets: number;
}

const emptyLoad = (): Load => ({ rooms: 0, members: 0, playing: 0, sockets: 0, list: [] });

/** How to start a worker: this same program (the bundle in production; main.ts through tsx from source). */
function workerEntry(): { path: string; execArgv: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    const tsx = requireFrom(import.meta.url).resolve('tsx');
    return {
      path: fileURLToPath(new URL('./main.ts', import.meta.url)),
      execArgv: ['--import', pathToFileURL(tsx).href],
    };
  }
  return { path: fileURLToPath(import.meta.url), execArgv: [] };
}

/** Refuses an upgrade before any WebSocket exists. */
function refuse(socket: Socket, code: number) {
  socket.end(
    `HTTP/1.1 ${code} ${STATUS_CODES[code] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

/** The coordinator of several game processes (see cluster.ts). */
export async function startCoordinator(
  cfg: ServerConfig,
  log: Logger,
  opts: { quietWorkers?: boolean } = {},
): Promise<{ port: number; close(): Promise<void> }> {
  const n = cfg.workers;
  const secret = randomBytes(32).toString('base64');
  const budget = createLogBudget(log, LIMITS.logBudgets);
  const entry = workerEntry();
  let closing = false;
  let total = 0;
  const admission = createAdmission(log, {
    production: cfg.mode === 'production',
    origins: cfg.extraOrigins,
    sockets: () => total,
    maxSockets: () => cfg.caps.sockets,
    now: Date.now,
    logLimited: (write) => budget.line(write, 'warn'),
  });

  const workers: Worker[] = Array.from({ length: n }, (_, k) => ({
    k,
    proc: null,
    ready: false,
    load: emptyLoad(),
    stats: null,
    ips: new Map(),
    sockets: 0,
  }));

  const release = (w: Worker, ip: string) => {
    const left = (w.ips.get(ip) ?? 0) - 1;
    if (left < 0) return;
    if (left > 0) w.ips.set(ip, left);
    else w.ips.delete(ip);
    w.sockets--;
    total--;
    admission.closed(ip);
  };

  let started: () => void;
  const allReady = new Promise<void>((resolve) => (started = resolve));
  const spawn = (w: Worker) => {
    const proc = fork(entry.path, [], {
      env: { ...process.env, CRATEBALL_WORKER: String(w.k) },
      execArgv: entry.execArgv,
    });
    w.proc = proc;
    // A message to a worker that just died (EPIPE): its 'exit' handles that.
    proc.on('error', (err) => log.warn({ err, worker: w.k }, 'oyun sürecine yazılamadı'));
    proc.on('message', (m: FromWorker) => {
      switch (m.t) {
        case 'ready':
          w.ready = true;
          if (workers.every((o) => o.ready)) started();
          break;
        case 'load':
          w.load = {
            rooms: m.rooms,
            members: m.members,
            playing: m.playing,
            sockets: m.sockets,
            list: m.list,
          };
          break;
        case 'stats':
          w.stats = m.sample;
          break;
        case 'closed':
          release(w, m.ip);
          break;
      }
    });
    proc.on('exit', (code, signal) => {
      w.ready = false;
      w.proc = null;
      w.load = emptyLoad();
      w.stats = null;
      // Its sockets died with it.
      for (const [ip, count] of w.ips) for (let i = 0; i < count; i++) admission.closed(ip);
      total -= w.sockets;
      w.sockets = 0;
      w.ips.clear();
      if (closing) return;
      log.error({ worker: w.k, code, signal }, 'oyun süreci düştü, yeniden başlatılıyor');
      setTimeout(() => !closing && spawn(w), 1000).unref();
    });
    const init: ToWorker = { t: 'init', k: w.k, n, cfg, secret, quiet: opts.quietWorkers ?? false };
    proc.send(init);
  };
  for (const w of workers) spawn(w);

  // The caps count the whole server: each worker hears what the others hold.
  const sum = (f: (l: Load) => number) => workers.reduce((a, w) => a + f(w.load), 0);
  const share = setInterval(() => {
    const rooms = sum((l) => l.rooms);
    const members = sum((l) => l.members);
    for (const w of workers)
      if (w.ready && w.proc?.connected)
        w.proc.send({ t: 'elsewhere', rooms: rooms - w.load.rooms, members: members - w.load.members });
  }, LOAD_MS);
  share.unref();

  // Development only (the production bundle drops this branch, as in app.ts).
  let devLog: Route | null = null;
  if (process.env.NODE_ENV !== 'production') {
    if (cfg.mode === 'development') devLog = (await import('./dev-log')).createDevLogRoute(log);
  }
  const handler = createHttpHandler(
    cfg,
    devLog,
    () => workers.flatMap((w) => w.load.list),
    () => ({ rooms: sum((l) => l.rooms), playing: sum((l) => l.playing), players: sum((l) => l.members) }),
  );
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      budget.line(() => log.error({ err }, 'http hatası'), 'warn');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return refuse(socket, 400);
    }
    if (url.pathname !== '/ws') return refuse(socket, 404);
    const ip = clientIp(req);
    const origin = req.headers.origin;
    const refused = admission.check(ip, Array.isArray(origin) ? origin[0] : origin);
    if (refused !== null) return refuse(socket, refused);
    // A room's own worker; the menu goes to the one with the fewest sockets.
    const room = url.searchParams.get('room');
    const ready = workers.filter((w) => w.ready);
    const w =
      room && CODE_RE.test(room)
        ? workers[codeOwner(room, n)]!
        : ready.reduce<Worker | undefined>(
            (best, o) => (!best || o.sockets < best.sockets ? o : best),
            undefined,
          );
    if (!w?.ready || !w.proc) return refuse(socket, 503);
    if (!admission.opened(ip)) return refuse(socket, 429);
    total++;
    w.sockets++;
    w.ips.set(ip, (w.ips.get(ip) ?? 0) + 1);
    const msg: ToWorker = {
      t: 'upgrade',
      url: req.url ?? '/ws',
      headers: req.headers,
      head: head.toString('base64'),
      ip,
    };
    w.proc.send(msg, socket, (err) => {
      if (!err) return void socket.destroy();
      release(w, ip);
      socket.destroy();
    });
  });

  const stopStats = startServerStats(
    log,
    createMetrics(),
    () => ({ rooms: 0, playing: 0, players: 0, sockets: 0 }),
    () => workers.flatMap((w) => (w.stats ? [w.stats] : [])),
  );

  // A worker that cannot start (a bad build) must not leave the deploy hanging: fail, and the container
  // restarts.
  await Promise.race([
    allReady,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('oyun süreçleri 30 sn içinde başlamadı')), 30_000).unref(),
    ),
  ]);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  log.info({ port, mode: cfg.mode, version: cfg.version, workers: n }, 'sunucu hazır');
  return {
    port,
    close: async () => {
      closing = true;
      clearInterval(share);
      stopStats();
      // Stop listening now. Not waiting for the callback: sockets handed to workers stay on the server's
      // books (Node asks the workers about them), and the workers are about to exit.
      server.close();
      server.closeAllConnections();
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<void>((resolve) => {
              if (!w.proc) return resolve();
              w.proc.once('exit', () => resolve());
              w.proc.disconnect();
            }),
        ),
      );
    },
  };
}
