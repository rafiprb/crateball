import type { Logger } from 'pino';

/**
 * One server-wide budget for every log line clients can cause (connections, rooms, matches, telemetry,
 * warnings). Normal play stays far below it; under abuse the lines that do not fit are counted and
 * summarised by `flush` (once a minute), so a flood cannot rotate the useful history out of the journal.
 * Lines the server writes on its own schedule (`oda istatistik`, bounded by the room cap) are not in it.
 */
export interface LogBudget {
  line(write: () => void): void;
  /** Writes how many lines were dropped since the last flush (if any). */
  flush(): void;
}

export function createLogBudget(
  log: Logger,
  burst: number,
  perSec: number,
  now: () => number = Date.now,
): LogBudget {
  let tokens = burst;
  let at = now();
  let dropped = 0;
  return {
    line(write) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * perSec);
      at = t;
      if (tokens >= 1) {
        tokens--;
        write();
      } else dropped++;
    },
    flush() {
      if (dropped === 0) return;
      log.warn({ dropped }, 'log bütçesi aşıldı, satırlar atlandı');
      dropped = 0;
    },
  };
}
