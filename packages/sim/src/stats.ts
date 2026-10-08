import { ballDamping } from './arena';
import { BALL, FIELD, ROLES, STATS, type Role, type ScoredExtra } from './content/rules';
import type { Departed, Game, Player, Scoring, Spell, Stats, Team } from './types';

/**
 * Match stats and the MVP. Built to resist farming: outcomes count, not intent; a scramble produces
 * nothing; goals and assists decide the MVP. The rules in full: docs/design.md "Maç sonu ekranı".
 *
 * Everything hangs on spells: a spell is one player's unbroken time on the ball, from the touch that took
 * it to the latest one. A side owns the ball once STATS.own passes since it got it; a touch that takes
 * the ball off the other side sooner than that starts an unclean spell (a scramble), passed on to
 * teammates, and an unclean spell produces no shot, pass, tackle or assist until the side has owned it.
 * Walls, posts, mines, lava, wind and ducks are never touches, so they never break a chain.
 *
 * Write-only: the game never reads any of this back, so it cannot change how a match plays.
 */

export function newStats(): Stats {
  return {
    touches: 0,
    assists: 0,
    ownGoals: 0,
    shots: 0,
    onTarget: 0,
    saves: 0,
    passes: 0,
    tackles: 0,
    blocks: 0,
    conceded: 0,
    cleanSheet: 0,
    goodCrates: 0,
    badCrates: 0,
    damage: 0,
    absorbed: 0,
    deaths: 0,
    ballAt: -1,
    passLog: {},
  };
}

/** A copy that shares nothing with `s` (prediction steps a clone of the game). */
export const cloneStats = (s: Stats): Stats => ({ ...s, passLog: { ...s.passLog } });

export const newScoring = (): Scoring => ({ spells: [], shot: null, stops: [], tackle: null, gone: [] });

export const cloneScoring = (s: Scoring): Scoring => ({
  spells: s.spells.map((x) => ({ ...x })),
  shot: s.shot && { ...s.shot },
  stops: s.stops.map((x) => ({ ...x })),
  tackle: s.tackle && { ...s.tackle },
  gone: s.gone.map((p) => ({ ...p, stats: cloneStats(p.stats) })),
});

/** Anyone with a line on the results screen: on the pitch now, or left during this match. */
export type Scored = Player | Departed;

const side = (t: Team) => (t === 'red' ? -1 : 1);
const rolesOn = (g: Game) => g.settings.roles !== false;
const keeper = (g: Game, p: Scored) => p.role === 'gk' && rolesOn(g);
/** A player by id, also one who left during this match (their numbers still count). */
const byId = (g: Game, id: string): Scored | undefined =>
  g.players.find((p) => p.id === id) ?? g.scoring.gone.find((p) => p.id === id);

/** Everyone on the results screen: the players, then those who left. */
export const everyone = (g: Game): Scored[] => [...g.players, ...g.scoring.gone];

/**
 * Where the ball, rolling on untouched, crosses the goal line at x = `gx`: its y there, or null when it
 * is moving away or would stop first (it rolls at most speed / (1 − damping)). Walls are ignored.
 */
function crossingY(g: Game, bx: number, by: number, vx: number, vy: number, gx: number): number | null {
  if (vx === 0) return null;
  const t = (gx - bx) / vx;
  if (t <= 0 || t * (1 - ballDamping(g, BALL.damping)) > 1) return null;
  return by + vy * t;
}

/** The side owns the ball at tick `t`: it took it cleanly, or has had it long enough since. */
const owned = (s: Spell, t: number) => s.clean || t - s.since >= STATS.own;

/** In `team`'s own box (the keeper's box). */
const inOwnBox = (team: Team, x: number, y: number) =>
  x * side(team) > FIELD.halfW - ROLES.gk.boxDepth && Math.abs(y) < ROLES.gk.boxHalf;

export interface BallBefore {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * `p` is on the ball this tick: a kick (`kick`, with `pass` when it was bent toward a teammate) or a
 * contact. `before`: the ball just before this touch (a save or a block depends on where it was going).
 * Called only while the ball is live (kickoff or play).
 */
export function touchBall(g: Game, p: Player, kick: { pass: boolean } | null, before: BallBefore): void {
  const sc = g.scoring;
  const t = g.tick;
  const b = g.ball;
  const s = p.stats;
  if (kick || s.ballAt < 0 || t - s.ballAt > STATS.touchGap) s.touches++;
  s.ballAt = t;

  let spell = sc.spells[sc.spells.length - 1];
  if (spell && spell.id === p.id) {
    spell.last = t;
    spell.x = b.x;
    spell.y = b.y;
  } else {
    const prev = spell;
    // The ball changes feet: the shot in flight has its outcome.
    if (sc.shot && !sc.shot.done) shotOutcome(g, p, before);
    const mate = !!prev && prev.team === p.team;
    spell = {
      id: p.id,
      team: p.team,
      first: t,
      last: t,
      // A teammate's touch carries on the side's possession, scramble and all.
      since: mate ? prev.since : t,
      clean: mate ? prev.clean : !prev || t - prev.since >= STATS.own,
      x: b.x,
      y: b.y,
      kickAt: -1,
      shot: false,
    };
    sc.spells.push(spell);
    if (sc.spells.length > STATS.spells) sc.spells.shift();
    if (mate) completedPass(g, prev, p);
    else if (prev) {
      // Any touch by the other side ends a ball won but not yet kept.
      if (sc.tackle && sc.tackle.team !== p.team) sc.tackle = null;
      // A tackle takes it off an opponent who owned it and was on it just now: at their feet, not a
      // loose ball, and not one they just kicked (stopping a shot or cutting out a pass is no tackle).
      if (
        spell.clean &&
        t - prev.last <= STATS.touchGap &&
        (prev.kickAt < 0 || t - prev.kickAt > STATS.touchGap)
      )
        sc.tackle = { by: p.id, team: p.team, at: t };
    }
  }
  // Kept even when a contact follows in the same step: it was a kick of theirs.
  if (kick) spell.kickAt = t;
  // The kickoff itself is never a shot.
  if (kick && !kick.pass && g.phase === 'play') countShot(g, p, spell);
}

/** A kick from an owned ball, within STATS.shotRange of the goal line, hard and at the opponents' goal:
 * a shot (one per spell). */
function countShot(g: Game, p: Player, spell: Spell): void {
  const b = g.ball;
  const gx = -side(p.team) * FIELD.halfW;
  if (spell.shot || !owned(spell, g.tick) || Math.abs(gx - b.x) > STATS.shotRange) return;
  if (b.vx * b.vx + b.vy * b.vy < STATS.shotSpeed * STATS.shotSpeed) return;
  const y = crossingY(g, b.x, b.y, b.vx, b.vy, gx);
  if (y === null || Math.abs(y) >= STATS.shotBand) return;
  spell.shot = true;
  p.stats.shots++;
  g.scoring.shot = { by: p.id, team: p.team, done: false, on: false };
}

/**
 * The first touch by someone else after a shot. On target when an opponent stopped a ball still coming
 * hard and going in: their keeper (a save) or anyone else in their box (a block); either stands once no
 * goal follows within STATS.saveHold. Anything else (a teammate, a defender far out, a ball going wide or
 * rolling to a stop) leaves it a shot off target.
 */
function shotOutcome(g: Game, p: Player, before: BallBefore): void {
  const sc = g.scoring;
  const shot = sc.shot!;
  shot.done = true;
  if (p.team === shot.team) return;
  if (before.vx * before.vx + before.vy * before.vy < STATS.shotArrive * STATS.shotArrive) return;
  const y = crossingY(g, before.x, before.y, before.vx, before.vy, side(p.team) * FIELD.halfW);
  if (y === null || Math.abs(y) >= FIELD.goalHalf) return;
  if (keeper(g, p)) sc.stops.push({ by: p.id, kind: 'save', at: g.tick });
  else if (inOwnBox(p.team, before.x, before.y)) sc.stops.push({ by: p.id, kind: 'block', at: g.tick });
  else return;
  shot.on = true;
  const shooter = byId(g, shot.by);
  if (shooter) shooter.stats.onTarget++;
}

/** Saves and blocks for which `stands` holds are credited and leave the waiting list; `drop` ones go
 * without credit. */
function settleStops(g: Game, stands: (by: Scored | undefined, at: number) => boolean, drop = false) {
  const sc = g.scoring;
  sc.stops = sc.stops.filter((stop) => {
    const p = byId(g, stop.by);
    if (!stands(p, stop.at)) return true;
    if (p && !drop) p.stats[stop.kind === 'save' ? 'saves' : 'blocks']++;
    return false;
  });
}

/** `prev` (a teammate's spell) ended in `to`'s touch: a completed pass if the side owned the ball and it
 * travelled far enough. The same pair counts once per STATS.passRepeat. */
function completedPass(g: Game, prev: Spell, to: Player): void {
  const t = g.tick;
  if (prev.id === to.id || !owned(prev, t)) return;
  const from = byId(g, prev.id);
  if (!from) return;
  const dx = g.ball.x - prev.x;
  const dy = g.ball.y - prev.y;
  if (dx * dx + dy * dy < STATS.passMin * STATS.passMin) return;
  const log = from.stats.passLog;
  const at = log[to.id];
  if (at !== undefined && t - at < STATS.passRepeat) return;
  from.stats.passes++;
  log[to.id] = t;
}

/** Every tick: saves, blocks and tackles whose time has come (the final whistle settles them itself). */
export function updateScoring(g: Game): void {
  if (g.phase === 'over') return;
  const sc = g.scoring;
  const t = g.tick;
  if (sc.stops.length) settleStops(g, (_, at) => t - at >= STATS.saveHold);
  if (sc.tackle && t - sc.tackle.at >= STATS.own) {
    const p = byId(g, sc.tackle.by);
    if (p) p.stats.tackles++;
    sc.tackle = null;
  }
}

/**
 * A goal for `scorer` (the ball is in the net). It goes to whoever touched it last, except when it went
 * in off the defending side without a kick of theirs: within STATS.deflect of the attacker's last touch
 * (a shot that hit someone standing in the way, or two of them), or off defenders who never had it under
 * control (a scramble). Then it stays the attacker's goal. An own goal is the defending side putting it
 * in themselves: a kick of theirs, or a ball they had under control. Nobody touched it since the kickoff:
 * nobody's.
 */
export function scoreGoal(g: Game, scorer: Team): void {
  const sc = g.scoring;
  const { spells } = sc;
  let i = spells.length - 1;
  let j = i;
  while (j >= 0 && spells[j]!.team !== scorer) j--;
  if (j >= 0 && j < i) {
    const after = spells.slice(j + 1);
    const noKick = after.every((s) => s.kickAt < 0);
    const quick = g.tick - spells[j]!.last < STATS.deflect;
    const loose = after.every((s, k) => !owned(s, after[k + 1]?.first ?? g.tick));
    if (noKick && (quick || loose)) i = j;
  }
  const spell = spells[i];
  const who = spell ? byId(g, spell.id) : undefined;
  if (who && who.team === scorer) {
    who.goals++;
    // Every goal is a shot on target: the shot of this spell (once), or else one more (a dribble, a
    // tap-in).
    if (!spell!.shot) {
      who.stats.shots++;
      who.stats.onTarget++;
    } else if (sc.shot && sc.shot.by === who.id && !sc.shot.on) who.stats.onTarget++;
    assist(g, i);
  } else if (who) who.stats.ownGoals++;
  const conceding: Team = scorer === 'red' ? 'blue' : 'red';
  for (const p of g.players) if (p.team === conceding && keeper(g, p)) p.stats.conceded++;
  // Saves and blocks just before stand, unless it was that side that let one in.
  settleStops(g, (p) => !p || p.team === conceding, true);
  settleStops(g, () => true);
  // A ball won and put straight in counts as kept.
  if (sc.tackle && sc.tackle.team === scorer) {
    const p = byId(g, sc.tackle.by);
    if (p) p.stats.tackles++;
  }
  clearScoring(g);
}

/** The scorer's spell (`spells[i]`) came straight from a teammate's spell with the ball owned, at most
 * STATS.assistGap later. */
function assist(g: Game, i: number): void {
  const { spells } = g.scoring;
  const own = spells[i];
  const prev = spells[i - 1];
  if (!own || !prev || prev.team !== own.team || prev.id === own.id) return;
  if (own.first - prev.last > STATS.assistGap || !owned(prev, own.first)) return;
  const by = byId(g, prev.id);
  if (by) by.stats.assists++;
}

/** Kickoff: nobody has the ball and nothing is waiting (those who left this match stay listed). */
export function clearScoring(g: Game): void {
  g.scoring = { ...newScoring(), gone: g.scoring.gone };
}

/** The final whistle: saves and blocks still waiting stand; keepers whose side let in nothing keep a
 * clean sheet. */
export function finishScoring(g: Game): void {
  const sc = g.scoring;
  settleStops(g, () => true);
  if (sc.tackle && g.tick - sc.tackle.at >= STATS.own) {
    const p = byId(g, sc.tackle.by);
    if (p) p.stats.tackles++;
  }
  for (const p of g.players)
    if (keeper(g, p) && g.score[p.team === 'red' ? 1 : 0] === 0) p.stats.cleanSheet = 1;
  clearScoring(g);
}

/** `p` is leaving: their numbers stay on the results screen (and count for the MVP) until the next
 * match. */
export function departed(g: Game, p: Player): void {
  if (g.scoring.gone.some((o) => o.id === p.id)) return;
  const { id, name, team, role, bot, goals, stats } = p;
  g.scoring.gone.push({ id, name, team, role, bot, goals, stats: cloneStats(stats) });
}

/** `p` is back in the same match: they carry on with their numbers. */
export function rejoined(g: Game, p: Player): void {
  const i = g.scoring.gone.findIndex((o) => o.id === p.id);
  if (i < 0) return;
  const old = g.scoring.gone[i]!;
  g.scoring.gone.splice(i, 1);
  p.goals = old.goals;
  p.stats = old.stats;
}

/** The role a player is scored as: their role, or `none` with roles off. */
const scoredRole = (g: Game, p: Scored): Role => (rolesOn(g) ? p.role : 'none');

/** The role's extra points before the cap (shot on target, passes, tackles and blocks, saves...). */
function extras(g: Game, p: Scored): number {
  const pts = STATS.points[scoredRole(g, p)];
  let n = 0;
  for (const k of Object.keys(pts) as Array<keyof typeof pts>)
    if (k !== 'goal' && k !== 'assist') n += (pts[k] ?? 0) * p.stats[k as ScoredExtra];
  return n;
}

/** MVP points: goals and assists by role, the role's extras (capped), own goals, a keeper's goals let in. */
export function mvpScore(g: Game, p: Scored): number {
  const role = scoredRole(g, p);
  const pts = STATS.points[role];
  const s = p.stats;
  return (
    pts.goal * p.goals +
    pts.assist * s.assists +
    Math.min(STATS.extrasCap, extras(g, p)) +
    STATS.ownGoal * s.ownGoals +
    (role === 'gk' ? STATS.conceded * s.conceded : 0)
  );
}

/**
 * The match MVP (those who left count too): most points; a tie goes to the winning side, then more
 * goals, then more assists, then whoever is listed first. Null with nobody to choose.
 */
export function mvp(g: Game): string | null {
  const won: Team | null = g.score[0] > g.score[1] ? 'red' : g.score[1] > g.score[0] ? 'blue' : null;
  let best: Scored | null = null;
  for (const p of everyone(g)) {
    if (!best) {
      best = p;
      continue;
    }
    const better =
      mvpScore(g, p) - mvpScore(g, best) ||
      Number(p.team === won) - Number(best.team === won) ||
      p.goals - best.goals ||
      p.stats.assists - best.stats.assists;
    if (better > 0) best = p;
  }
  return best?.id ?? null;
}
