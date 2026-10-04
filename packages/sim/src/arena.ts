import { ARENAS, FIELD, ITEMS, PLAYER, type ArenaKind } from './content/rules';
import type { Arena, Body, Game, LavaStream, Player, Puddle } from './types';

type Rand = () => number;

export const classicArena = (): Arena => ({
  kind: 'classic',
  puddles: [],
  streams: [],
  wind: { x: 0, y: 0 },
  windTurn: 0,
  nextSpawn: 0,
  nextEvent: 0,
  warn: null,
});

/**
 * Arena for each kickoff of a match. Every block holds each arena of the pool once in a shuffled
 * order, and a block never starts with the arena the previous one ended on. A match has at most
 * 2 × scoreLimit kickoffs (the first plus one after each goal; the last goal ends it).
 */
export function planArenas(
  rand: Rand,
  kickoffs: number,
  pool: readonly ArenaKind[] = ARENAS.kinds,
): ArenaKind[] {
  const kinds = ARENAS.kinds.filter((k) => pool.includes(k));
  if (!kinds.length) kinds.push('classic');
  const plan: ArenaKind[] = [];
  while (plan.length < kickoffs) {
    const block = [...kinds];
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [block[i], block[j]] = [block[j]!, block[i]!];
    }
    if (block.length > 1 && block[0] === plan.at(-1)) [block[0], block[1]] = [block[1]!, block[0]!];
    plan.push(...block);
  }
  return plan.slice(0, kickoffs);
}

/** Fresh state for an arena at kickoff. */
export function makeArena(g: Game, kind: ArenaKind, rand: Rand): Arena {
  const a: Arena = { ...classicArena(), kind };
  if (kind === 'rain') {
    // Start with a few puddles already part-way through their life.
    for (let i = 0; i < ARENAS.rain.minPuddles + 1; i++)
      spawnPuddle(g, a, rand, Math.floor(rand() * ARENAS.rain.minLife * 0.6));
    a.nextSpawn = g.tick + ARENAS.rain.spawnMinGap;
  }
  if (kind === 'volcano') {
    a.nextSpawn = g.tick;
    a.nextEvent = g.tick + ARENAS.volcano.eruptMinGap;
  }
  if (kind === 'wind') {
    // A random starting direction without trig: a random vector, normalised.
    const x = rand() * 2 - 1;
    const y = rand() * 2 - 1;
    const n = Math.sqrt(x * x + y * y) || 1;
    a.wind = { x: x / n, y: y / n };
  }
  return a;
}

// ---------- rain ----------

function spawnPuddle(g: Game, a: Arena, rand: Rand, age = 0): void {
  const r = ARENAS.rain;
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = (rand() * 2 - 1) * (FIELD.halfW - 70);
    const y = (rand() * 2 - 1) * (FIELD.halfH - 50);
    if (x * x + y * y < ARENAS.keepClearCenter ** 2) continue;
    if (Math.abs(x) > FIELD.halfW - ARENAS.keepClearBoxDepth && Math.abs(y) < ARENAS.keepClearBoxHalf)
      continue;
    if (a.puddles.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < 130 ** 2)) continue;
    const n = 3 + Math.floor(rand() * 3);
    const parts: Puddle['parts'] = [];
    for (let i = 0; i < n; i++) {
      // Offset along a random vector (no trig), wider than tall.
      const ox = rand() * 2 - 1;
      const oy = rand() * 2 - 1;
      const d = i === 0 ? 0 : (0.4 + rand() * 0.6) * r.partSpread;
      const len = Math.sqrt(ox * ox + oy * oy) || 1;
      parts.push({
        dx: (ox / len) * d * 1.6,
        dy: (oy / len) * d * 0.9,
        r: r.partMinR + rand() * (r.partMaxR - r.partMinR),
      });
    }
    const life = r.minLife + Math.floor(rand() * (r.maxLife - r.minLife));
    a.puddles.push({ x, y, parts, born: g.tick - Math.min(age, life - r.dryTicks), life });
    return;
  }
}

/** 0 → 1 while forming, 1 while it lasts, → 0 while drying. */
export function puddleScale(g: Game, p: Puddle): number {
  const age = g.tick - p.born;
  return Math.max(0, Math.min(1, age / ARENAS.rain.formTicks, (p.life - age) / ARENAS.rain.dryTicks));
}

export function inPuddle(g: Game, b: { x: number; y: number }): boolean {
  for (const p of g.arena.puddles) {
    const k = puddleScale(g, p);
    if (k <= 0.05) continue;
    for (const q of p.parts)
      if ((b.x - p.x - q.dx) ** 2 + (b.y - p.y - q.dy) ** 2 < (q.r * k) ** 2) return true;
  }
  return false;
}

// ---------- volcano ----------

/** 1 when fresh, 0 once cooled. */
export const lavaHeat = (g: Game, born: number) =>
  Math.max(0, 1 - (g.tick - born) / ARENAS.volcano.coolTicks);

export function inHotLava(g: Game, b: { x: number; y: number }): boolean {
  const r2 = ARENAS.volcano.lavaRadius ** 2;
  for (const s of g.arena.streams)
    for (const pt of s.points)
      if (lavaHeat(g, pt.born) > 0.25 && (b.x - pt.x) ** 2 + (b.y - pt.y) ** 2 < r2) return true;
  return false;
}

function spawnStream(a: Arena, rand: Rand): void {
  const x = (rand() * 2 - 1) * (FIELD.halfW - 90);
  if (a.streams.some((s) => s.flowing && Math.abs((s.points[0]?.x ?? s.x) - x) < 140)) return;
  // Straight down, tilted a little: a normalised (small sideways, 1) vector.
  const sx = (rand() * 2 - 1) * 0.35;
  const n = Math.sqrt(sx * sx + 1);
  a.streams.push({ x, y: -FIELD.halfH - 30, dx: sx / n, dy: 1 / n, turn: 0, flowing: true, points: [] });
}

function flowStream(g: Game, s: LavaStream, rand: Rand): void {
  const v = ARENAS.volcano;
  s.turn = Math.max(-v.maxTurn, Math.min(v.maxTurn, s.turn + (rand() * 2 - 1) * v.turnJitter));
  // Rotating by +turn swings a down-right heading back towards straight down (y grows downwards).
  if (Math.abs(s.dx) > v.maxSideways) s.turn = Math.sign(s.dx) * v.maxTurn * 1.25;
  if (Math.abs(s.x) > FIELD.halfW - 40) s.turn = Math.sign(s.x) * v.maxTurn;
  // Small-angle rotation, then renormalise (no trig).
  const dx = s.dx - s.dy * s.turn;
  const dy = s.dy + s.dx * s.turn;
  const n = Math.sqrt(dx * dx + dy * dy) || 1;
  s.dx = dx / n;
  s.dy = Math.max(0.2, dy / n);
  s.x += s.dx * v.streamSpeed;
  s.y += s.dy * v.streamSpeed;
  s.sinceStep = (s.sinceStep ?? 0) + 1;
  if (s.sinceStep >= v.pointEvery) {
    s.sinceStep = 0;
    s.points.push({ x: Math.round(s.x), y: Math.round(s.y), born: g.tick });
  }
  if (s.y > FIELD.halfH + 30) s.flowing = false;
}

function erupt(
  g: Game,
  x: number,
  y: number,
  damage: (p: Player, n: number, kx: number, ky: number) => void,
): void {
  const v = ARENAS.volcano;
  g.blasts.push({ x, y, kind: 'erupt', t: ITEMS.blastShow });
  const bodies: Array<Body | Player> = [g.ball, ...g.players.filter((p) => p.dead === 0)];
  for (const body of bodies) {
    const dx = body.x - x;
    const dy = body.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > v.eruptRadius) continue;
    const f = (v.eruptPush * (1 - d / v.eruptRadius)) / (d || 1);
    const kx = dx * f;
    const ky = dy * f;
    if ('team' in body && d < v.eruptDamageRadius) damage(body, 1, kx, ky);
    else {
      body.vx += kx;
      body.vy += ky;
    }
  }
}

// ---------- shared ----------

/** Movement multiplier from the ground under the player. */
export function arenaAccel(g: Game, p: Player): number {
  switch (g.arena.kind) {
    case 'ice':
      return ARENAS.ice.accel;
    case 'rain':
      return inPuddle(g, p) ? ARENAS.rain.puddleAccel : ARENAS.rain.accel;
    case 'volcano':
      return inHotLava(g, p) ? ARENAS.volcano.lavaAccel : 1;
    default:
      return 1;
  }
}

export function playerDamping(g: Game): number {
  if (g.arena.kind === 'rain') return ARENAS.rain.playerDamping;
  if (g.arena.kind === 'ice') return ARENAS.ice.playerDamping;
  return PLAYER.damping;
}

export function ballDamping(g: Game, normal: number): number {
  if (g.arena.kind === 'rain')
    return inPuddle(g, g.ball) ? ARENAS.rain.puddleBallDamping : ARENAS.rain.ballDamping;
  if (g.arena.kind === 'ice') return ARENAS.ice.ballDamping;
  return normal;
}

/**
 * Per-tick arena life: puddles form and dry, lava creeks flow and cool, eruptions on hot lava, the
 * wind turns. `damage` is the game's own damage function (shields, deaths).
 */
export function updateArena(
  g: Game,
  rand: Rand,
  damage: (p: Player, n: number, kx: number, ky: number) => void,
): void {
  const a = g.arena;
  const live = g.phase === 'play';
  switch (a.kind) {
    case 'rain': {
      const r = ARENAS.rain;
      a.puddles = a.puddles.filter((p) => g.tick - p.born < p.life);
      if (g.tick >= a.nextSpawn && a.puddles.length < r.maxPuddles) {
        spawnPuddle(g, a, rand);
        a.nextSpawn = g.tick + r.spawnMinGap + Math.floor(rand() * (r.spawnMaxGap - r.spawnMinGap));
      }
      if (a.puddles.length < r.minPuddles) spawnPuddle(g, a, rand);
      break;
    }
    case 'wind': {
      const w = ARENAS.wind;
      a.windTurn = Math.max(-w.maxTurn, Math.min(w.maxTurn, a.windTurn + (rand() * 2 - 1) * w.turnJitter));
      const x = a.wind.x - a.wind.y * a.windTurn;
      const y = a.wind.y + a.wind.x * a.windTurn;
      const n = Math.sqrt(x * x + y * y) || 1;
      a.wind = { x: x / n, y: y / n };
      if (live) {
        g.ball.vx += a.wind.x * w.force;
        g.ball.vy += a.wind.y * w.force;
      }
      break;
    }
    case 'volcano': {
      const v = ARENAS.volcano;
      if (g.tick >= a.nextSpawn && a.streams.filter((s) => s.flowing).length < v.maxStreams) {
        spawnStream(a, rand);
        a.nextSpawn = g.tick + v.streamMinGap + Math.floor(rand() * (v.streamMaxGap - v.streamMinGap));
      }
      for (const s of a.streams) if (s.flowing) flowStream(g, s, rand);
      // Points fade after cooling; a finished stream goes once its last point is gone.
      const gone = v.coolTicks + v.fadeTicks;
      for (const s of a.streams) s.points = s.points.filter((pt) => g.tick - pt.born < gone);
      a.streams = a.streams.filter((s) => s.flowing || s.points.length > 0);
      if (!live || g.tick < a.nextEvent) break;
      if (!a.warn) {
        // Only on hot lava inside the pitch; none yet → look again in a second.
        const hot = a.streams.flatMap((s) =>
          s.points.filter(
            (pt) =>
              lavaHeat(g, pt.born) > 0.45 && Math.abs(pt.x) < FIELD.halfW && Math.abs(pt.y) < FIELD.halfH,
          ),
        );
        const pick = hot[Math.floor(rand() * hot.length)];
        if (!pick) a.nextEvent = g.tick + 60;
        else {
          a.warn = { x: pick.x, y: pick.y };
          a.nextEvent = g.tick + v.warning;
        }
        break;
      }
      erupt(g, a.warn.x, a.warn.y, damage);
      a.warn = null;
      a.nextEvent = g.tick + v.eruptMinGap + Math.floor(rand() * (v.eruptMaxGap - v.eruptMinGap));
      break;
    }
  }
}
