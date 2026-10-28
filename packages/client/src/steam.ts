import { everyone, winner, type Game } from '@crateball/sim';
import { COUNTERS, reached, type Counter } from './achievements';

/**
 * Steam achievements from the desktop build (main app): at the final whistle the match's numbers are
 * added to the player's Steam stats, then every achievement the totals have reached is unlocked. The
 * desktop wrapper does the Steam side (`desktop/src-tauri/src/steam.rs`); in a browser, or when Steam is
 * not there, nothing happens. Trusts the client: a free game, and Steam caps how much a stat may jump.
 */

/**
 * What this match adds for `me`, or null when it does not count: `me` was not on the pitch at the
 * final whistle, or nobody on the other side was human (a match against bots alone counts for nothing).
 * Saves are keepers' only already (`stats.ts`).
 */
export function matchCounts(g: Game, me: string): Record<Counter, number> | null {
  if (g.phase !== 'over') return null;
  const p = g.players.find((x) => x.id === me);
  if (!p || p.bot) return null;
  // Also a human who left during the match: they played it.
  if (!everyone(g).some((o) => o.team !== p.team && !o.bot)) return null;
  return { goals: p.goals, saves: p.stats.saves, passes: p.stats.passes, wins: winner(g) === p.team ? 1 : 0 };
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const tauri = (): Invoke | undefined =>
  (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;

/** The last match recorded: a reload or a repeated final snapshot never counts it twice. */
const LAST_KEY = 'steamMatch';
/** Being recorded right now (the same final whistle can arrive again meanwhile). */
const inFlight = new Set<string>();

const recorded = (key: string) => {
  try {
    return localStorage.getItem(LAST_KEY) === key;
  } catch {
    return false;
  }
};
const markRecorded = (key: string) => {
  try {
    localStorage.setItem(LAST_KEY, key);
  } catch {
    // No storage: the results screen already shows a match once per page.
  }
};

/**
 * Records a finished match (`room`: its code) for `me`. Resolves to the achievements Steam newly
 * unlocked, empty when there is no Steam or the match does not count. Never throws.
 */
export async function recordMatch(g: Game, me: string, room: string, invoke = tauri()): Promise<string[]> {
  if (!invoke) return [];
  const counts = matchCounts(g, me);
  if (!counts) return [];
  const key = `${room}:${g.matches}:${g.tick - g.phaseT}`;
  if (recorded(key) || inFlight.has(key)) return [];
  // Every counter, zeros too: Steam answers all four totals, so an unlock missed before (any counter)
  // is made up for now.
  const add: Record<string, number> = {};
  for (const c of Object.keys(COUNTERS) as Counter[]) add[COUNTERS[c]] = counts[c];
  inFlight.add(key);
  try {
    const stats = (await invoke('steam_add_stats', { add })) as Record<string, number>;
    // The stats are in: from here on a reload must not add them again.
    markRecorded(key);
    const totals: Partial<Record<Counter, number>> = {};
    for (const c of Object.keys(COUNTERS) as Counter[]) totals[c] = stats[COUNTERS[c]];
    return (await invoke('steam_unlock', { names: reached(totals) })) as string[];
  } catch {
    // No Steam (started outside it, or the demo), or Steam said no: nothing was added, a reload may
    // try this match again.
    return [];
  } finally {
    inFlight.delete(key);
  }
}
