import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'development' | 'production';

export interface ServerConfig {
  port: number;
  mode: Mode;
  /** Prod'da istemci build klasörü; dev'de null (istemciyi Vite servis eder). */
  staticDir: string | null;
  /** Dev'de tüm logların toplandığı dosya; prod'da null (stdout → fly logs). */
  logFile: string | null;
  version: string;
  /** Extra browser Origins allowed to open game sockets in production (CRATEBALL_ORIGINS, comma
   * separated): only for running the prod image locally (docker smoke test). */
  extraOrigins: string[];
  /** While this file exists the server is under maintenance (scripts/maintenance.sh on|off). */
  maintenanceFile: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const mode: Mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  const port = Number(env.PORT ?? (mode === 'production' ? 8080 : 3000));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Geçersiz PORT: ${env.PORT}`);
  return {
    port,
    mode,
    // Paketlenmiş sunucu dist/server/server.mjs içinde → istemci dist/client
    staticDir:
      mode === 'production' ? (env.STATIC_DIR ?? fileURLToPath(new URL('../client', import.meta.url))) : null,
    // packages/server/src → depo kökü/logs/dev.log
    logFile:
      mode === 'development'
        ? (env.LOG_FILE ?? fileURLToPath(new URL('../../../logs/dev.log', import.meta.url)))
        : null,
    version: env.APP_VERSION ?? 'dev',
    extraOrigins: (env.CRATEBALL_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    maintenanceFile: env.MAINTENANCE_FILE ?? join(tmpdir(), 'crateball-maintenance'),
  };
}
