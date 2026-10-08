import type { Logger } from 'pino';

/**
 * Server-wide budgets for every log line clients can cause, one per kind so that one kind cannot starve
 * another:
 * - `life`: connections, rooms, joins, matches, kicks, R reports — the history worth keeping. Reserved
 *   capacity: telemetry or warnings never use it up.
 * - `telemetry`: `istemci istatistik` (every 2 s per playing client). Room for ~120 clients' worth at full
 *   rate; above that lines are sampled (the rest counted), which the dashboard's percentiles tolerate.
 * - `warn`: malformed messages, rate limits, socket errors — abuse makes these, so they get the least.
 * Lines that do not fit are counted per kind and summarised by `flush` (once a minute). Altogether the log
 * stays bounded by the sum of the budgets, however many clients misbehave. Lines the server writes on its
 * own schedule (`oda istatistik`, bounded by the room cap) are not in it.
 */
export type LogKind = 'life' | 'telemetry' | 'warn';

export interface LogBudget {
  line(write: () => void, kind?: LogKind): void;
  /** Writes how many lines of each kind were dropped since the last flush (if any). */
  flush(): void;
}

export const LOG_BUDGETS: Record<LogKind, { burst: number; perSec: number }> = {
  life: { burst: 400, perSec: 40 },
  telemetry: { burst: 120, perSec: 60 },
  warn: { burst: 200, perSec: 20 },
};

export function createLogBudget(
  log: Logger,
  budgets: Record<LogKind, { burst: number; perSec: number }> = LOG_BUDGETS,
  now: () => number = Date.now,
): LogBudget {
  const state = Object.fromEntries(
    (Object.keys(budgets) as LogKind[]).map((k) => [k, { tokens: budgets[k].burst, at: now(), dropped: 0 }]),
  ) as Record<LogKind, { tokens: number; at: number; dropped: number }>;
  return {
    line(write, kind = 'life') {
      const b = state[kind];
      const { burst, perSec } = budgets[kind];
      const t = now();
      b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
      b.at = t;
      if (b.tokens >= 1) {
        b.tokens--;
        write();
      } else b.dropped++;
    },
    flush() {
      const dropped = Object.fromEntries(
        (Object.keys(state) as LogKind[])
          .filter((k) => state[k].dropped > 0)
          .map((k) => [k, state[k].dropped]),
      );
      if (Object.keys(dropped).length === 0) return;
      log.warn({ dropped }, 'log bütçesi aşıldı, satırlar atlandı');
      for (const k of Object.keys(state) as LogKind[]) state[k].dropped = 0;
    },
  };
}
