import { createLogger, loadConfig, startServer } from './app';
import { runWorker } from './worker';

// A game process started by the coordinator (CRATEBALL_WORKERS > 0, see cluster.ts).
if (process.env.CRATEBALL_WORKER !== undefined) {
  process.on('uncaughtException', (err) => {
    console.error(err);
    process.exit(1);
  });
  await runWorker();
} else {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const running = await startServer(cfg, log);

  const shutdown = (signal: string) => {
    log.info({ signal }, 'kapanıyor');
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'yakalanmamış hata');
    process.exit(1);
  });
}
