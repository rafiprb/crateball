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

export interface Arena {
  kind: ArenaKind;
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
