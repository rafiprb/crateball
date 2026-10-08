import { STATE_SCALE } from './content/rules';
import type { Game } from './types';

/** A number as snapshots carry it: whole numbers as they are, the rest rounded to 1/STATE_SCALE (−0 as 0). */
const num = (v: number) => (Number.isInteger(v) ? v + 0 : Math.round(v * STATE_SCALE) / STATE_SCALE + 0);

function walk(o: Record<string, unknown> | unknown[]): void {
  if (Array.isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (typeof v === 'number') o[i] = num(v);
      else if (v !== null && typeof v === 'object') walk(v as Record<string, unknown>);
    }
    return;
  }
  for (const k in o) {
    const v = o[k];
    if (typeof v === 'number') o[k] = num(v);
    else if (v !== null && typeof v === 'object') walk(v as Record<string, unknown>);
  }
}

/**
 * Rounds every number in the state the way a snapshot does, in place. The server runs it after every
 * step (and on a fresh match), so the state it goes on from is exactly the state its clients receive:
 * prediction from a snapshot then takes the same branches as the server (the ball's sub-step count, a
 * duck's turn, a contact at the edge) instead of drifting by the rounding.
 */
export function canonicalise(g: Game): void {
  walk(g as unknown as Record<string, unknown>);
}
