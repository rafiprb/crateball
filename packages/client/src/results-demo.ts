import { addPlayer, createGame, newStats, type Game, type Role, type Team } from '@crateball/sim';

/** [name, team, bot, role, goals, touches, shots, on target, saves, good, bad, damage, absorbed, deaths] */
type Row = [string, Team, boolean, Role, ...number[]];
const ROWS: Row[] = [
  ['Deniz', 'red', false, 'fwd', 3, 41, 9, 6, 0, 3, 1, 4, 1, 1],
  ['Bot 1', 'red', true, 'gk', 0, 22, 0, 0, 5, 0, 1, 0, 0, 0],
  ['Ece', 'red', false, 'mid', 2, 38, 5, 3, 0, 2, 2, 1, 0, 2],
  ['Kaan', 'blue', false, 'fwd', 2, 35, 8, 4, 0, 4, 0, 3, 2, 1],
  ['Bot 2', 'blue', true, 'gk', 0, 18, 0, 0, 4, 0, 0, 0, 0, 1],
  ['Mert', 'blue', false, 'def', 1, 27, 2, 1, 0, 1, 1, 0, 0, 2],
];
let shown = 0;

/** Dev only (`window.__game.cmd('results', 'blue')`): a finished 5–3 match with made-up numbers; the
 * first player of the winning side is you. */
export function demoResults(me: string | null, winner: Team = 'red'): Game {
  const flip = (t: Team): Team => (winner === 'red' ? t : t === 'red' ? 'blue' : 'red');
  const g = createGame(1);
  ROWS.forEach(
    ([name, team, bot, role, goals, touches, shots, onTarget, saves, good, bad, dmg, abs, deaths], i) => {
      const p = addPlayer(g, i === 0 && me ? me : `demo-${i}`, name, flip(team), bot);
      p.role = role;
      p.goals = goals ?? 0;
      p.stats = {
        ...newStats(),
        touches: touches ?? 0,
        shots: shots ?? 0,
        onTarget: onTarget ?? 0,
        saves: saves ?? 0,
        goodCrates: good ?? 0,
        badCrates: bad ?? 0,
        damage: dmg ?? 0,
        absorbed: abs ?? 0,
        deaths: deaths ?? 0,
      };
    },
  );
  g.score = winner === 'red' ? [5, 3] : [3, 5];
  g.phase = 'over';
  // A different "match" every call, so the screen opens again.
  g.tick = ++shown;
  g.phaseT = 0;
  return g;
}
