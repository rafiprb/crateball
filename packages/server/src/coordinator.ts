import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage } from 'node:http';
// Aliased: the production bundle's banner already declares a `createRequire` (build.mjs).
import { createRequire as requireFrom } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from 'pino';
import { CODE_RE } from '@crateball/protocol';
import { codeOwner, share, type FromWorker, type Load, type ToWorker } from './cluster';
import type { ServerConfig } from './config';
import { createHttpHandler, type Route } from './http';
import { listenUnix } from './unix';
import { watchLoadTest } from './flags';
import { createLogBudget } from './log-budget';
import { createMetrics, startServerStats, type Sample } from './metrics';
import { LIMITS, clientIp, createAdmission } from './ws';

interface Worker {
  k: number;
  proc: ChildProcess | null;
  ready: boolean;
  load: Load;
  stats: Sample | null;
  /** Sockets handed to it and not reported closed yet, by handover id (given back if it dies). `timer`:
   * waiting for the acknowledgement (then a cancel is sent). */
  handoffs: Map<number, { ip: string; timer: ReturnType<typeof setTimeout> | null }>;
  /** When it last said anything (it reports its load twice a second). */
  heardAt: number;
}

/** A worker that has not said it is ready after this long is started again. */
const READY_MS = 30_000;
/** A handover not acknowledged after this long is cancelled (its handle may have been lost). */
const ACCEPT_MS = 5000;
/** A worker silent this long is taken out of routing (/health 503); this long, it is killed. */
const STALE_MS = 5000;
const HUNG_MS = 15_000;
/** Shutdown: how long a worker gets to exit before SIGTERM, then as long again before SIGKILL. */
const STOP_MS = 2000;

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
): Promise<{ port: number; close(): Promise<void>; workerPids(): Array<number | undefined> }> {
  const n = cfg.workers;
  const secret = randomBytes(32).toString('base64');
  const budget = createLogBudget(log, LIMITS.logBudgets);
  const entry = workerEntry();
  let closing = false;
  let total = 0;
  const loadTest = watchLoadTest(cfg.loadTestFile);
  const admission = createAdmission(log, {
    production: cfg.mode === 'production',
    origins: cfg.extraOrigins,
    sockets: () => total,
    maxSockets: () => cfg.caps.sockets,
    now: Date.now,
    logLimited: (write) => budget.line(write, 'warn'),
    relaxed: loadTest.on,
  });

  const workers: Worker[] = Array.from({ length: n }, (_, k) => ({
    k,
    proc: null,
    ready: false,
    load: emptyLoad(),
    stats: null,
    handoffs: new Map(),
    heardAt: 0,
  }));
  /** Ready and heard from lately: rooms there can be reached. */
  const live = (w: Worker) => w.ready && Date.now() - w.heardAt < STALE_MS;

  /** Gives back what a handover counted, exactly once per id. */
  const release = (w: Worker, id: number) => {
    const h = w.handoffs.get(id);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    w.handoffs.delete(id);
    total--;
    admission.closed(h.ip);
  };
  let nextId = 0;

  let started: () => void;
  const allReady = new Promise<void>((resolve) => (started = resolve));
  const respawn = (w: Worker) => setTimeout(() => !closing && spawn(w), 1000).unref();
  const spawn = (w: Worker) => {
    const proc = fork(entry.path, [], {
      env: { ...process.env, CRATEBALL_WORKER: String(w.k) },
      execArgv: entry.execArgv,
    });
    w.proc = proc;
    // Every start gets a deadline: one that never becomes ready is killed and started again.
    const deadline = setTimeout(() => {
      if (w.proc !== proc || w.ready) return;
      log.error({ worker: w.k }, 'oyun süreci 30 sn içinde hazır olmadı, yeniden başlatılıyor');
      proc.kill('SIGKILL');
    }, READY_MS);
    deadline.unref();
    proc.on('error', (err) => {
      // Could not be started at all (no exit will follow): try again. Otherwise a message to a worker
      // that just died (EPIPE): its 'exit' handles that.
      if (proc.pid === undefined && w.proc === proc) {
        log.error({ err, worker: w.k }, 'oyun süreci başlatılamadı');
        w.proc = null;
        respawn(w);
      } else log.warn({ err, worker: w.k }, 'oyun sürecine yazılamadı');
    });
    proc.on('message', (m: FromWorker) => {
      if (w.proc !== proc) return; // an earlier, replaced process
      w.heardAt = Date.now();
      switch (m.t) {
        case 'ready':
          w.ready = true;
          clearTimeout(deadline);
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
        case 'accepted': {
          const h = w.handoffs.get(m.id);
          if (h?.timer) clearTimeout(h.timer);
          if (h) h.timer = null;
          break;
        }
        case 'closed':
          release(w, m.id);
          break;
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(deadline);
      if (w.proc !== proc) return;
      w.ready = false;
      w.proc = null;
      w.load = emptyLoad();
      w.stats = null;
      // Its sockets died with it.
      for (const id of [...w.handoffs.keys()]) release(w, id);
      if (closing) return;
      log.error({ worker: w.k, code, signal }, 'oyun süreci düştü, yeniden başlatılıyor');
      respawn(w);
    });
    const init: ToWorker = { t: 'init', k: w.k, n, cfg, secret, quiet: opts.quietWorkers ?? false };
    proc.send(init);
  };
  for (const w of workers) spawn(w);
  // A worker that stops talking (stuck event loop) is out of routing at once and killed after a while.
  const watch = setInterval(() => {
    for (const w of workers)
      if (w.ready && w.proc && Date.now() - w.heardAt > HUNG_MS) {
        log.error({ worker: w.k }, 'oyun süreci cevap vermiyor, yeniden başlatılıyor');
        w.proc.kill('SIGKILL');
      }
  }, 1000);
  watch.unref();

  const sum = (f: (l: Load) => number) => workers.reduce((a, w) => a + f(w.load), 0);

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
    // A worker down (restarting, or failing to): its share of the room codes cannot be reached.
    () => workers.every(live),
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
    // A room's own worker. The menu (where rooms are created) goes to the one with the fewest sockets
    // among those with rooms and players to spare in their share of the caps.
    const room = url.searchParams.get('room');
    const ready = workers.filter(live);
    const spare = ready.filter(
      (o) => o.load.rooms < share(cfg.caps.rooms, o.k, n) && o.load.members < share(cfg.caps.players, o.k, n),
    );
    const w =
      room && CODE_RE.test(room)
        ? workers[codeOwner(room, n)]!
        : (spare.length ? spare : ready).reduce<Worker | undefined>(
            (best, o) => (!best || o.handoffs.size < best.handoffs.size ? o : best),
            undefined,
          );
    if (!w || !live(w) || !w.proc) return refuse(socket, 503);
    if (!admission.opened(ip)) return refuse(socket, 429);
    total++;
    const id = ++nextId;
    // Not acknowledged in time: ask (the answer, `accepted` or `closed`, settles it; a hung worker is
    // killed by the watch, which gives back everything it held).
    const timer = setTimeout(() => {
      const h = w.handoffs.get(id);
      if (h) h.timer = null;
      if (w.proc?.connected) w.proc.send({ t: 'cancel', id });
    }, ACCEPT_MS);
    timer.unref();
    w.handoffs.set(id, { ip, timer });
    const msg: ToWorker = {
      t: 'upgrade',
      id,
      url: req.url ?? '/ws',
      headers: req.headers,
      head: head.toString('base64'),
      ip,
    };
    w.proc.send(msg, socket, (err) => {
      if (err) release(w, id);
      socket.destroy(); // the worker holds its own copy now
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
  const unix = cfg.socketPath ? await listenUnix(server, cfg.socketPath) : null;
  const { port } = server.address() as AddressInfo;
  log.info(
    { port, socket: cfg.socketPath, mode: cfg.mode, version: cfg.version, workers: n },
    'sunucu hazır',
  );
  return {
    port,
    workerPids: () => workers.map((w) => w.proc?.pid),
    close: async () => {
      closing = true;
      clearInterval(watch);
      loadTest.stop();
      stopStats();
      // Stop listening now. Not waiting for the callback: sockets handed to workers stay on the server's
      // books (Node asks the workers about them), and the workers are about to exit.
      server.close();
      unix?.close();
      server.closeAllConnections();
      await Promise.all(
        workers.map(
          (w) =>
            new Promise<void>((resolve) => {
              const proc = w.proc;
              if (!proc || proc.exitCode !== null || proc.signalCode !== null) return resolve();
              proc.once('exit', () => resolve());
              // Asked nicely (it ends itself when the channel closes), then told, then made to.
              if (proc.connected) proc.disconnect();
              setTimeout(() => proc.kill('SIGTERM'), STOP_MS).unref();
              setTimeout(() => proc.kill('SIGKILL'), STOP_MS * 2).unref();
            }),
        ),
      );
    },
  };
}
