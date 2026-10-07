import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENTS, runSim } from '../netsim/netsim';

// The measurement harness on one fixed seed (deterministic). Before clock sync and input relay this
// scenario gave: steady20 pending 8-9 with 7 inputs queued, ball correction p95 per 2 s window ~58 px
// (bursty ~27 px); see docs/design.md for the full table.
describe('ağ ölçümü (netsim)', () => {
  const r = Object.fromEntries(
    runSim({ seed: 7919, seconds: 90, clients: DEFAULT_CLIENTS }).map((c) => [c.name, c]),
  );

  it('uzun takılmadan sonra fazla girdi tamponu eritilir', () => {
    expect(r.steady20!.serverQueue[0]).toBeLessThanOrEqual(2);
    expect(r.steady20!.pending[0]).toBeLessThanOrEqual(4);
  });

  it('başkasının vuruşundaki top düzeltmesi küçük kalır', () => {
    for (const name of ['steady20', 'spiky20', 'bursty']) expect(r[name]!.ballCorrWindow[1]).toBeLessThan(40);
    expect(r.far100!.ballCorrWindow[1]).toBeLessThan(52);
  });

  it('girdi aktarımı bant genişliğine yük olmaz', () => {
    for (const c of Object.values(r)) expect(c.relayKBps).toBeLessThan(2);
  });
});
