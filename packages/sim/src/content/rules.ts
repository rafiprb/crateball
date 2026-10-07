/** Every gameplay constant lives here. Units: pixels and ticks (60 ticks per second). */
export const TICK_HZ = 60;
/**
 * Numbers in the game state are kept to 1/STATE_SCALE (canon.ts rounds after every step) and snapshots
 * carry them exactly at that precision: server and clients always hold the same state. Fine enough for the
 * slowest accumulators (the wind's turn rate moves in steps of 0.0004).
 */
export const STATE_SCALE = 100_000;
/**
 * Below this (px per tick, per axis) a moving body is at rest. Rounding the state gives damping fixed points
 * (on ice 0.00125 × 0.996 rounds back to 0.00125): without this a ball would creep on forever. 0.12 px/s,
 * far below anything visible.
 */
export const REST_SPEED = 0.002;
export const sec = (s: number) => Math.round(s * TICK_HZ);

export const FIELD = {
  halfW: 420,
  halfH: 200,
  goalHalf: 64,
  goalDepth: 34,
  postRadius: 8,
  /** Players may roam this far beyond the touchlines. */
  margin: 40,
  /** ...and this far beyond the goal lines: enough to get round the back of the net (34 deep). */
  marginX: 70,
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
  /** After the final whistle the room goes back to the lobby this soon; the results screen stays on top
   * of it (each player closes it, or it goes by itself after `resultsShow`). */
  overPause: sec(2),
  resultsShow: sec(30),
};

/** Match stats on the results screen. */
export const STATS = {
  /** Contact with the ball is a new touch after this long off it, so a dribble counts once. */
  touchGap: sec(0.5),
  /** A kick is a shot when it would roll over the goal line within this far of the middle (the keeper's
   * box); on target when that is inside the posts. */
  shotBand: 140,
};

export type ItemKind =
  'gun' | 'mine' | 'ice' | 'dizzy' | 'boost' | 'shield' | 'power' | 'teleport' | 'bazooka';
/** What a blast marker shows: a crate opening, or a teleport's departure/arrival flash. */
/** `block`: a shield just took a hit (or a bad crate) for its owner. */
/** `save`: a keeper just caught a hard shot. */
/** `crate`: a crate opened in a client's prediction, contents not revealed yet. */
export type BlastKind = ItemKind | 'warp' | 'erupt' | 'rocket' | 'block' | 'save' | 'crate';

export const CRATES = {
  radius: 14,
  max: 3,
  firstAfter: sec(4),
  minGap: sec(5),
  maxGap: sec(9),
  /** Weighted loot table (out of 100): about two crates in three help (62 good, 38 bad: mine, ice,
   * dizzy), so opening one is worth it but still a gamble. */
  loot: [
    ['mine', 14],
    ['ice', 14],
    ['dizzy', 10],
    ['gun', 13],
    ['boost', 10],
    ['shield', 8],
    ['power', 12],
    ['teleport', 12],
    ['bazooka', 7],
  ] as ReadonlyArray<readonly [ItemKind, number]>,
};

export const ITEMS = {
  gunAmmo: 3,
  gunCooldown: 14,
  bulletSpeed: 9,
  bulletLife: sec(1.1),
  bulletRadius: 4,
  bulletKnock: 3,
  bulletBallPush: 1.6,
  /** Bazooka: one rocket that locks on like the gun and then homes in (turning only so fast, so a late
   * sidestep can make it miss); a hit takes all 3 hp. */
  rocketSpeed: 6.2,
  rocketLife: sec(3),
  rocketLockRange: 560,
  /** How hard the rocket steers toward its target each tick (0..1 blend of directions). */
  rocketHoming: 0.065,
  rocketRadius: 7,
  rocketDamage: 3,
  rocketKnock: 9,
  mineDamage: 1,
  mineSlow: sec(4),
  slowMul: 0.5,
  blastRadius: 80,
  blastPush: 6,
  blastShow: sec(0.6),
  iceFreeze: sec(2.5),
  /** Dizzy: your movement keys work backwards for this long. */
  dizzy: sec(4),
  boost: sec(5),
  boostMul: 1.6,
  /** Teleport: a blink of this many pixels in the direction you are pressing. */
  blinkDistance: 150,
};

/** `none`: no position (no passive). Anyone may take it; the four real ones are one per team. */
export type Role = 'gk' | 'def' | 'mid' | 'fwd' | 'none';

/**
 * Positions: each role has its own kind of passive, active only inside its (wide) zone, so spreading
 * out pays off instead of everyone chasing the ball. Zones are measured along the attack direction.
 */
export const ROLES = {
  /** Auto-assignment order inside a team. */
  order: ['fwd', 'gk', 'mid', 'def'] as readonly Role[],
  /** A ball counts as arriving hard (for the keeper's catch and the midfielder's first touch) when it
   * moves at least this fast and hits the player at least this fast (px/tick). */
  cushionMin: 2,
  /**
   * Keeper, zone = `zoneDepth` px out from the own goal line (a little deeper than the box). Safe hands:
   * a ball that arrives hard keeps only `catch` of its speed, so shots drop at their feet. Nimble:
   * `agility` × the acceleration and × the rate speed bleeds off (same top speed, sharper turns).
   * Bigger only inside the box.
   */
  gk: {
    zoneDepth: 140,
    boxDepth: 110,
    boxHalf: 140,
    radius: 19,
    outsideAccel: 0.92,
    agility: 1.5,
    catch: 0.2,
  },
  /**
   * Defender, zone = `zoneDepth` px out from the own goal line (most of the own half). Heavy, and a
   * shoulder charge: running into an opponent at speed shoves them `chargePush` px/tick further and
   * slows them for `chargeSlow` ticks; then `chargeCooldown` ticks before the next one.
   */
  def: {
    zoneDepth: 340,
    invMass: 0.28,
    chargeMinSpeed: 1.2,
    chargePush: 2.4,
    chargeSlow: 36,
    chargeCooldown: sec(1.5),
  },
  /**
   * Midfielder, zone = middle 60% of the pitch. Playmaker: the wider pass lock (PASS.cosMid), longer
   * reach, crisper kick, and a soft first touch: a ball that arrives hard keeps only `firstTouch` of
   * its speed, so it stays close.
   */
  mid: { reach: 8, kick: 1.18, zoneHalf: 252, firstTouch: 0.45 },
  /**
   * Forward, zone = from `zoneStart` px past halfway. Finisher: fastest, harder shots, and a shot that
   * would just miss, or clip a post, is bent to `aimInside` px inside the line where the ball clears the
   * post, when it points within `aimCos` of that.
   */
  fwd: { accel: 1.22, kick: 1.25, zoneStart: 80, aimCos: 0.94, aimInside: 4 },
};

/** Room settings the host picks in the lobby. */
export interface Settings {
  /** Match length; 0 = no time limit (only the score limit ends it, and the clock counts up). */
  minutes: number;
  scoreLimit: number;
  crates: 'off' | 'normal' | 'chaos';
  /** How likely each item is when a crate opens: whole-number shares out of 100 (they add up to at
   * most 100; whatever is left over is spread over the others in proportion). 0 = never. At least one
   * item is above 0. */
  weights: Record<ItemKind, number>;
  /** Position passives on (missing = on). Off: nobody gets a role buff. */
  roles?: boolean;
  /** Arenas the match draws from (missing = all of them). Never empty. */
  arenas?: ArenaKind[];
  bots: boolean;
}

export const ITEM_KINDS: readonly ItemKind[] = [
  'gun',
  'mine',
  'ice',
  'dizzy',
  'boost',
  'shield',
  'power',
  'teleport',
  'bazooka',
];

/** Helpful crates first, then the harmful ones (the lobby lists them in this order; stats count them). */
export const ITEM_GOOD: readonly ItemKind[] = ['gun', 'boost', 'shield', 'power', 'teleport', 'bazooka'];
export const ITEM_BAD: readonly ItemKind[] = ['mine', 'ice', 'dizzy'];

/** The standard mix (CRATES.loot) as a settings weight table. */
export function defaultWeights(): Record<ItemKind, number> {
  const w = Object.fromEntries(ITEM_KINDS.map((k) => [k, 0])) as Record<ItemKind, number>;
  for (const [kind, n] of CRATES.loot) w[kind] = n;
  return w;
}

export const SETTING_CHOICES = {
  minutes: [2, 3, 5, 10, 0],
  scoreLimit: [3, 5, 7, 10],
  crates: ['off', 'normal', 'chaos'],
} as const;

export const DEFAULT_SETTINGS: Settings = {
  minutes: 3,
  scoreLimit: 5,
  crates: 'normal',
  weights: defaultWeights(),
  roles: true,
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
  /** Pull the trigger once the auto-aimed target is this close. */
  shootRange: 260,
  /** Blink (teleport) toward where the bot wants to be once it is at least this far away. */
  blinkFrom: 200,
};

export type ArenaKind = 'classic' | 'rain' | 'volcano' | 'ice' | 'wind' | 'beach';

/**
 * Arenas: a new one at every kickoff, in an order fixed before the match (shown in the lobby).
 * Every block of five kickoffs contains all five arenas; never the same one twice in a row.
 */
export const ARENAS = {
  kinds: ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'] as readonly ArenaKind[],
  /** Normal pitch values, for reference: ball 0.99, player 0.96. */
  rain: {
    ballDamping: 0.994,
    playerDamping: 0.972,
    /** Wet ground: everyone is a bit slower; in a puddle much slower. */
    accel: 0.85,
    puddleAccel: 0.55,
    puddleBallDamping: 0.94,
    /** Puddles are 3–5 overlapping circles; they form, last, dry out and new ones appear. */
    minPuddles: 3,
    maxPuddles: 5,
    partMinR: 22,
    partMaxR: 38,
    partSpread: 34,
    formTicks: sec(2.5),
    dryTicks: sec(4),
    minLife: sec(9),
    maxLife: sec(14),
    spawnMinGap: sec(2),
    spawnMaxGap: sec(4),
  },
  ice: { ballDamping: 0.996, playerDamping: 0.986, accel: 0.55 },
  volcano: {
    /** Lava streams run from the top edge down to the bottom like creeks. */
    maxStreams: 2,
    streamMinGap: sec(3),
    streamMaxGap: sec(6),
    /** Pixels per tick, and a channel point every N ticks. */
    streamSpeed: 0.9,
    pointEvery: 13,
    lavaRadius: 17,
    /** How long a stretch stays hot, then it has cooled (harmless) and fades. */
    coolTicks: sec(10),
    fadeTicks: sec(1.5),
    /** Hot lava: no damage, but you wade through it. */
    lavaAccel: 0.5,
    /** Meander: random walk of the turn rate; past this |dx| it is steered back downwards. */
    maxTurn: 0.02,
    turnJitter: 0.003,
    maxSideways: 0.75,
    /** Eruptions happen only on hot lava. */
    eruptMinGap: sec(6),
    eruptMaxGap: sec(10),
    warning: sec(1.5),
    eruptRadius: 90,
    eruptPush: 7,
    eruptDamageRadius: 45,
  },
  /** The wind turns smoothly through all directions; its turn rate wanders. */
  wind: { force: 0.012, maxTurn: 0.006, turnJitter: 0.0004 },
  /**
   * Beach: a sandy pitch with the sea coming in from the top touchline in two bays. The water is only a
   * look (everyone moves exactly as on sand); rubber ducks paddle about in it and the ball bounces off
   * them. Shoreline y(x) = −halfH + (1 − u²)(centre + bays·u²), u = x / reach; dry beyond |x| ≥ reach,
   * so the goal mouths, the boxes and the kickoff spot stay on sand.
   */
  beach: {
    centre: 118,
    bays: 300,
    reach: 365,
    ducks: 4,
    duckRadius: 11,
    /** Paddling thrust per tick and water drag: top speed about 0.34 px/tick. */
    duckThrust: 0.022,
    duckDamping: 0.94,
    duckJitter: 0.003,
    duckMaxTurn: 0.018,
    /** Looks this far ahead; dry there: turns back towards the middle of the water. */
    duckProbe: 30,
    /** Where a lost duck heads: the middle of the water, at most this far to the side. */
    duckHomeX: 230,
    duckHomeY: -170,
    /** Against the ball a duck is a heavy rubber toy (the ball glances off); a player shoves it away. */
    duckBallInvMass: 0.5,
    duckBallBounce: 0.85,
    duckPlayerInvMass: 2,
    /** Closing speed (px/tick) for a quack; this fast is a hard hit (feathers): the ball, a player. */
    duckBumpMin: 0.45,
    duckHardBall: 3,
    duckHardPlayer: 1.2,
    /** Ticks before the same duck quacks again (a hard hit may cut in after half), and a dazed spin. */
    duckCooldown: 30,
    duckStun: 40,
    /** Ducks turn away from a player this close. */
    duckShy: 46,
  },
  /** Puddles keep clear of the centre circle and the goal boxes. */
  keepClearCenter: 150,
  keepClearBoxDepth: 170,
  keepClearBoxHalf: 180,
};
