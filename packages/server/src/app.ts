import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { ServerConfig } from './config';
import { createHttpHandler, type Route } from './http';
import { createRooms } from './rooms';
import { createLogBudget } from './log-budget';
import { LIMITS, attachWebSocket } from './ws';
import { createMetrics, startServerStats } from './metrics';
import { startCoordinator } from './coordinator';

export { loadConfig, type ServerConfig } from './config';
export { createLogger } from './logger';

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  cfg: ServerConfig,
  log: Logger,
  opts: { helloTimeoutMs?: number; now?: () => number; quietWorkers?: boolean } = {},
): Promise<RunningServer> {
  // Several game processes: this one only takes connections (see cluster.ts).
  if (cfg.workers > 0) return startCoordinator(cfg, log, { quietWorkers: opts.quietWorkers });
  // Derleme sabiti: prod paketinde (esbuild define) bu dal ve dev-log modülü tamamen silinir.
  let devLog: Route | null = null;
  if (process.env.NODE_ENV !== 'production') {
    if (cfg.mode === 'development') devLog = (await import('./dev-log')).createDevLogRoute(log);
  }
  // One budget for every log line clients can cause, in the rooms and on the sockets.
  const budget = createLogBudget(log, LIMITS.logBudgets, opts.now);
  const metrics = createMetrics();
  const rooms = createRooms(log, {
    budget,
    now: opts.now,
    metrics,
    caps: { rooms: cfg.caps.rooms, members: cfg.caps.players },
  });
  const handler = createHttpHandler(
    cfg,
    devLog,
    () => rooms.list(),
    () => rooms.stats(),
  );
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      // Anything a request can trigger is metered like the other client-caused lines.
      budget.line(() => log.error({ err }, 'http hatası'), 'warn');
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const wss = attachWebSocket(server, log, rooms, {
    ...opts,
    version: cfg.version,
    production: cfg.mode === 'production',
    origins: cfg.extraOrigins,
    budget,
    metrics,
    maintenanceFile: cfg.maintenanceFile,
    maxSockets: cfg.caps.sockets,
  });
  const stopStats = startServerStats(log, metrics, () => ({ ...rooms.stats(), sockets: wss.clients.size }));
  try {
    await new Promise<void>((resolve, reject) => {
      // ws, http sunucusunun 'error' olayını yeniden yayar; ikisini de dinle ki yakalanmamış hata olmasın.
      server.once('error', reject);
      wss.once('error', reject);
      server.listen(cfg.port, () => {
        server.off('error', reject);
        wss.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    wss.close();
    server.close();
    throw err;
  }
  const { port } = server.address() as AddressInfo;
  log.info({ port, mode: cfg.mode, version: cfg.version }, 'sunucu hazır');
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        stopStats();
        rooms.stop();
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
