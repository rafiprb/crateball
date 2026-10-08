import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Logger } from 'pino';

/** Server-wide counters, reset by every `sunucu istatistik` line. Only read for that line. */
export interface Metrics {
  bytesOut: number;
  msgsOut: number;
  bytesIn: number;
  msgsIn: number;
  /** One pass over every room (`tickAll`): slowest and summed, in ms. */
  tickMsMax: number;
  tickMsSum: number;
  ticks: number;
}

export const createMetrics = (): Metrics => ({
  bytesOut: 0,
  msgsOut: 0,
  bytesIn: 0,
  msgsIn: 0,
  tickMsMax: 0,
  tickMsSum: 0,
  ticks: 0,
});

/** How often the server line is written (only while anyone is connected or a room exists). */
export const SERVER_STATS_MS = 5000;

/**
 * Writes one `sunucu istatistik` line every 5 s: rooms and people, the cost of a tick over all rooms,
 * event loop delay, CPU of this process (100 = one full core), memory and traffic per second. This is
 * what a load test reads (in Grafana, from the logs) to find the first limit.
 */
export function startServerStats(
  log: Logger,
  m: Metrics,
  counts: () => { rooms: number; playing: number; players: number; sockets: number },
): () => void {
  const LOOP_RES_MS = 10;
  const loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
  loop.enable();
  let cpu = process.cpuUsage();
  let at = performance.now();
  const timer = setInterval(() => {
    const t = performance.now();
    const secs = (t - at) / 1000;
    const used = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    at = t;
    const c = counts();
    if (c.rooms > 0 || c.sockets > 0) {
      const mem = process.memoryUsage();
      const r1 = (n: number) => Math.round(n * 10) / 10;
      log.info(
        {
          ...c,
          tickMsMax: Math.round(m.tickMsMax * 100) / 100,
          tickMsAvg: m.ticks ? Math.round((m.tickMsSum / m.ticks) * 100) / 100 : 0,
          // The histogram measures a timer of LOOP_RES_MS: what is above that is the delay.
          loopDelayP99Ms: r1(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RES_MS)),
          loopDelayMaxMs: r1(Math.max(0, loop.max / 1e6 - LOOP_RES_MS)),
          cpuPct: Math.round(((used.user + used.system) / 1e6 / secs) * 100),
          rssMb: Math.round(mem.rss / 1048576),
          heapMb: Math.round(mem.heapUsed / 1048576),
          kbOutPerSec: Math.round(m.bytesOut / 1024 / secs),
          msgsOutPerSec: Math.round(m.msgsOut / secs),
          kbInPerSec: Math.round(m.bytesIn / 1024 / secs),
          msgsInPerSec: Math.round(m.msgsIn / secs),
        },
        'sunucu istatistik',
      );
    }
    loop.reset();
    Object.assign(m, createMetrics());
  }, SERVER_STATS_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    loop.disable();
  };
}
