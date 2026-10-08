import { addPlayer, createGame, newStats, type Game, type Role, type Team } from '@crateball/sim';

/** [name, team, bot, role, goals, own goals, assists, shots, on target, passes, tackles, blocks, saves,
 * good crates, bad crates, damage, absorbed, deaths] */
type Row = [string, Team, boolean, Role, ...number[]];
const ROWS: Row[] = [
  ['Deniz', 'red', false, 'fwd', 3, 0, 1, 7, 5, 2, 0, 0, 0, 3, 1, 4, 1, 1],
  ['Bot 1', 'red', true, 'gk', 0, 0, 0, 0, 0, 3, 0, 0, 4, 0, 1, 0, 0, 0],
  ['Ece', 'red', false, 'mid', 2, 0, 1, 4, 2, 9, 1, 0, 0, 2, 2, 1, 0, 2],
  ['Kaan', 'blue', false, 'fwd', 2, 0, 0, 8, 4, 1, 0, 0, 0, 4, 0, 3, 2, 1],
  ['Bot 2', 'blue', true, 'gk', 0, 0, 1, 0, 0, 2, 0, 0, 5, 0, 0, 0, 0, 1],
  ['Mert', 'blue', false, 'def', 0, 1, 1, 1, 0, 3, 4, 2, 0, 1, 1, 0, 0, 2],
];
let shown = 0;

/** Dev only (`window.__game.cmd('results', 'blue')`): a finished 5–3 match with made-up numbers; the
 * first player of the winning side is you. */
export function demoResults(me: string | null, winner: Team = 'red'): Game {
  const flip = (t: Team): Team => (winner === 'red' ? t : t === 'red' ? 'blue' : 'red');
  const g = createGame(1);
  ROWS.forEach(([name, team, bot, role, ...n], i) => {
    const p = addPlayer(g, i === 0 && me ? me : `demo-${i}`, name, flip(team), bot);
    const [
      goals,
      ownGoals,
      assists,
      shots,
      onTarget,
      passes,
      tackles,
      blocks,
      saves,
      good,
      bad,
      dmg,
      abs,
      deaths,
    ] = n.map((v) => v ?? 0);
    p.role = role;
    p.goals = goals!;
    p.stats = {
      ...newStats(),
      ownGoals: ownGoals!,
      assists: assists!,
      shots: shots!,
      onTarget: onTarget!,
      passes: passes!,
      tackles: tackles!,
      blocks: blocks!,
      saves: saves!,
      conceded: role === 'gk' ? (team === 'red' ? 3 : 5) : 0,
      goodCrates: good!,
      badCrates: bad!,
      damage: dmg!,
      absorbed: abs!,
      deaths: deaths!,
    };
  });
  g.score = winner === 'red' ? [5, 3] : [3, 5];
  g.phase = 'over';
  // A different "match" every call, so the screen opens again.
  g.tick = ++shown;
  g.phaseT = 0;
  return g;
}
