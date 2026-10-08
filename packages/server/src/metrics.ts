import { PerformanceObserver, monitorEventLoopDelay } from 'node:perf_hooks';
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
  /** Ticks (one pass over every room) over the 16.7 ms budget. */
  slowTicks: number;
}

export const createMetrics = (): Metrics => ({
  bytesOut: 0,
  msgsOut: 0,
  bytesIn: 0,
  msgsIn: 0,
  tickMsMax: 0,
  tickMsSum: 0,
  ticks: 0,
  slowTicks: 0,
});

/** How often the server line is written (only while anyone is connected or a room exists). */
export const SERVER_STATS_MS = 5000;

export interface Counts {
  rooms: number;
  playing: number;
  players: number;
  sockets: number;
}

/** One process over the last window. */
export interface Sample extends Counts {
  tickMsMax: number;
  tickMsAvg: number;
  loopDelayP99Ms: number;
  loopDelayMaxMs: number;
  slowTicks: number;
  /** Garbage collection pauses in the window: the longest, and all of them added up (ms). */
  gcMsMax: number;
  gcMsSum: number;
  /** CPU of this process: 100 = one full core. */
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  kbOutPerSec: number;
  msgsOutPerSec: number;
  kbInPerSec: number;
  msgsInPerSec: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Measures this process between calls of `sample` (each call starts a new window). */
export function createSampler(m: Metrics) {
  const LOOP_RES_MS = 10;
  const loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
  loop.enable();
  let cpu = process.cpuUsage();
  let at = performance.now();
  let gcMax = 0;
  let gcSum = 0;
  const gc = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcMax = Math.max(gcMax, e.duration);
      gcSum += e.duration;
    }
  });
  gc.observe({ entryTypes: ['gc'] });
  return {
    sample(c: Counts): Sample {
      const t = performance.now();
      const secs = Math.max(0.001, (t - at) / 1000);
      const used = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      at = t;
      const mem = process.memoryUsage();
      const s: Sample = {
        ...c,
        tickMsMax: r2(m.tickMsMax),
        tickMsAvg: m.ticks ? r2(m.tickMsSum / m.ticks) : 0,
        // The histogram measures a timer of LOOP_RES_MS: what is above that is the delay.
        loopDelayP99Ms: r1(Math.max(0, loop.percentile(99) / 1e6 - LOOP_RES_MS)),
        loopDelayMaxMs: r1(Math.max(0, loop.max / 1e6 - LOOP_RES_MS)),
        slowTicks: m.slowTicks,
        gcMsMax: r1(gcMax),
        gcMsSum: r1(gcSum),
        cpuPct: Math.round(((used.user + used.system) / 1e6 / secs) * 100),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        kbOutPerSec: Math.round(m.bytesOut / 1024 / secs),
        msgsOutPerSec: Math.round(m.msgsOut / secs),
        kbInPerSec: Math.round(m.bytesIn / 1024 / secs),
        msgsInPerSec: Math.round(m.msgsIn / secs),
      };
      loop.reset();
      gcMax = 0;
      gcSum = 0;
      Object.assign(m, createMetrics());
      return s;
    },
    stop: () => {
      loop.disable();
      gc.disconnect();
    },
  };
}

/**
 * Several processes as one line: counts and traffic add up; tick time, loop delay and `cpuPct` are the
 * worst process (each runs on one core, the busiest one is the limit); `cpuTotalPct` adds them all.
 */
export function mergeSamples(main: Sample, workers: Sample[]) {
  const all = [main, ...workers];
  const sum = (k: keyof Sample) => all.reduce((n, s) => n + s[k], 0);
  const max = (k: keyof Sample) => Math.max(...all.map((s) => s[k]));
  return {
    rooms: sum('rooms'),
    playing: sum('playing'),
    players: sum('players'),
    sockets: sum('sockets'),
    tickMsMax: max('tickMsMax'),
    tickMsAvg: workers.length ? r2(Math.max(...workers.map((s) => s.tickMsAvg))) : main.tickMsAvg,
    loopDelayP99Ms: max('loopDelayP99Ms'),
    loopDelayMaxMs: max('loopDelayMaxMs'),
    slowTicks: sum('slowTicks'),
    gcMsMax: max('gcMsMax'),
    gcMsSum: sum('gcMsSum'),
    cpuPct: max('cpuPct'),
    cpuTotalPct: sum('cpuPct'),
    rssMb: sum('rssMb'),
    heapMb: sum('heapMb'),
    kbOutPerSec: sum('kbOutPerSec'),
    msgsOutPerSec: sum('msgsOutPerSec'),
    kbInPerSec: sum('kbInPerSec'),
    msgsInPerSec: sum('msgsInPerSec'),
    workers: workers.map((s) => ({ cpu: s.cpuPct, tick: s.tickMsMax, players: s.players })),
  };
}

/**
 * Writes one `sunucu istatistik` line every 5 s: rooms and people, the cost of a tick over all rooms,
 * event loop delay, CPU (100 = one full core), memory and traffic per second. This is what a load test
 * reads (in Grafana, from the logs) to find the first limit. One process: its own numbers; several: the
 * coordinator merges the workers' samples (see `mergeSamples`).
 */
export function startServerStats(
  log: Logger,
  m: Metrics,
  counts: () => Counts,
  workers?: () => Sample[],
): () => void {
  const sampler = createSampler(m);
  const timer = setInterval(() => {
    const own = sampler.sample(counts());
    const ws = workers?.() ?? null;
    const line = ws ? mergeSamples(own, ws) : { ...own, cpuTotalPct: own.cpuPct };
    if (line.rooms > 0 || line.sockets > 0) log.info(line, 'sunucu istatistik');
  }, SERVER_STATS_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    sampler.stop();
  };
}
