import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { LOG_BUDGETS, createLogBudget } from '../src/log-budget';

/** A minute of a busy server on a fake clock: `clients` playing (telemetry every 2 s each) plus 30
 * lifecycle lines (joins, match starts, kicks, reports). */
function minute(clients: number) {
  let t = 0;
  const written: string[] = [];
  const summaries: unknown[] = [];
  const log = { warn: (o: unknown) => summaries.push(o) } as unknown as Logger;
  const budget = createLogBudget(log, LOG_BUDGETS, () => t);
  for (let ms = 0; ms < 60_000; ms += 100) {
    t = ms;
    // Each client's line lands somewhere in its 2 s window.
    for (let c = 0; c < clients; c++)
      if ((c * 37) % 2000 >= ms % 2000 && (c * 37) % 2000 < (ms % 2000) + 100)
        budget.line(() => written.push('telemetry'), 'telemetry');
    if (ms % 2000 === 0) budget.line(() => written.push('life'), 'life');
  }
  budget.flush();
  return {
    life: written.filter((w) => w === 'life').length,
    telemetry: written.filter((w) => w === 'telemetry').length,
    summaries,
  };
}

describe('log bütçesi: türler birbirini aç bırakmaz', () => {
  it('600 istemcinin telemetrisi varken yaşam döngüsü satırlarının hiçbiri düşmez; toplam sınırlı', () => {
    const r = minute(600);
    expect(r.life).toBe(30);
    // Telemetry sampled to its own budget: burst + 60 s at its rate, far below 600 × 30.
    const { burst, perSec } = LOG_BUDGETS.telemetry;
    expect(r.telemetry).toBeLessThanOrEqual(burst + 60 * perSec);
    expect(r.telemetry).toBeLessThan(600 * 30);
    expect(r.summaries).toHaveLength(1); // the dropped telemetry is counted, once a minute
  });

  it('normal yükte (80 istemci) her istemcinin her satırı yazılır', () => {
    const r = minute(80);
    expect(r.telemetry).toBe(80 * 30);
    expect(r.life).toBe(30);
    expect(r.summaries).toHaveLength(0);
  });
});
