import { MATCH, TICK_HZ, everyone, mvp, mvpScore, type Game, type Scored, type Team } from '@crateball/sim';
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
  /** Leaving the room: the next room's matches are new ones even at the same tick. */
  forget(): void;
  /** The match's goals can be watched (`count` 0: not, or not yet): a button on the screen, now or when it
   * comes up. */
  goals(count: number, watch: () => void): void;
  /** While the goals are being watched the countdown stands still. */
  hold(on: boolean): void;
}

type Cell = Node | string;

/** Column header and its tooltip (what a pair "a/b" in it means). `roles`: only shown with positions on. */
const COLUMNS: Array<[string, string, boolean?]> = [
  [
    'Points',
    "MVP points: goals and assists (worth more or less by position) plus the position's own play, at most 3",
  ],
  ['Goals', 'Goals scored / own goals'],
  ['Assists', 'The pass the goal came from (the scorer got it straight from you, within 3 s)'],
  ['Shots', 'Shots at goal / of them a goal, a save or a block'],
  ['Passes', 'Passes that reached a teammate'],
  ['Defence', 'Balls won off an opponent / shots blocked in your box'],
  ['Saves', 'Keeper: shots stopped', true],
  ['Crates', 'Crates opened: helpful / harmful'],
  ['Damage', 'Damage dealt to opponents / damage your shield took'],
  ['Deaths', 'Times knocked out'],
];

/** 2.25 → "2.25", 3 → "3", −0.5 → "−0.5". */
const points = (n: number) => (n < 0 ? '−' : '') + String(Math.round(Math.abs(n) * 100) / 100);

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
  /** The match on screen (or closed): its number and the tick of its final whistle. */
  let shownFor: string | null = null;
  let closeAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Time left when the countdown was put on hold (null: running). */
  let held: number | null = null;
  let goals: { count: number; watch: () => void } = { count: 0, watch: () => {} };
  const goalsBtn = h('button', { type: 'button', class: 'goalsbtn', onclick: () => goals.watch() });
  const showGoals = () => {
    goalsBtn.hidden = goals.count === 0;
    goalsBtn.replaceChildren('▶ Watch the goals', h('span', { class: 'count' }, String(goals.count)));
  };

  /** Everything behind the screen while it is up: out of reach of Tab, clicks and Enter. */
  let behind: Element[] = [];
  const hide = () => {
    if (timer) clearInterval(timer);
    timer = null;
    held = null;
    root.hidden = true;
    for (const el of behind) el.removeAttribute('inert');
    behind = [];
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) hide();
  });

  const row = (g: Game, p: Scored, me: string | null, best: string | null, roles: boolean, left: boolean) => {
    const s = p.stats;
    const pts = mvpScore(g, p);
    const all: Array<[Cell, boolean]> = [
      [h('b', {}, points(pts)), pts === 0],
      [pair(p.goals, s.ownGoals, '', s.ownGoals ? 'bad' : ''), p.goals + s.ownGoals === 0],
      [String(s.assists), s.assists === 0],
      [pair(s.shots, s.onTarget), s.shots === 0],
      [String(s.passes), s.passes === 0],
      [pair(s.tackles, s.blocks), s.tackles + s.blocks === 0],
      [String(s.saves), s.saves === 0],
      [pair(s.goodCrates, s.badCrates, 'good', 'bad'), s.goodCrates + s.badCrates === 0],
      [pair(s.damage, s.absorbed), s.damage + s.absorbed === 0],
      [String(s.deaths), s.deaths === 0],
    ];
    const cells = all.filter((_, i) => roles || !COLUMNS[i]![2]);
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
          left && h('span', { class: 'tag', title: 'Left during the match' }, 'LEFT'),
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
    forget() {
      shownFor = null;
      goals = { count: 0, watch: () => {} };
      showGoals();
    },
    goals(count, watch) {
      goals = { count, watch };
      showGoals();
    },
    hold(on) {
      if (root.hidden) return;
      if (on && held === null) held = closeAt - performance.now();
      else if (!on && held !== null) {
        closeAt = performance.now() + held;
        held = null;
      }
    },
    show(g, me) {
      const end = `${g.matches}:${g.tick - g.phaseT}`;
      if (g.phase !== 'over' || shownFor === end) return;
      shownFor = end;
      const gone = new Set(g.scoring.gone.map((p) => p.id));
      const [red, blue] = g.score;
      const won: Team | null = red > blue ? 'red' : blue > red ? 'blue' : null;
      const best = mvp(g);
      const roles = g.settings.roles !== false;
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
                  ...COLUMNS.filter((c) => roles || !c[2]).map(([label, title]) => h('th', { title }, label)),
                ),
              ),
              h(
                'tbody',
                {},
                ...everyone(g)
                  .filter((p) => p.team === t)
                  .map((p) => row(g, p, me, best, roles, gone.has(p.id))),
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
          h('footer', {}, back, goalsBtn, countdown),
        ),
      );
      root.hidden = false;
      for (const el of behind) el.removeAttribute('inert');
      // Dialogs (the goals popup) keep themselves modal above it.
      behind = [...parent.children].filter(
        (el) => el !== root && !el.hasAttribute('inert') && !(el instanceof HTMLDialogElement),
      );
      for (const el of behind) el.setAttribute('inert', '');
      // Whatever had the keyboard (the chat box, mid-message) lets go: Enter and Esc are the screen's now.
      if (document.activeElement instanceof HTMLElement && !root.contains(document.activeElement))
        document.activeElement.blur();
      back.focus();
      showGoals();
      closeAt = performance.now() + (MATCH.resultsShow / TICK_HZ) * 1000;
      held = null;
      const tick = () => {
        if (held !== null) return;
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
