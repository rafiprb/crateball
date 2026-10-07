/**
 * Prints the netcode measurement for the current code (several seeds, averaged per client).
 *   pnpm netsim [seconds] [seeds] [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { DEFAULT_CLIENTS, runSim, type ClientReport } from './netsim';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const out = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const seconds = Number(args[0] ?? 180);
const seeds = Number(args[1] ?? 3);

const runs: ClientReport[][] = [];
for (let s = 1; s <= seeds; s++) runs.push(runSim({ seed: s * 7919, seconds, clients: DEFAULT_CLIENTS }));

/** Element-wise mean of every numeric field over the seeds. */
const avg = (rs: ClientReport[]): ClientReport => {
  const first = rs[0]!;
  const mean = (get: (r: ClientReport) => number) =>
    Math.round((rs.reduce((a, r) => a + get(r), 0) / rs.length) * 10) / 10;
  const out: Record<string, unknown> = { name: first.name };
  for (const [k, v] of Object.entries(first)) {
    if (k === 'name') continue;
    out[k] = Array.isArray(v)
      ? v.map((_, i) => mean((r) => (r[k as keyof ClientReport] as number[])[i]!))
      : mean((r) => r[k as keyof ClientReport] as number);
  }
  return out as unknown as ClientReport;
};
const table = DEFAULT_CLIENTS.map((_, i) => avg(runs.map((r) => r[i]!)));
const fmt = (v: unknown) => (Array.isArray(v) ? v.join(' / ') : String(v));
const keys = Object.keys(table[0]!).filter((k) => k !== 'name');
console.log(['metric', ...table.map((r) => r.name)].join('\t'));
for (const k of keys) console.log([k, ...table.map((r) => fmt(r[k as keyof ClientReport]))].join('\t'));
if (out) writeFileSync(out, JSON.stringify(table, null, 2));
