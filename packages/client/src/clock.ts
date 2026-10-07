import { TICK_HZ } from '@crateball/sim';

const TICK_MS = 1000 / TICK_HZ;
/** Tick period change per tick of `lead` feedback, and its cap: at most 3% slower, which nobody sees but
 * sheds a tick of surplus lead in about half a second. */
const RATE_PER_TICK = 0.01;
const MAX_RATE = 0.03;

/**
 * The client's tick clock, kept in step with the server's input queue (clock sync).
 *
 * Every input waits on the server until its tick comes. Waiting more than the link's jitter needs only
 * makes us predict further ahead, and every correction (above all someone else's kick) grows with how far
 * ahead we predict. The server measures how many of our inputs it has to spare and reports the surplus as
 * `lead` in each snapshot; we stretch our tick period by a few percent until it is back to 0. The world
 * never jumps (dropping a queued input instead would shift it back a whole tick): it just runs a little
 * slower for a second or two. Arriving late needs nothing here: the server stands in for missing ticks.
 */
export function createTickClock() {
  let lead = 0;
  return {
    /** Latest `lead` from a snapshot; 0 when not in a match. */
    feedback(l: number) {
      lead = l;
    },
    /** Length (ms) of the next local tick. */
    tickMs(): number {
      return TICK_MS * (1 + Math.max(0, Math.min(MAX_RATE, lead * RATE_PER_TICK)));
    },
  };
}
