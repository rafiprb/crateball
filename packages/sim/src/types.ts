import type { ArenaKind, BlastKind, Role, Settings } from './content/rules';

export type Team = 'red' | 'blue';
export type Phase = 'kickoff' | 'play' | 'goal' | 'over';

/** Input bits, one byte per player per tick. */
export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const KICK = 16;
export const USE = 32;

export interface Player {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
  role: Role;
  /** True while standing in the role's zone (buff active). */
  buff: boolean;
  /** Current radius (keeper grows in the box). */
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Last known input; remote players repeat it until a new one arrives. */
  input: number;
  /** A kick fires once per press. */
  kickArmed: boolean;
  useArmed: boolean;
  fx: number;
  fy: number;
  hp: number;
  dead: number;
  frozen: number;
  /** Ticks left with the movement keys reversed (a dizzy crate). */
  dizzy: number;
  slow: number;
  /** Defender: ticks until the next shoulder charge can land. */
  chargeCd: number;
  boost: number;
  shield: boolean;
  power: boolean;
  gun: number;
  /** Holding a teleport: USE blinks you in the direction you press. One held item at a time
   * (gun, teleport or bazooka), a new crate replaces the old one. */
  teleport: boolean;
  /** Holding a bazooka: USE fires its one homing rocket at the locked-on enemy. */
  bazooka: boolean;
  cooldown: number;
  goals: number;
  /** Tick of the last kick (client plays the sound once per value). */
  kickTick: number;
  stats: Stats;
}

/** One player's match numbers for the results screen and the MVP (see stats.ts). The game itself never
 * reads them back. */
export interface Stats {
  /** Spells on the ball: a kick, or a contact after STATS.touchGap off it. */
  touches: number;
  assists: number;
  ownGoals: number;
  /** Kicks at the opponents' goal from an owned ball (one per spell), and those of them that ended in a
   * goal, a keeper's save or a block. A goal is always a shot on target, even one dribbled in. */
  shots: number;
  onTarget: number;
  /** Keeper only: a shot on target stopped, with no goal within STATS.saveHold. */
  saves: number;
  /** Owned ball reaching a teammate at least STATS.passMin away, no opponent touch in between. */
  passes: number;
  /** Took the ball off an opponent who owned it and was on it within STATS.touchGap, and the side kept
   * it for STATS.own. */
  tackles: number;
  /** A shot on target stopped in the own box by someone who is not the keeper, with no goal straight
   * after. */
  blocks: number;
  /** Keeper only: goals let in, and 1 when the side let in none by the final whistle. */
  conceded: number;
  cleanSheet: number;
  /** Crates opened: helpful ones and harmful ones (ITEM_BAD). */
  goodCrates: number;
  badCrates: number;
  /** Hit points taken off opponents (bullets and rockets). */
  damage: number;
  /** Damage the shield took instead of you. */
  absorbed: number;
  deaths: number;
  /** Bookkeeping, not shown: tick of the latest contact with the ball; when each teammate last got a
   * completed pass from this player (a pair counts once per STATS.passRepeat). */
  ballAt: number;
  passLog: Record<string, number>;
}

/** A player's unbroken time on the ball: from the touch that took it to the latest one. */
export interface Spell {
  id: string;
  team: Team;
  first: number;
  last: number;
  /** When the side got the ball (a teammate's touch carries it on). */
  since: number;
  /** The side did not take it off the other side in a scramble (their possession was shorter than
   * STATS.own); passed on to teammates. */
  clean: boolean;
  /** Where the ball was at the latest touch. */
  x: number;
  y: number;
  /** Tick of the latest kick in this spell, -1 for none. */
  kickAt: number;
  /** A shot already counted in this spell (one per spell). */
  shot: boolean;
}

/** Someone who left during the match: their line stays on the results screen until the next one. */
export interface Departed {
  id: string;
  name: string;
  team: Team;
  role: Role;
  bot: boolean;
  goals: number;
  stats: Stats;
}

/** Who had the ball lately, and what is waiting for an outcome. Written by stats.ts only. */
export interface Scoring {
  /** The latest spells, oldest first (at most STATS.spells). Cleared at every kickoff. */
  spells: Spell[];
  /** The latest counted shot: `done` once someone else touched the ball (its outcome known), `on` when
   * that made it a shot on target (a save or a block). */
  shot: { by: string; team: Team; done: boolean; on: boolean } | null;
  /** Saves and blocks that stand unless a goal comes within STATS.saveHold. */
  stops: Array<{ by: string; kind: 'save' | 'block'; at: number }>;
  /** A ball won off an opponent: a tackle once the side keeps it for STATS.own. */
  tackle: { by: string; team: Team; at: number } | null;
  /** Players who left during this match (cleared when the next one starts). */
  gone: Departed[];
}

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Crate {
  id: number;
  x: number;
  y: number;
}

export interface Bullet extends Body {
  id: number;
  owner: string;
  team: Team;
  life: number;
  /** A bazooka rocket (bigger, slower, takes all 3 hp) rather than a gun bullet. */
  rocket?: boolean;
  /** The player a rocket is homing in on (gone once they die). */
  target?: string;
}

/** Short-lived visual marker kept in state so prediction replays it identically. */
export interface Blast {
  x: number;
  y: number;
  kind: BlastKind;
  t: number;
}

export interface Game {
  settings: Settings;
  tick: number;
  rng: number;
  /** Loot draws only. The server keeps it secret (fresh crypto randomness before every step, never
   * sent); `null` on clients, where an opened crate's contents are unknown until a snapshot says. */
  lootRng: number | null;
  nextId: number;
  phase: Phase;
  phaseT: number;
  clock: number;
  score: [number, number];
  kickoffTeam: Team;
  nextCrate: number;
  lastTouch: string | null;
  /** Match stats bookkeeping (stats.ts). */
  scoring: Scoring;
  players: Player[];
  ball: Body;
  crates: Crate[];
  bullets: Bullet[];
  blasts: Blast[];
  /** Pitch and weather for the current kickoff (changes after every goal). */
  arena: Arena;
  /** Arena for each kickoff of the match, fixed before it starts (shown in the lobby). */
  arenaPlan: ArenaKind[];
  /** Kickoffs played so far in this match (index into arenaPlan). */
  kickoffs: number;
  /** Matches started in this room (each restartMatch): tells a new match from a rollback. */
  matches: number;
}

/** A rain puddle: overlapping circles that form, last and dry out (all in ticks). */
export interface Puddle {
  x: number;
  y: number;
  parts: Array<{ dx: number; dy: number; r: number }>;
  born: number;
  life: number;
}

/** A point of a lava channel; it is hot when young and cools with age. */
export interface LavaPoint {
  x: number;
  y: number;
  born: number;
}

/** A lava creek: a head that meanders downwards, leaving channel points behind. */
export interface LavaStream {
  x: number;
  y: number;
  dx: number;
  dy: number;
  turn: number;
  /** Still flowing (false once the head has run off the bottom). */
  flowing: boolean;
  /** Ticks since the last channel point. */
  sinceStep?: number;
  points: LavaPoint[];
}

/** A rubber duck on the beach arena (sim state: the ball bounces off it, so prediction must agree). */
export interface Duck {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Heading (unit vector) and its turn rate. */
  hx: number;
  hy: number;
  turn: number;
  /** Ticks until it may quack again; ticks left of a dazed spin after a hard hit. */
  cd: number;
  stun: number;
  /** Quacks so far, and how many of them were hard hits: the client plays one per new count. */
  bumps: number;
  hard: number;
}

export interface Arena {
  kind: ArenaKind;
  /** Beach: the ducks (empty elsewhere). */
  ducks: Duck[];
  puddles: Puddle[];
  streams: LavaStream[];
  /** Unit vector; zero unless the arena is windy. */
  wind: { x: number; y: number };
  windTurn: number;
  /** Next puddle / stream spawn. */
  nextSpawn: number;
  /** Next eruption step (warning, then the blast). */
  nextEvent: number;
  /** Where the next eruption will hit (shown as a warning). */
  warn: { x: number; y: number } | null;
}
