import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENTS, runSim, truthAtTick, truthAtTime, type Truth } from '../netsim/netsim';

// The measurement harness on three fixed seeds (deterministic), 90 s each. Before clock sync and input
// relay the same runs gave: steady20 pending 8-9; ball correction p95 per 2 s window 47 px and rendered
// ball error p95 20 px (means over all clients and seeds). See docs/design.md for the full table.
describe('ağ ölçümü (netsim)', () => {
  const runs = [1, 2, 3].flatMap((s) => runSim({ seed: s * 7919, seconds: 90, clients: DEFAULT_CLIENTS }));
  const mean = (get: (c: (typeof runs)[number]) => number) =>
    runs.reduce((a, c) => a + get(c), 0) / runs.length;

  it('uzun takılmadan sonra fazla girdi tamponu eritilir', () => {
    for (const c of runs.filter((r) => r.name === 'steady20')) {
      expect(c.serverQueue[0]).toBeLessThanOrEqual(2);
      expect(c.pending[0]).toBeLessThanOrEqual(4);
    }
  });

  it('başkasının vuruşundaki top düzeltmesi ve çizilen topun hatası küçük kalır', () => {
    expect(mean((c) => c.ballCorrWindow[1])).toBeLessThan(36);
    expect(mean((c) => c.ballErr[1])).toBeLessThan(16);
  });

  it('aynı tohum aynı maçı üretir (ganimetin gizli akışı da tohumlu)', () => {
    const again = runSim({ seed: 7919, seconds: 90, clients: DEFAULT_CLIENTS });
    expect(again).toEqual(runs.slice(0, DEFAULT_CLIENTS.length));
  });

  it('girdi aktarımı bant genişliğine yük olmaz', () => {
    for (const c of runs) expect(c.relayKBps).toBeLessThan(2);
  });
});

describe('ölçüm: gerçek top', () => {
  // Ball moving 3 px per tick from x 0 at tick 10.
  const truth: Truth = new Map(
    Array.from({ length: 20 }, (_, i) => [10 + i, new Map([['ball', [3 * i, 0] as [number, number]]])]),
  );
  it('tick hizalı: istemcinin çizdiği tick ve ara noktası', () => {
    expect(truthAtTick(truth, 12, 0.5, 'ball')).toEqual([4.5, 0]);
  });
  it('duvar saati hizalı: o anda sahada olan (istemci ne kadar önde tahmin ederse etsin)', () => {
    const TICK_MS = 1000 / 60;
    // Tick 10 happened at time 0: 2.5 ticks later the ball is at 7.5 px.
    expect(truthAtTime(truth, 10, 2.5 * TICK_MS, 'ball')![0]).toBeCloseTo(7.5, 9);
    expect(truthAtTime(truth, 10, 1000, 'ball')).toBeNull(); // past the recorded ticks
  });
});
