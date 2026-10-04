/** Every gameplay constant lives here. Units: pixels and ticks (60 ticks per second). */
export const TICK_HZ = 60;
export const sec = (s: number) => Math.round(s * TICK_HZ);

export const FIELD = {
  halfW: 420,
  halfH: 200,
  goalHalf: 64,
  goalDepth: 34,
  postRadius: 8,
  /** Players may roam this far beyond the touchlines (haxball style). */
  margin: 40,
  centerRadius: 70,
};

export const PLAYER = {
  radius: 15,
  invMass: 0.5,
  bounce: 0.5,
  damping: 0.96,
  accel: 0.1,
  kickingAccel: 0.07,
  kickReach: 4,
  kickStrength: 5,
  powerKickMul: 2.2,
  /** Bounce coefficient against the ball when NOT holding kick: soft first touch, easy to trap. */
  softTouchBounce: 0.1,
  maxHp: 3,
  respawn: sec(3),
  /** Respawn point: top of the halfway line, this far into your own half / below the touchline. */
  respawnOffsetX: 30,
  respawnInsetY: 6,
};

export const BALL = { radius: 10, invMass: 1, bounce: 0.5, damping: 0.99, maxSubsteps: 4 };

export const MATCH = {
  maxPerTeam: 3,
  scoreLimit: 5,
  goalPause: sec(2.5),
  /** Nobody kicked off: the ball becomes live anyway. */
  kickoffLimit: sec(5),
  overPause: sec(6),
};

export type ItemKind = 'gun' | 'mine' | 'ice' | 'boost' | 'shield' | 'power' | 'teleport';
/** What a blast marker shows: a crate opening, or a teleport's departure/arrival flash. */
export type BlastKind = ItemKind | 'warp';

export const CRATES = {
  radius: 14,
  max: 3,
  firstAfter: sec(4),
  minGap: sec(5),
  maxGap: sec(9),
  /** Weighted loot table. */
  loot: [
    ['gun', 34],
    ['mine', 22],
    ['ice', 18],
    ['boost', 10],
    ['shield', 8],
    ['power', 8],
    ['teleport', 8],
  ] as ReadonlyArray<readonly [ItemKind, number]>,
};

export const ITEMS = {
  gunAmmo: 6,
  gunCooldown: 14,
  bulletSpeed: 9,
  bulletLife: sec(1.1),
  bulletRadius: 4,
  bulletKnock: 3,
  bulletBallPush: 1.6,
  mineDamage: 1,
  mineSlow: sec(4),
  slowMul: 0.5,
  blastRadius: 80,
  blastPush: 6,
  blastShow: sec(0.6),
  iceFreeze: sec(2.5),
  boost: sec(5),
  boostMul: 1.6,
  /** Teleport lands you this far in front of your own goal line, centred on the goal. */
  teleportInset: 60,
};

export type Role = 'gk' | 'def' | 'mid' | 'fwd';

/**
 * Positions: each role gets a buff only inside its zone, so spreading out pays off
 * instead of everyone chasing the ball. Zones are measured along the attack direction.
 */
export const ROLES = {
  /** Auto-assignment order inside a team. */
  order: ['fwd', 'gk', 'mid', 'def'] as readonly Role[],
  /** Keeper: much bigger inside the own box. */
  gk: { boxDepth: 110, boxHalf: 140, radius: 22, outsideAccel: 0.92 },
  /** Defender: heavier (wins shoulder duels) and a bit quicker in the own half. */
  def: { invMass: 0.28, accel: 1.1 },
  /** Midfielder: longer reach and crisper passes in the middle third. */
  mid: { reach: 8, kick: 1.18, zoneHalf: 160 },
  /** Forward: fastest and hardest shot in the attacking third. */
  fwd: { accel: 1.22, kick: 1.2, zoneStart: 140 },
};

/** Room settings the host picks in the lobby. */
export interface Settings {
  minutes: number;
  scoreLimit: number;
  crates: 'off' | 'normal' | 'chaos';
  /** Which items crates may contain (weighted as usual among them). All of them = the normal mix;
   * one = a fun mode, also handy for trying a new item. Never empty. */
  loot: ItemKind[];
  bots: boolean;
}

export const ITEM_KINDS: readonly ItemKind[] = ['gun', 'mine', 'ice', 'boost', 'shield', 'power', 'teleport'];

export const SETTING_CHOICES = {
  minutes: [2, 3, 5, 10],
  scoreLimit: [3, 5, 7, 10],
  crates: ['off', 'normal', 'chaos'],
} as const;

export const DEFAULT_SETTINGS: Settings = {
  minutes: 3,
  scoreLimit: 5,
  crates: 'normal',
  loot: [...ITEM_KINDS],
  bots: true,
};

/** Chaos: more crates, more often. */
export const CHAOS = { max: 6, gapMul: 0.4 };

/**
 * Pass assist: a kick within this cone of a teammate is bent toward them (leading their run).
 * Cones are stored as cosines (no trig in the sim): 15° for a midfielder in midfield, 6° otherwise.
 */
export const PASS = {
  cosMid: 0.9659,
  cos: 0.9945,
  minDist: 40,
  maxDist: 460,
  /** Aim this fraction of the receiver's travel time ahead of them. */
  lead: 0.6,
};

/**
 * Bot handicaps, so bots feel like average players instead of perfect machines. All deterministic
 * (derived from the tick and the bot's id), so client prediction still matches the server.
 */
export const BOT = {
  /** Rethink every N ticks (≈ 120 ms reaction); in between keep doing the same thing. */
  thinkEvery: 7,
  /** Movement acceleration multiplier. */
  accelMul: 0.85,
  /** Share of kick chances actually taken. */
  kickChance: 0.6,
  /** Only shoot this close and this well aimed (cosine of the angle). */
  shootRange: 200,
  shootCos: 0.97,
  /** Teleport home once the ball is this deep in our half while the bot is this far up the pitch. */
  teleportBallDepth: 150,
  teleportFrom: 100,
};
