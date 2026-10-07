import {
  BOT,
  DEFAULT_SETTINGS,
  addPlayer,
  cloneGame,
  createGame,
  defaultWeights,
  newArenaPlan,
  restartMatch,
  step,
  type ArenaKind,
  type Game,
  type ItemKind,
  type Settings,
} from '@crateball/sim';
import { createEventTracker, type GameEvent } from '../events';
import type { Predictor } from '../predict';

// Trailer bots play at full speed (in rooms they are a bit slower than people on purpose).
BOT.accelMul = 1;

const NAMES = { red: ['Ace', 'Mango', 'Turbo'], blue: ['Pixel', 'Noodle', 'Rocket'] } as const;

export interface MatchSpec {
  seed: number;
  arena: ArenaKind;
  /** Only these items come out of crates (equal shares); missing = the standard mix. */
  items?: ItemKind[];
  chaos?: boolean;
}

export function newMatch(spec: MatchSpec): Game {
  const weights = defaultWeights();
  if (spec.items)
    for (const k of Object.keys(weights) as ItemKind[]) weights[k] = spec.items.includes(k) ? 1 : 0;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    minutes: 0,
    scoreLimit: 99,
    crates: spec.chaos ? 'chaos' : 'normal',
    weights,
    arenas: [spec.arena],
  };
  const g = createGame(spec.seed, settings);
  for (const team of ['red', 'blue'] as const)
    NAMES[team].forEach((name, i) => addPlayer(g, `${team}-${i}`, name, team, true));
  newArenaPlan(g);
  restartMatch(g);
  return g;
}

export interface Moment {
  tick: number;
  events: GameEvent[];
}

/** Plays a match headless and lists every tick that produced an event worth showing. */
export function scan(spec: MatchSpec, ticks: number): Moment[] {
  const g = newMatch(spec);
  const track = createEventTracker();
  const out: Moment[] = [];
  track(g);
  for (let i = 0; i < ticks; i++) {
    step(g);
    const ev = track(g).filter(
      (e) => e.type === 'goal' || e.type === 'item' || e.type === 'shot' || e.type === 'hit',
    );
    if (ev.length) out.push({ tick: g.tick, events: ev });
  }
  return out;
}

/**
 * A replayed match as the renderer's Predictor: no network, positions interpolated between the last
 * two ticks so slow motion stays smooth.
 */
export function replay(spec: MatchSpec, fromTick: number) {
  const g = newMatch(spec);
  while (g.tick < fromTick) step(g);
  let prev = cloneGame(g);
  const track = createEventTracker();
  track(g);
  const at = (game: Game, id: string) => {
    if (id === 'ball') return { x: game.ball.x, y: game.ball.y };
    const p = game.players.find((o) => o.id === id && o.dead === 0);
    return p ? { x: p.x, y: p.y } : null;
  };
  const pred: Predictor = {
    get game() {
      return g;
    },
    me: null,
    pending: 0,
    corrections: 0,
    myCorrection: 0,
    takeMaxCorrection: () => ({ me: 0, ball: 0, others: 0 }),
    setMe() {},
    reset() {},
    tick: () => null,
    snapshot() {},
    pos(id, alpha) {
      const b = at(g, id);
      const a = at(prev, id);
      if (!b) return null;
      if (!a || Math.abs(a.x - b.x) > 60 || Math.abs(a.y - b.y) > 60) return b; // teleports, respawns
      return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha };
    },
    decay() {},
  };
  return {
    pred,
    game: g,
    /** One sim tick; returns the events it produced (for sounds and particles). */
    advance(): GameEvent[] {
      prev = cloneGame(g);
      step(g);
      return track(g);
    },
  };
}
