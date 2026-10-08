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
  /** Server-wide caps, set just under the capacity measured by the load test (docs/next.md). Beyond them
   * people get "servers are full". Env: CRATEBALL_MAX_ROOMS, CRATEBALL_MAX_PLAYERS, CRATEBALL_MAX_SOCKETS. */
  caps: { rooms: number; players: number; sockets: number };
  /** Game processes (CRATEBALL_WORKERS). 0: everything in this one process (development, tests). More:
   * this process only takes connections and hands each to the process that holds its room. */
  workers: number;
}

/** Measured with the load test (2026-10-08, one game process on the production server). */
export const DEFAULT_CAPS = { rooms: 100, players: 600, sockets: 1000 };

/** Production server: 4 cores, one for the coordinator and Caddy, three for rooms. */
export const DEFAULT_WORKERS = 3;
/** Room codes are split between processes by their first letter (24 letters). */
export const MAX_WORKERS = 12;

function workersFrom(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_WORKERS) throw new Error(`Geçersiz CRATEBALL_WORKERS: ${v}`);
  return n;
}

function capFrom(env: Record<string, string | undefined>, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Geçersiz ${name}: ${v}`);
  return n;
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
    caps: {
      rooms: capFrom(env, 'CRATEBALL_MAX_ROOMS', DEFAULT_CAPS.rooms),
      players: capFrom(env, 'CRATEBALL_MAX_PLAYERS', DEFAULT_CAPS.players),
      sockets: capFrom(env, 'CRATEBALL_MAX_SOCKETS', DEFAULT_CAPS.sockets),
    },
    workers:
      env.CRATEBALL_WORKERS === undefined || env.CRATEBALL_WORKERS === ''
        ? mode === 'production'
          ? DEFAULT_WORKERS
          : 0
        : workersFrom(env.CRATEBALL_WORKERS),
  };
}
