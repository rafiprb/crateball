import {
  BALL,
  BOT,
  CHAOS,
  CRATES,
  DEFAULT_SETTINGS,
  FIELD,
  ITEMS,
  MATCH,
  PASS,
  PLAYER,
  ROLES,
  TICK_HZ,
  type ItemKind,
  type Role,
  type Settings,
} from './content/rules';
import { nextRandom } from './rng';
import {
  DOWN,
  KICK,
  LEFT,
  RIGHT,
  UP,
  USE,
  type Body,
  type Bullet,
  type Game,
  type Player,
  type Team,
} from './types';
import { botInput } from './bot';
import { gunTarget } from './aim';
import {
  arenaAccel,
  ballDamping,
  classicArena,
  makeArena,
  planArenas,
  playerDamping,
  updateArena,
} from './arena';

export function createGame(seed: number, settings: Settings = DEFAULT_SETTINGS): Game {
  return {
    settings: { ...settings },
    tick: 0,
    rng: seed >>> 0,
    nextId: 1,
    phase: 'kickoff',
    phaseT: 0,
    clock: settings.minutes * 60 * TICK_HZ,
    score: [0, 0],
    kickoffTeam: 'red',
    nextCrate: CRATES.firstAfter,
    lastTouch: null,
    players: [],
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    crates: [],
    bullets: [],
    blasts: [],
    arena: classicArena(),
    arenaPlan: [],
    kickoffs: 0,
  };
}

/** Hand-written deep copy: prediction clones on every snapshot, so keep it cheap. */
export function cloneGame(g: Game): Game {
  return {
    ...g,
    score: [g.score[0], g.score[1]],
    players: g.players.map((p) => ({ ...p })),
    ball: { ...g.ball },
    crates: g.crates.map((c) => ({ ...c })),
    bullets: g.bullets.map((b) => ({ ...b })),
    blasts: g.blasts.map((b) => ({ ...b })),
    arena: {
      ...g.arena,
      puddles: g.arena.puddles.map((p) => ({ ...p, parts: p.parts.map((q) => ({ ...q })) })),
      streams: g.arena.streams.map((st) => ({ ...st, points: st.points.map((pt) => ({ ...pt })) })),
      wind: { ...g.arena.wind },
      warn: g.arena.warn && { ...g.arena.warn },
    },
    arenaPlan: [...g.arenaPlan],
  };
}

function rand(g: Game): number {
  const [v, s] = nextRandom(g.rng);
  g.rng = s;
  return v;
}

const side = (t: Team) => (t === 'red' ? -1 : 1);

export function teamCount(g: Game, team: Team, bots?: boolean): number {
  return g.players.filter((p) => p.team === team && (bots === undefined || p.bot === bots)).length;
}

export function freeRole(g: Game, team: Team): Role {
  const used = new Set(g.players.filter((p) => p.team === team).map((p) => p.role));
  return ROLES.order.find((r) => !used.has(r)) ?? 'mid';
}

/** Take a role; a teammate already holding it gets yours. */
export function setRole(g: Game, id: string, role: Role): void {
  const p = g.players.find((o) => o.id === id);
  if (!p || p.role === role) return;
  const other = g.players.find((o) => o.team === p.team && o.role === role);
  if (other) other.role = p.role;
  p.role = role;
}

export function addPlayer(g: Game, id: string, name: string, team: Team, bot = false): Player {
  const p: Player = {
    id,
    name,
    team,
    bot,
    role: freeRole(g, team),
    buff: false,
    r: PLAYER.radius,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    input: 0,
    kickArmed: true,
    useArmed: true,
    fx: -side(team),
    fy: 0,
    hp: PLAYER.maxHp,
    dead: 0,
    frozen: 0,
    slow: 0,
    boost: 0,
    shield: false,
    power: false,
    gun: 0,
    teleport: false,
    bazooka: false,
    cooldown: 0,
    goals: 0,
    kickTick: -1,
  };
  g.players.push(p);
  placeAtSpawn(g, p, teamCount(g, team) - 1);
  return p;
}

export function removePlayer(g: Game, id: string): void {
  g.players = g.players.filter((p) => p.id !== id);
}

const SPAWN_Y = [0, -90, 90, -150, 150];
function placeAtSpawn(g: Game, p: Player, slot: number): void {
  const s = side(p.team);
  p.x = s * (slot === 0 ? 180 : 260);
  p.y = SPAWN_Y[slot % SPAWN_Y.length] ?? 0;
  p.vx = 0;
  p.vy = 0;
  p.fx = -s;
  p.fy = 0;
}

/** Every kickoff (match start and after each goal) is a clean slate: full health, no items or
 * effects, the dead are back, no crates, bullets or blasts on the pitch. */
function resetKickoff(g: Game, kickoffTeam: Team): void {
  g.phase = 'kickoff';
  g.phaseT = 0;
  g.kickoffTeam = kickoffTeam;
  g.ball = { x: 0, y: 0, vx: 0, vy: 0 };
  g.bullets = [];
  g.blasts = [];
  g.crates = [];
  g.nextCrate = g.tick + CRATES.firstAfter;
  // The arena for this kickoff comes from the plan fixed before the match.
  if (!g.arenaPlan.length) newArenaPlan(g);
  const kind = g.arenaPlan[g.kickoffs % g.arenaPlan.length] ?? 'classic';
  g.kickoffs++;
  g.arena = makeArena(g, kind, () => rand(g));
  const slots = { red: 0, blue: 0 };
  for (const p of g.players) {
    Object.assign(p, { hp: PLAYER.maxHp, dead: 0, frozen: 0, slow: 0, boost: 0, cooldown: 0 });
    Object.assign(p, {
      shield: false,
      power: false,
      gun: 0,
      teleport: false,
      bazooka: false,
      kickArmed: true,
      useArmed: true,
      input: 0,
    });
    placeAtSpawn(g, p, slots[p.team]++);
  }
}

/** Draw the arena order for the next match (at most 2 × scoreLimit kickoffs) from the chosen pool. */
export function newArenaPlan(g: Game): void {
  g.arenaPlan = planArenas(() => rand(g), 2 * g.settings.scoreLimit, g.settings.arenas);
}

export function restartMatch(g: Game): void {
  g.score = [0, 0];
  g.kickoffs = 0;
  g.clock = g.settings.minutes * 60 * TICK_HZ;
  for (const p of g.players) p.goals = 0;
  resetKickoff(g, 'red');
}

/** Advance one tick. `inputs` overrides stored inputs by player id (absent → repeat last). */
export function step(g: Game, inputs?: ReadonlyMap<string, number>): void {
  g.tick++;
  g.phaseT++;
  for (const p of g.players) {
    if (p.bot) p.input = botInput(g, p);
    else {
      const i = inputs?.get(p.id);
      if (i !== undefined) p.input = i;
    }
  }
  // Terminal: the server takes the room back to the lobby after MATCH.overPause.
  if (g.phase === 'over') return;
  if (g.phase === 'play' && g.clock > 0) g.clock--;

  for (const p of g.players) controlPlayer(g, p);
  integrate(g);
  collide(g);
  updateBullets(g);
  updateCrates(g);
  updateArena(
    g,
    () => rand(g),
    (p, n, kx, ky) => damage(g, p, n, kx, ky),
  );
  g.blasts = g.blasts.filter((b) => --b.t > 0);
  rules(g);
}

function controlPlayer(g: Game, p: Player): void {
  if (p.cooldown > 0) p.cooldown--;
  if (p.dead > 0) {
    if (--p.dead === 0) {
      // Back in at an end of the halfway line, on your own side: the end away from where you died
      // (the parking spot's sign remembers it).
      p.hp = PLAYER.maxHp;
      p.x = side(p.team) * PLAYER.respawnOffsetX;
      p.y = Math.sign(p.y) * (FIELD.halfH - PLAYER.radius - PLAYER.respawnInsetY);
      p.vx = p.vy = 0;
      p.fx = -side(p.team);
      p.fy = 0;
    }
    return;
  }
  if (p.slow > 0) p.slow--;
  if (p.boost > 0) p.boost--;
  p.buff = inZone(p);
  p.r = p.role === 'gk' && p.buff ? ROLES.gk.radius : PLAYER.radius;
  const kickHeld = (p.input & KICK) !== 0;
  const useHeld = (p.input & USE) !== 0;
  if (p.frozen > 0) {
    p.frozen--;
    p.vx *= 0.8;
    p.vy *= 0.8;
    p.kickArmed = !kickHeld;
    p.useArmed = !useHeld;
    return;
  }
  let dx = 0;
  let dy = 0;
  if (p.input & UP) dy -= 1;
  if (p.input & DOWN) dy += 1;
  if (p.input & LEFT) dx -= 1;
  if (p.input & RIGHT) dx += 1;
  if (dx !== 0 || dy !== 0) {
    const n = Math.sqrt(dx * dx + dy * dy);
    dx /= n;
    dy /= n;
    p.fx = dx;
    p.fy = dy;
    let a = kickHeld ? PLAYER.kickingAccel : PLAYER.accel;
    if (p.slow > 0) a *= ITEMS.slowMul;
    a *= accelMul(p);
    if (p.bot) a *= BOT.accelMul;
    a *= arenaAccel(g, p);
    if (p.boost > 0) a *= ITEMS.boostMul;
    p.vx += dx * a;
    p.vy += dy * a;
  }
  if (!kickHeld) p.kickArmed = true;
  else if (p.kickArmed) tryKick(g, p);
  // The gun fires for as long as USE is held; a teleport or the bazooka takes a fresh press.
  if (!useHeld) p.useArmed = true;
  else {
    if (p.teleport && p.useArmed) blink(g, p);
    else if (p.bazooka && p.useArmed) fireRocket(g, p);
    else if (p.gun > 0 && p.cooldown === 0) fire(g, p);
    p.useArmed = false;
  }
}

/** Distance along the attack direction: negative = own half. */
const advance = (p: Player) => -side(p.team) * p.x;

function inZone(p: Player): boolean {
  const u = advance(p);
  switch (p.role) {
    case 'gk':
      return u < -(FIELD.halfW - ROLES.gk.boxDepth) && Math.abs(p.y) < ROLES.gk.boxHalf;
    case 'def':
      return u < 0;
    case 'mid':
      return Math.abs(u) < ROLES.mid.zoneHalf;
    case 'fwd':
      return u > ROLES.fwd.zoneStart;
  }
}

function accelMul(p: Player): number {
  if (p.role === 'gk') return p.buff ? 1 : ROLES.gk.outsideAccel;
  if (!p.buff) return 1;
  return p.role === 'def' ? ROLES.def.accel : p.role === 'fwd' ? ROLES.fwd.accel : 1;
}

function kickMul(p: Player): number {
  if (!p.buff) return 1;
  return p.role === 'mid' ? ROLES.mid.kick : p.role === 'fwd' ? ROLES.fwd.kick : 1;
}

const invMass = (p: Player) => (p.role === 'def' && p.buff ? ROLES.def.invMass : PLAYER.invMass);

/**
 * Where a kick by `p` would send the ball right now, or null if the ball is out of reach.
 * Shared by the kick itself and the client's aim arrow.
 */
export function kickDirection(g: Game, p: Player): { x: number; y: number; to: string | null } | null {
  const b = g.ball;
  const dx = b.x - p.x;
  const dy = b.y - p.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const reach = PLAYER.kickReach + (p.role === 'mid' && p.buff ? ROLES.mid.reach : 0);
  if (d > p.r + BALL.radius + reach || d === 0) return null;
  const nx = dx / d;
  const ny = dy / d;
  // A shot that already points at the goal mouth is never bent toward a teammate.
  const goalX = -side(p.team) * FIELD.halfW;
  if (nx * (goalX - b.x) > 0) {
    const yAtGoal = b.y + (ny / nx) * (goalX - b.x);
    if (Math.abs(yAtGoal) < FIELD.goalHalf) return { x: nx, y: ny, to: null };
  }
  const minCos = p.role === 'mid' && p.buff ? PASS.cosMid : PASS.cos;
  let best: { x: number; y: number; to: string | null } = { x: nx, y: ny, to: null };
  let bestCos = minCos;
  const speed = PLAYER.kickStrength * kickMul(p);
  for (const m of g.players) {
    if (m === p || m.team !== p.team || m.dead > 0) continue;
    const mx = m.x - b.x;
    const my = m.y - b.y;
    const md = Math.sqrt(mx * mx + my * my);
    if (md < PASS.minDist || md > PASS.maxDist) continue;
    const cos = (mx * nx + my * ny) / md;
    if (cos <= bestCos) continue;
    // Lead the receiver along their current run.
    const t = (md / speed) * PASS.lead;
    const lx = mx + m.vx * t;
    const ly = my + m.vy * t;
    const ld = Math.sqrt(lx * lx + ly * ly) || 1;
    bestCos = cos;
    best = { x: lx / ld, y: ly / ld, to: m.id };
  }
  return best;
}

function tryKick(g: Game, p: Player): void {
  const dir = kickDirection(g, p);
  if (!dir) return;
  const b = g.ball;
  const k = PLAYER.kickStrength * (p.power ? PLAYER.powerKickMul : 1) * kickMul(p) * BALL.invMass;
  b.vx += dir.x * k;
  b.vy += dir.y * k;
  p.kickArmed = false;
  p.kickTick = g.tick;
  p.power = false;
  g.lastTouch = p.id;
  if (g.phase === 'kickoff') g.phase = 'play';
}

function fire(g: Game, p: Player): void {
  p.gun--;
  p.cooldown = ITEMS.gunCooldown;
  const target = gunTarget(g, p);
  let dx = p.fx;
  let dy = p.fy;
  if (target) {
    const tx = target.x - p.x;
    const ty = target.y - p.y;
    const n = Math.sqrt(tx * tx + ty * ty) || 1;
    dx = tx / n;
    dy = ty / n;
  }
  const r = p.r + ITEMS.bulletRadius + 1;
  g.bullets.push({
    id: g.nextId++,
    owner: p.id,
    team: p.team,
    x: p.x + dx * r,
    y: p.y + dy * r,
    vx: dx * ITEMS.bulletSpeed,
    vy: dy * ITEMS.bulletSpeed,
    life: ITEMS.bulletLife,
  });
}

/** The bazooka's one rocket: launched at the locked-on enemy (else straight ahead), then it homes in. */
function fireRocket(g: Game, p: Player): void {
  const target = gunTarget(g, p);
  p.bazooka = false;
  p.cooldown = ITEMS.gunCooldown;
  let dx = p.fx;
  let dy = p.fy;
  if (target) {
    const tx = target.x - p.x;
    const ty = target.y - p.y;
    const n = Math.sqrt(tx * tx + ty * ty) || 1;
    dx = tx / n;
    dy = ty / n;
  }
  const r = p.r + ITEMS.rocketRadius + 1;
  g.bullets.push({
    id: g.nextId++,
    owner: p.id,
    team: p.team,
    x: p.x + dx * r,
    y: p.y + dy * r,
    vx: dx * ITEMS.rocketSpeed,
    vy: dy * ITEMS.rocketSpeed,
    life: ITEMS.rocketLife,
    rocket: true,
    ...(target ? { target: target.id } : {}),
  });
}

/** Turn a rocket a little toward its target (a blend of directions, renormalised: no trig). */
function homeRocket(g: Game, b: Bullet): void {
  if (!b.target) return;
  const t = g.players.find((p) => p.id === b.target);
  if (!t || t.dead > 0) {
    delete b.target;
    return;
  }
  const tx = t.x - b.x;
  const ty = t.y - b.y;
  const tn = Math.sqrt(tx * tx + ty * ty) || 1;
  const k = ITEMS.rocketHoming;
  const s = ITEMS.rocketSpeed;
  const vx = (b.vx / s) * (1 - k) + (tx / tn) * k;
  const vy = (b.vy / s) * (1 - k) + (ty / tn) * k;
  const n = Math.sqrt(vx * vx + vy * vy) || 1;
  b.vx = (vx / n) * s;
  b.vy = (vy / n) * s;
}

/**
 * Blink a fixed distance in the direction you are pressing (fx/fy follow the movement keys; with no
 * key held it is the last direction you moved). Speed is kept; the pitch edge stops you.
 */
function blink(g: Game, p: Player): void {
  p.teleport = false;
  g.blasts.push({ x: p.x, y: p.y, kind: 'warp', t: ITEMS.blastShow });
  const mx = FIELD.halfW + FIELD.margin - p.r;
  const my = FIELD.halfH + FIELD.margin - p.r;
  p.x = Math.max(-mx, Math.min(mx, p.x + p.fx * ITEMS.blinkDistance));
  p.y = Math.max(-my, Math.min(my, p.y + p.fy * ITEMS.blinkDistance));
  g.blasts.push({ x: p.x, y: p.y, kind: 'warp', t: ITEMS.blastShow });
}

function integrate(g: Game): void {
  for (const p of g.players) {
    if (p.dead > 0) continue;
    p.x += p.vx;
    p.y += p.vy;
    const pd = playerDamping(g);
    p.vx *= pd;
    p.vy *= pd;
  }
  // The ball moves in sub-steps no longer than its radius, checking the walls after each one, so a
  // very fast ball cannot skip over the goal line beside the goal and land inside the net.
  const b = g.ball;
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const steps = Math.min(BALL.maxSubsteps, Math.max(1, Math.ceil(speed / BALL.radius)));
  // Safety cap: the sub-steps (each no longer than the radius) must cover the whole move.
  if (speed > BALL.radius * BALL.maxSubsteps) {
    const k = (BALL.radius * BALL.maxSubsteps) / speed;
    b.vx *= k;
    b.vy *= k;
  }
  for (let i = 0; i < steps; i++) {
    b.x += b.vx / steps;
    b.y += b.vy / steps;
    confineBall(b);
  }
  const bd = ballDamping(g, BALL.damping);
  b.vx *= bd;
  b.vy *= bd;
}

/** Elastic-ish circle contact, haxball style (bounce = product of both coefficients). */
function contact(a: Body, ar: number, am: number, ab: number, b: Body, br: number, bm: number, bb: number) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const d2 = dx * dx + dy * dy;
  const r = ar + br;
  if (d2 >= r * r) return false;
  // Exactly on top of each other (e.g. two players respawning on the same tick): separate along a
  // fixed axis so they do not stay stacked forever.
  const d = Math.sqrt(d2);
  const nx = d === 0 ? 1 : dx / d;
  const ny = d === 0 ? 0 : dy / d;
  const m = am / (am + bm);
  const pen = r - d;
  a.x += nx * pen * m;
  a.y += ny * pen * m;
  b.x -= nx * pen * (1 - m);
  b.y -= ny * pen * (1 - m);
  const rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rv < 0) {
    const j = rv * (ab * bb + 1);
    a.vx -= nx * j * m;
    a.vy -= ny * j * m;
    b.vx += nx * j * (1 - m);
    b.vy += ny * j * (1 - m);
  }
  return true;
}

const POSTS = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({ x: sx * FIELD.halfW, y: sy * FIELD.goalHalf })));
const STILL = { vx: 0, vy: 0 };

function collide(g: Game): void {
  const alive = g.players.filter((p) => p.dead === 0);
  for (let i = 0; i < alive.length; i++) {
    const a = alive[i]!;
    for (let j = i + 1; j < alive.length; j++) {
      const b = alive[j]!;
      contact(a, a.r, invMass(a), PLAYER.bounce, b, b.r, invMass(b), PLAYER.bounce);
    }
    const touch = a.input & KICK ? PLAYER.bounce : PLAYER.softTouchBounce;
    if (contact(a, a.r, invMass(a), touch, g.ball, BALL.radius, BALL.invMass, BALL.bounce))
      g.lastTouch = a.id;
    if (g.phase === 'kickoff' && (Math.abs(g.ball.x) > 0.01 || Math.abs(g.ball.y) > 0.01)) g.phase = 'play';
    confinePlayer(g, a);
  }
  for (const post of POSTS) {
    for (const body of [g.ball, ...alive]) {
      const r = body === g.ball ? BALL.radius : (body as Player).r;
      contact(body, r, 1, 0.5, { ...post, ...STILL }, FIELD.postRadius, 0, 1);
    }
  }
  confineBall(g.ball);
}

function confinePlayer(g: Game, p: Player): void {
  const r = p.r;
  const mx = FIELD.halfW + FIELD.margin - r;
  const my = FIELD.halfH + FIELD.margin - r;
  p.x = Math.max(-mx, Math.min(mx, p.x));
  p.y = Math.max(-my, Math.min(my, p.y));
  if (g.phase !== 'kickoff') return;
  // Kickoff: stay in your half; the defending team also stays out of the centre circle.
  const s = side(p.team);
  if (p.x * s < r) {
    p.x = s * r;
    p.vx = 0;
  }
  if (p.team !== g.kickoffTeam) {
    const d = Math.sqrt(p.x * p.x + p.y * p.y);
    const min = FIELD.centerRadius + r;
    if (d < min && d > 0) {
      p.x = (p.x / d) * min;
      p.y = (p.y / d) * min;
    }
  }
}

function confineBall(b: Body): void {
  const r = BALL.radius;
  const { halfW, halfH, goalHalf, goalDepth } = FIELD;
  const inMouth = Math.abs(b.y) < goalHalf;
  if (Math.abs(b.x) > halfW - r && !inMouth && Math.abs(b.x) < halfW + r) {
    // Hit the goal line beside the goal.
    if (Math.abs(b.y) > goalHalf) {
      b.x = Math.sign(b.x) * (halfW - r);
      b.vx = -b.vx * BALL.bounce;
    }
  }
  if (Math.abs(b.x) > halfW) {
    // Inside the net.
    const lim = goalHalf - r;
    if (Math.abs(b.y) > lim) {
      b.y = Math.sign(b.y) * lim;
      b.vy = -b.vy * BALL.bounce;
    }
    if (Math.abs(b.x) > halfW + goalDepth - r) {
      b.x = Math.sign(b.x) * (halfW + goalDepth - r);
      b.vx = -b.vx * 0.2;
    }
  }
  if (Math.abs(b.y) > halfH - r) {
    b.y = Math.sign(b.y) * (halfH - r);
    b.vy = -b.vy * BALL.bounce;
  }
}

function damage(g: Game, p: Player, amount: number, kx: number, ky: number): void {
  p.vx += kx;
  p.vy += ky;
  if (p.shield) {
    p.shield = false;
    return;
  }
  p.hp -= amount;
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = PLAYER.respawn;
    p.gun = 0;
    p.teleport = false;
    p.bazooka = false;
    p.frozen = 0;
    p.slow = 0;
    p.boost = 0;
    p.power = false;
    g.blasts.push({ x: p.x, y: p.y, kind: 'mine', t: ITEMS.blastShow });
    // Parked off the pitch while dead; the sign of y picks the respawn end: died in the top half →
    // back in at the bottom, and the other way round.
    p.x = 9999;
    p.y = p.y < 0 ? 9999 : -9999;
  }
}

function updateBullets(g: Game): void {
  const lw = FIELD.halfW + FIELD.margin;
  const lh = FIELD.halfH + FIELD.margin;
  g.bullets = g.bullets.filter((b) => {
    if (b.rocket) homeRocket(g, b);
    b.x += b.vx;
    b.y += b.vy;
    if (--b.life <= 0 || Math.abs(b.x) > lw || Math.abs(b.y) > lh) return false;
    const radius = b.rocket ? ITEMS.rocketRadius : ITEMS.bulletRadius;
    const speed = b.rocket ? ITEMS.rocketSpeed : ITEMS.bulletSpeed;
    for (const p of g.players) {
      if (p.dead > 0 || p.team === b.team) continue;
      if (dist2(p, b) < (p.r + radius) ** 2) {
        const s = (b.rocket ? ITEMS.rocketKnock : ITEMS.bulletKnock) / speed;
        if (b.rocket) g.blasts.push({ x: b.x, y: b.y, kind: 'rocket', t: ITEMS.blastShow });
        damage(g, p, b.rocket ? ITEMS.rocketDamage : 1, b.vx * s, b.vy * s);
        return false;
      }
    }
    // Bullets knock the ball; a homing rocket flies through it (it is after a player).
    if (!b.rocket && dist2(g.ball, b) < (BALL.radius + radius) ** 2) {
      const s = ITEMS.bulletBallPush / speed;
      g.ball.vx += b.vx * s;
      g.ball.vy += b.vy * s;
      return false;
    }
    return true;
  });
}

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

function updateCrates(g: Game): void {
  const mode = g.settings.crates;
  if (mode !== 'off' && g.tick >= g.nextCrate) {
    const mul = mode === 'chaos' ? CHAOS.gapMul : 1;
    g.nextCrate = g.tick + Math.floor((CRATES.minGap + rand(g) * (CRATES.maxGap - CRATES.minGap)) * mul);
    if (g.crates.length < (mode === 'chaos' ? CHAOS.max : CRATES.max)) spawnCrate(g);
  }
  g.crates = g.crates.filter((c) => {
    const opener = g.players.find((p) => p.dead === 0 && dist2(p, c) < (p.r + CRATES.radius) ** 2);
    if (!opener) return true;
    openCrate(g, opener, c.x, c.y, rollLoot(g));
    return false;
  });
}

function spawnCrate(g: Game): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = (rand(g) * 2 - 1) * (FIELD.halfW - 70);
    const y = (rand(g) * 2 - 1) * (FIELD.halfH - 30);
    if (x * x + y * y < (FIELD.centerRadius + 20) ** 2) continue;
    const c = { id: g.nextId++, x, y };
    const clear = (o: { x: number; y: number }, r: number) => dist2(o, c) > (r + CRATES.radius + 20) ** 2;
    if (!g.players.every((p) => clear(p, PLAYER.radius)) || !g.crates.every((o) => clear(o, CRATES.radius)))
      continue;
    if (!clear(g.ball, BALL.radius)) continue;
    g.crates.push(c);
    return;
  }
}

function rollLoot(g: Game): ItemKind {
  const allowed = g.settings.loot?.length ? g.settings.loot : null;
  const table = allowed ? CRATES.loot.filter(([kind]) => allowed.includes(kind)) : CRATES.loot;
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rand(g) * total;
  for (const [kind, w] of table) {
    if ((r -= w) < 0) return kind;
  }
  return table[0]?.[0] ?? 'gun';
}

export function openCrate(g: Game, p: Player, x: number, y: number, kind: ItemKind): void {
  g.blasts.push({ x, y, kind, t: ITEMS.blastShow });
  switch (kind) {
    case 'gun':
      p.gun = ITEMS.gunAmmo;
      p.teleport = false;
      p.bazooka = false;
      break;
    case 'teleport':
      p.teleport = true;
      p.gun = 0;
      p.bazooka = false;
      break;
    case 'bazooka':
      p.bazooka = true;
      p.gun = 0;
      p.teleport = false;
      break;
    case 'ice':
      p.frozen = ITEMS.iceFreeze;
      p.vx = 0;
      p.vy = 0;
      break;
    case 'boost':
      p.boost = ITEMS.boost;
      break;
    case 'shield':
      p.shield = true;
      break;
    case 'power':
      p.power = true;
      break;
    case 'mine': {
      for (const body of [g.ball, ...g.players.filter((o) => o.dead === 0)]) {
        const dx = body.x - x;
        const dy = body.y - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > ITEMS.blastRadius) continue;
        const f = (ITEMS.blastPush * (1 - d / ITEMS.blastRadius)) / (d || 1);
        body.vx += dx * f;
        body.vy += dy * f;
      }
      if (p.dead === 0) p.slow = ITEMS.mineSlow;
      damage(g, p, ITEMS.mineDamage, 0, 0);
      break;
    }
  }
}

function rules(g: Game): void {
  const b = g.ball;
  if (g.phase === 'kickoff' && g.phaseT >= MATCH.kickoffLimit) g.phase = 'play';
  if (g.phase === 'play' && Math.abs(b.x) > FIELD.halfW + BALL.radius && Math.abs(b.y) < FIELD.goalHalf) {
    const scorer: Team = b.x > 0 ? 'red' : 'blue';
    g.score[scorer === 'red' ? 0 : 1]++;
    const toucher = g.players.find((p) => p.id === g.lastTouch);
    if (toucher && toucher.team === scorer) toucher.goals++;
    g.phase = 'goal';
    g.phaseT = 0;
    return;
  }
  if (g.phase === 'goal' && g.phaseT >= MATCH.goalPause) {
    const [r, bl] = g.score;
    if (r >= g.settings.scoreLimit || bl >= g.settings.scoreLimit || (g.clock === 0 && r !== bl)) {
      g.phase = 'over';
      g.phaseT = 0;
      return;
    }
    resetKickoff(g, b.x > 0 ? 'blue' : 'red');
    return;
  }
  if (g.phase === 'play' && g.clock === 0 && g.score[0] !== g.score[1]) {
    g.phase = 'over';
    g.phaseT = 0;
  }
}

export function winner(g: Game): Team | null {
  if (g.phase !== 'over') return null;
  return g.score[0] > g.score[1] ? 'red' : 'blue';
}
