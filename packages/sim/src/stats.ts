import type { Game, Player, Stats, Team } from './types';

export function newStats(): Stats {
  return {
    touches: 0,
    shots: 0,
    onTarget: 0,
    saves: 0,
    goodCrates: 0,
    badCrates: 0,
    damage: 0,
    absorbed: 0,
    deaths: 0,
    ballAt: -1,
    shot: 0,
  };
}

/** MVP points: goals + damage dealt + saves − deaths. */
export const mvpScore = (p: Player): number => p.goals + p.stats.damage + p.stats.saves - p.stats.deaths;

/**
 * The match MVP: most MVP points; a tie goes to the winning side, then to more touches, then to whoever
 * is listed first. Null with nobody on the pitch.
 */
export function mvp(g: Game): string | null {
  const won: Team | null = g.score[0] > g.score[1] ? 'red' : g.score[1] > g.score[0] ? 'blue' : null;
  let best: Player | null = null;
  for (const p of g.players) {
    if (!best) {
      best = p;
      continue;
    }
    const better =
      mvpScore(p) - mvpScore(best) ||
      Number(p.team === won) - Number(best.team === won) ||
      p.stats.touches - best.stats.touches;
    if (better > 0) best = p;
  }
  return best?.id ?? null;
}
