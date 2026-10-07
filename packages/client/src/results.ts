import { MATCH, TICK_HZ, mvp, type Game, type Player, type Team } from '@crateball/sim';
import { ROLE_LABEL, h } from './ui';

/**
 * The results screen: the winner, then every player's numbers per team, with the MVP marked. It comes up
 * at the final whistle and stays on top of the lobby until the player closes it or `MATCH.resultsShow`
 * runs out, so anyone can go straight back to the lobby while the others keep reading.
 */
export interface Results {
  readonly visible: boolean;
  /** A snapshot of the finished match. Repeats for the same match are ignored, so it does not come back
   * after being closed while the room is still on its final whistle. */
  show(g: Game, me: string | null): void;
  hide(): void;
}

type Cell = Node | string;

/** Column header, the line under it, and its tooltip. */
const COLUMNS: Array<[string, string, string]> = [
  ['Goals', '', 'Goals scored'],
  ['Touches', 'you / all', 'Your touches of the ball / all touches in the match'],
  ['Shots', 'all / on target', 'Shots at goal / of them heading inside the posts'],
  ['Saves', '', 'Keeper: balls stopped on their way into the goal'],
  ['Crates', 'good / bad', 'Crates opened: helpful / harmful'],
  ['Damage', 'dealt / shielded', 'Damage dealt to opponents / damage your shield took'],
  ['Deaths', '', 'Times knocked out'],
];

const TEAM_NAME: Record<Team, string> = { red: 'Red', blue: 'Blue' };

/** "a/b" with the slash dimmed; classes colour either side. */
const pair = (a: number, b: number, aCls = '', bCls = ''): Cell =>
  h(
    'span',
    {},
    h('span', { class: aCls }, String(a)),
    h('span', { class: 'of' }, '/'),
    h('span', { class: bCls }, String(b)),
  );

export function createResults(parent: HTMLElement = document.body): Results {
  const root = h('div', { id: 'results', hidden: true });
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', 'results-title');
  parent.append(root);
  let shownFor: number | null = null;
  let closeAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const hide = () => {
    if (timer) clearInterval(timer);
    timer = null;
    root.hidden = true;
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) hide();
  });

  const row = (p: Player, total: number, me: string | null, best: string | null, roles: boolean) => {
    const s = p.stats;
    const cells: Array<[Cell, boolean]> = [
      [String(p.goals), p.goals === 0],
      [pair(s.touches, total, '', 'of'), s.touches === 0],
      [pair(s.shots, s.onTarget), s.shots === 0],
      [String(s.saves), s.saves === 0],
      [pair(s.goodCrates, s.badCrates, 'good', 'bad'), s.goodCrates + s.badCrates === 0],
      [pair(s.damage, s.absorbed), s.damage + s.absorbed === 0],
      [String(s.deaths), s.deaths === 0],
    ];
    return h(
      'tr',
      { class: p.id === me ? 'me' : '' },
      h(
        'td',
        { class: 'who' },
        h(
          'div',
          {},
          roles && h('span', { class: 'role' }, ROLE_LABEL[p.role]),
          h('span', { class: 'pname' }, p.name),
          p.id === best && h('span', { class: 'mvp', title: 'Most valuable player' }, 'MVP'),
          p.bot && h('span', { class: 'tag' }, 'BOT'),
        ),
      ),
      ...cells.map(([c, zero]) =>
        h('td', { class: zero ? 'zero' : '' }, typeof c === 'string' ? h('span', {}, c) : c),
      ),
    );
  };

  return {
    get visible() {
      return !root.hidden;
    },
    hide,
    show(g, me) {
      const end = g.tick - g.phaseT;
      if (g.phase !== 'over' || shownFor === end) return;
      shownFor = end;
      const [red, blue] = g.score;
      const won: Team | null = red > blue ? 'red' : blue > red ? 'blue' : null;
      const best = mvp(g);
      const roles = g.settings.roles !== false;
      const total = g.players.reduce((n, p) => n + p.stats.touches, 0);
      // Same wording as the pitch banner: the clock ran out (or a golden goal) vs. the score limit.
      const why = g.settings.minutes > 0 && g.clock === 0 ? 'FULL TIME' : `FIRST TO ${g.settings.scoreLimit}`;
      const team = (t: Team) =>
        h(
          'section',
          { class: `rteam ${t}` },
          h(
            'header',
            {},
            h('h3', {}, TEAM_NAME[t]),
            h('span', { class: 'rscore' }, String(g.score[t === 'red' ? 0 : 1])),
            t === won && h('span', { class: 'tag win' }, 'WINNER'),
          ),
          h(
            'div',
            { class: 'rtable' },
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', { class: 'who' }, 'Player'),
                  ...COLUMNS.map(([label, sub, title]) =>
                    h('th', { title }, label, sub && h('small', {}, sub)),
                  ),
                ),
              ),
              h(
                'tbody',
                {},
                ...g.players.filter((p) => p.team === t).map((p) => row(p, total, me, best, roles)),
              ),
            ),
          ),
        );
      const countdown = h('span', { class: 'countdown' });
      const back = h('button', { type: 'button', class: 'primary', onclick: hide }, 'Back to lobby');
      root.className = won ?? '';
      root.replaceChildren(
        h(
          'div',
          { class: 'results' },
          h('h1', { id: 'results-title' }, won ? `${won.toUpperCase()} WINS!` : 'FULL TIME'),
          h('p', { class: 'why' }, `${red} – ${blue}  ·  ${why}`),
          team('red'),
          team('blue'),
          h('footer', {}, back, countdown),
        ),
      );
      root.hidden = false;
      closeAt = performance.now() + (MATCH.resultsShow / TICK_HZ) * 1000;
      const tick = () => {
        const left = Math.ceil((closeAt - performance.now()) / 1000);
        if (left <= 0) hide();
        else countdown.textContent = `Closes in ${left} s`;
      };
      tick();
      if (timer) clearInterval(timer);
      timer = setInterval(tick, 250);
    },
  };
}
