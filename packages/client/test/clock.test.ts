import { describe, expect, it } from 'vitest';
import { TICK_HZ } from '@crateball/sim';
import { createTickClock } from '../src/clock';

const TICK_MS = 1000 / TICK_HZ;

describe('saat eşitleme', () => {
  it('fazla önde değilken tick süresi tam 1/60 sn', () => {
    expect(createTickClock().tickMs()).toBe(TICK_MS);
  });
  it('sunucu fazlalık bildirince tick biraz uzar, en çok %3', () => {
    const c = createTickClock();
    c.feedback(2);
    expect(c.tickMs()).toBeCloseTo(TICK_MS * 1.02, 9);
    c.feedback(20);
    expect(c.tickMs()).toBeCloseTo(TICK_MS * 1.03, 9);
    c.feedback(0);
    expect(c.tickMs()).toBe(TICK_MS);
  });
  it('asla hızlanmaz (geç kalan girdiyi sunucu kendisi idare eder)', () => {
    const c = createTickClock();
    c.feedback(-5);
    expect(c.tickMs()).toBe(TICK_MS);
  });
});
