import type { BlastKind, Role, Settings } from './content/rules';

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
  slow: number;
  boost: number;
  shield: boolean;
  power: boolean;
  gun: number;
  /** Holding a teleport: USE sends you back in front of your own goal. One held item at a time
   * (gun or teleport), a new crate replaces the old one. */
  teleport: boolean;
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
}
