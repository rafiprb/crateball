import { ITEMS, lavaHeat, puddleScale, type BlastKind, type Game } from '@crateball/sim';
import type { GameEvent } from './events';

/** Cosmetic only (client-side, Math.random is fine here). Fixed pool, no allocation per frame. */
const MAX = 900;

type Shape = 0 | 1 | 2 | 3 | 4; // dot, spark, shard, ring, bubble
interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  drag: number;
  rot: number;
  spin: number;
  shape: Shape;
  color: string;
  ground: boolean;
}

const ITEM_COLORS: Record<BlastKind, string[]> = {
  gun: ['#FFE066', '#FFF4E0', '#C88A4A'],
  mine: ['#FF6A3D', '#FFB760', '#FFE066', '#5A4A3A'],
  ice: ['#9BE3FF', '#E8F8FF', '#5FC8FF'],
  dizzy: ['#CFF6FF', '#9FE8C8', '#F2FFF8'],
  boost: ['#7CFF7A', '#D8FFD0'],
  shield: ['#7AF0FF', '#E0FDFF'],
  power: ['#FFA94D', '#FFE066'],
  teleport: ['#C77DFF', '#F2E0FF', '#8A4FFF'],
  bazooka: ['#7A8B5A', '#B8C890', '#FF9A3D'],
  rocket: ['#FF6A3D', '#FFB760', '#FFE066', '#3A2A22'],
  block: ['#7AF0FF', '#E0FDFF', '#FFFFFF'],
  warp: ['#C77DFF', '#F2E0FF', '#8A4FFF'],
  erupt: ['#FF6A3D', '#FFB760', '#FFE066', '#3A2A22'],
};
const TEAM = { red: ['#E8574A', '#FFB0A8', '#FFF4E0'], blue: ['#4A7DE8', '#A8C4FF', '#FFF4E0'] };
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export interface Particles {
  emit(e: GameEvent): void;
  ambient(g: Game, pos: (id: string) => { x: number; y: number } | null, dt: number): void;
  update(dt: number): void;
  draw(ctx: CanvasRenderingContext2D, ground: boolean): void;
  readonly count: number;
  /** Seconds of screen shake requested by the last big event. */
  takeShake(): number;
}

export function createParticles(): Particles {
  const pool: P[] = [];
  let shake = 0;
  let trailAcc = 0;

  const add = (p: Partial<P> & { x: number; y: number }) => {
    const full: P = {
      vx: 0,
      vy: 0,
      life: 0.5,
      max: 0.5,
      size: 3,
      grow: 0,
      drag: 3,
      rot: Math.random() * 6.28,
      spin: 0,
      shape: 0,
      color: '#FFF',
      ground: false,
      ...p,
    };
    full.max = full.life;
    if (pool.length >= MAX) pool.shift();
    pool.push(full);
  };

  const burst = (
    x: number,
    y: number,
    n: number,
    speed: [number, number],
    colors: string[],
    o: Partial<P> = {},
  ) => {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rnd(speed[0], speed[1]);
      add({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        color: pick(colors),
        ...o,
        life: rnd(0.6, 1) * (o.life ?? 0.5),
      });
    }
  };

  const ring = (x: number, y: number, color: string, size: number, life: number) =>
    add({ x, y, shape: 3, size, grow: size * 4, life, color, drag: 0 });

  /** Arena weather: rain streaks, ice glints, lava embers, wind streaks (world coordinates). */
  const W = 470;
  const Hh = 250;
  const weather = (g: Game, pos: (id: string) => { x: number; y: number } | null) => {
    const a = g.arena;
    switch (a.kind) {
      case 'rain': {
        for (let i = 0; i < 5; i++)
          add({
            x: rnd(-W, W),
            y: rnd(-Hh, Hh),
            vx: -60,
            vy: 420,
            shape: 1,
            size: 1.2,
            life: 0.18,
            drag: 0,
            color: 'rgba(200,225,255,.55)',
          });
        // Raindrop rings on the puddles.
        const p = a.puddles[Math.floor(Math.random() * a.puddles.length)];
        const k = p ? puddleScale(g, p) : 0;
        const q = p?.parts[Math.floor(Math.random() * p.parts.length)];
        if (p && q && k > 0.3 && Math.random() < 0.5)
          add({
            x: p.x + q.dx + rnd(-q.r, q.r) * 0.5 * k,
            y: p.y + q.dy + rnd(-q.r, q.r) * 0.5 * k,
            shape: 3,
            size: 1.5,
            grow: 14,
            life: 0.45,
            drag: 0,
            color: 'rgba(225,242,255,.7)',
            ground: true,
          });
        break;
      }
      case 'ice':
        if (Math.random() < 0.35)
          add({
            x: rnd(-W, W),
            y: rnd(-Hh, Hh),
            shape: 2,
            size: 3,
            life: 0.6,
            spin: 6,
            color: '#FFFFFF',
            ground: true,
          });
        // Ice shavings kicked up by running players; more when moving fast.
        for (const pl of g.players) {
          if (pl.dead > 0) continue;
          const at = pos(pl.id);
          const v = Math.hypot(pl.vx, pl.vy);
          if (!at || v < 0.5) continue;
          const back = 14 / v;
          for (let n = 0; n < (v > 1.8 ? 2 : 1); n++)
            add({
              x: at.x - pl.vx * back + rnd(-6, 6),
              y: at.y - pl.vy * back + rnd(-6, 6),
              vx: -pl.vx * rnd(15, 40) + rnd(-35, 35),
              vy: -pl.vy * rnd(15, 40) + rnd(-35, 35),
              shape: 2,
              size: rnd(3, 5.5),
              life: rnd(0.35, 0.7),
              drag: 4,
              spin: rnd(-12, 12),
              color: pick(['#FFFFFF', '#8FC3E3', '#5E9FCB', '#B5DCF2']),
              ground: true,
            });
        }
        break;
      case 'volcano':
        for (const st of a.streams) {
          if (st.flowing && Math.random() < 0.6)
            add({
              x: st.x + rnd(-8, 8),
              y: st.y + rnd(-8, 8),
              vy: -55,
              vx: rnd(-20, 20),
              size: 2.4,
              life: 0.9,
              drag: 0.5,
              color: pick(['#FFB760', '#FF6A3D', '#FFE066']),
            });
          const pt = st.points[Math.floor(Math.random() * st.points.length)];
          if (pt && lavaHeat(g, pt.born) > 0.4 && Math.random() < 0.3)
            add({
              x: pt.x + rnd(-9, 9),
              y: pt.y + rnd(-9, 9),
              vy: -35,
              vx: rnd(-10, 10),
              size: 1.8,
              life: 0.8,
              drag: 0.5,
              color: '#FFB760',
            });
        }
        if (Math.random() < 0.3)
          add({
            x: rnd(-W, W),
            y: rnd(-Hh, Hh),
            vy: -25,
            size: 1.6,
            life: 1.2,
            drag: 0,
            color: 'rgba(255,150,80,.7)',
          });
        break;
      case 'wind':
        for (let i = 0; i < 2; i++)
          add({
            x: rnd(-W, W) - a.wind.x * 200,
            y: rnd(-Hh, Hh) - a.wind.y * 200,
            vx: a.wind.x * 380,
            vy: a.wind.y * 380,
            shape: 1,
            size: 1.4,
            life: 0.6,
            drag: 0,
            color: 'rgba(255,255,255,.35)',
            ground: true,
          });
        break;
    }
  };

  return {
    get count() {
      return pool.length;
    },
    takeShake() {
      const s = shake;
      shake = 0;
      return s;
    },
    emit(e) {
      switch (e.type) {
        case 'kick':
          burst(
            e.x,
            e.y,
            e.power ? 22 : 10,
            [60, e.power ? 320 : 180],
            e.power ? ['#FFA94D', '#FFE066', '#FFF'] : ['#FFF', '#E8F0D8'],
            {
              shape: 1,
              size: 2,
              life: 0.35,
              drag: 5,
            },
          );
          ring(e.x, e.y, 'rgba(255,255,255,.7)', 8, 0.25);
          if (e.power) shake = Math.max(shake, 5);
          break;
        case 'shot': {
          const n = Math.hypot(e.vx, e.vy) || 1;
          for (let i = 0; i < 8; i++) {
            const sp = rnd(120, 300);
            const spread = rnd(-0.5, 0.5);
            add({
              x: e.x,
              y: e.y,
              vx: ((e.vx - e.vy * spread) / n) * sp,
              vy: ((e.vy + e.vx * spread) / n) * sp,
              shape: 1,
              size: 2,
              life: 0.15,
              color: pick(['#FFE066', '#FFF4E0', '#FF9A3D']),
              drag: 8,
            });
          }
          add({ x: e.x, y: e.y, size: 9, grow: -30, life: 0.08, color: '#FFF4C0', drag: 0 });
          break;
        }
        case 'hit':
          burst(e.x, e.y, 16, [80, 240], [...TEAM[e.team], '#FF5A6E'], {
            shape: 2,
            size: 4,
            life: 0.5,
            spin: 10,
          });
          ring(e.x, e.y, '#FF5A6E', 10, 0.3);
          shake = Math.max(shake, 3);
          break;
        case 'item': {
          const colors = ITEM_COLORS[e.kind];
          if (e.kind === 'warp') {
            // Teleport departure/arrival: a purple swirl, no crate involved.
            burst(e.x, e.y, 24, [40, 180], colors, { shape: 1, size: 2.5, life: 0.5, drag: 5 });
            ring(e.x, e.y, colors[0]!, 16, 0.35);
            break;
          }
          if (e.kind === 'block') {
            // The shield shatters: glassy shards fly off and a bright ring pops outwards.
            burst(e.x, e.y, 26, [90, 260], colors, { shape: 2, size: 5, life: 0.6, spin: 14, drag: 4 });
            ring(e.x, e.y, '#7AF0FF', 20, 0.35);
            ring(e.x, e.y, '#E0FDFF', 12, 0.25);
            shake = Math.max(shake, 4);
            break;
          }
          if (e.kind === 'erupt' || e.kind === 'rocket') {
            burst(e.x, e.y, 50, [120, 460], colors, { size: 6, grow: -6, life: 0.8, drag: 4 });
            burst(e.x, e.y, 22, [20, 100], ['#2A211C', '#4A3E36', '#6A5E50'], {
              size: 12,
              grow: 16,
              life: 1.4,
              drag: 2,
              ground: true,
            });
            ring(e.x, e.y, '#FF6A3D', 22, 0.4);
            shake = Math.max(shake, 14);
            break;
          }
          // Crate splinters for every opening.
          burst(e.x, e.y, 10, [60, 200], ['#C88A4A', '#7A4E22', '#E0B080'], {
            shape: 2,
            size: 4,
            life: 0.7,
            spin: 12,
          });
          if (e.kind === 'mine') {
            burst(e.x, e.y, 40, [100, 420], colors, { size: 5, grow: -6, life: 0.7, drag: 4 });
            burst(e.x, e.y, 18, [20, 90], ['#4A4038', '#6A5E50', '#8A7E70'], {
              size: 10,
              grow: 14,
              life: 1.2,
              drag: 2,
              ground: true,
            });
            ring(e.x, e.y, '#FFB760', ITEMS.blastRadius / 4, 0.35);
            shake = Math.max(shake, 12);
          } else if (e.kind === 'ice') {
            burst(e.x, e.y, 28, [80, 260], colors, { shape: 2, size: 5, life: 0.8, spin: 8, drag: 4 });
            ring(e.x, e.y, '#E8F8FF', 14, 0.4);
          } else {
            burst(e.x, e.y, 22, [60, 220], colors, { shape: 1, size: 2.5, life: 0.6 });
            ring(e.x, e.y, colors[0]!, 12, 0.35);
          }
          break;
        }
        case 'goal': {
          const colors = [...TEAM[e.team], '#FFE066'];
          for (let i = 0; i < 120; i++) {
            add({
              x: e.x + rnd(-20, 20),
              y: e.y + rnd(-60, 60),
              vx: -Math.sign(e.x) * rnd(80, 520),
              vy: rnd(-260, 260),
              shape: 2,
              size: rnd(3, 6),
              life: rnd(1.2, 2.2),
              spin: rnd(-14, 14),
              drag: 1.6,
              color: pick(colors),
            });
          }
          shake = Math.max(shake, 8);
          break;
        }
        case 'whistle':
        case 'warn':
        case 'scrape':
        case 'locked':
          break;
        case 'splash':
          burst(e.x, e.y, 10, [40, 140], ['#CDE8FF', '#8FC3E3', '#FFFFFF'], {
            size: 2,
            life: 0.35,
            drag: 5,
            ground: true,
          });
          ring(e.x, e.y, 'rgba(220,240,255,.8)', 8, 0.3);
          break;
        case 'sizzle':
          burst(e.x, e.y, 8, [20, 80], ['#FFB760', '#FF6A3D', '#5A4A3A'], { size: 2.5, life: 0.5, drag: 3 });
          break;
      }
    },
    ambient(g, pos, dt) {
      trailAcc += dt;
      const tick = trailAcc >= 1 / 60;
      if (!tick) return;
      trailAcc = 0;
      weather(g, pos);
      const b = pos('ball');
      const speed = Math.hypot(g.ball.vx, g.ball.vy);
      if (b && speed > 3)
        add({
          x: b.x,
          y: b.y,
          size: Math.min(9, speed * 0.9),
          grow: -16,
          life: 0.22,
          color: speed > 8 ? 'rgba(255,169,77,.5)' : 'rgba(255,255,255,.35)',
          drag: 0,
          ground: true,
        });
      for (const p of g.players) {
        if (p.dead > 0) continue;
        const at = pos(p.id);
        if (!at) continue;
        const v = Math.hypot(p.vx, p.vy);
        if (p.boost > 0)
          add({
            x: at.x,
            y: at.y,
            size: p.r * 0.7,
            grow: -20,
            life: 0.3,
            color: 'rgba(124,255,122,.35)',
            drag: 0,
            ground: true,
          });
        else if (v > 2 && Math.random() < 0.25)
          add({
            x: at.x - p.vx * 4 + rnd(-4, 4),
            y: at.y - p.vy * 4 + p.r * 0.5,
            size: 3,
            grow: 6,
            life: 0.4,
            color: 'rgba(220,240,200,.35)',
            drag: 2,
            ground: true,
          });
        // Dizzy: bubbles float up off the head and wobble side to side, like a drunk cartoon.
        if (p.dizzy > 0 && Math.random() < 0.28)
          add({
            x: at.x + rnd(-p.r * 0.5, p.r * 0.5),
            y: at.y - p.r - 2,
            vx: rnd(-8, 8),
            vy: rnd(-48, -32),
            shape: 4,
            size: rnd(2.5, 5),
            grow: 2.5,
            life: rnd(1.2, 1.8),
            drag: 0.25,
            spin: rnd(3, 6),
            color: 'rgba(225,245,255,.9)',
          });
        if (p.frozen > 0 && Math.random() < 0.3)
          add({
            x: at.x + rnd(-p.r, p.r),
            y: at.y + rnd(-p.r, p.r),
            shape: 2,
            size: 3,
            life: 0.5,
            vy: -30,
            color: '#E8F8FF',
            spin: 6,
          });
        if (p.power && Math.random() < 0.4)
          add({
            x: at.x + rnd(-p.r, p.r),
            y: at.y + rnd(-p.r, p.r),
            vy: -40,
            size: 2.5,
            life: 0.5,
            color: '#FFA94D',
          });
        if (p.slow > 0 && Math.random() < 0.15)
          add({
            x: at.x + rnd(-p.r, p.r),
            y: at.y - p.r,
            vy: -20,
            size: 4,
            grow: 6,
            life: 0.7,
            color: 'rgba(90,80,70,.5)',
          });
      }
      for (const bl of g.bullets)
        if (bl.rocket) {
          // Rocket: a fat smoke trail with sparks.
          add({ x: bl.x, y: bl.y, size: 5, grow: 14, life: 0.6, color: 'rgba(120,110,100,.45)', drag: 1 });
          if (Math.random() < 0.7)
            add({ x: bl.x, y: bl.y, size: 3, life: 0.2, color: pick(['#FF9A3D', '#FFE066']), drag: 0 });
        } else if (Math.random() < 0.6)
          add({ x: bl.x, y: bl.y, size: 2, life: 0.15, color: 'rgba(255,224,102,.6)', drag: 0 });
    },
    update(dt) {
      let w = 0;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i]!;
        p.life -= dt;
        if (p.life <= 0) continue;
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.size = Math.max(0.1, p.size + p.grow * dt);
        p.rot += p.spin * dt;
        pool[w++] = p;
      }
      pool.length = w;
    },
    draw(ctx, ground) {
      for (const p of pool) {
        if (p.ground !== ground) continue;
        ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.5);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = p.color;
        switch (p.shape) {
          case 0:
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            break;
          case 1:
            ctx.lineWidth = p.size;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
            ctx.stroke();
            break;
          case 2:
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            ctx.restore();
            break;
          case 3:
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.stroke();
            break;
          case 4: {
            // Bubble: a thin ring with a highlight, swaying as it rises.
            const bx = p.x + Math.sin(p.rot) * 5;
            ctx.lineWidth = 1.2;
            ctx.fillStyle = 'rgba(200,235,255,.18)';
            ctx.beginPath();
            ctx.arc(bx, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(bx - p.size * 0.35, p.y - p.size * 0.35, p.size * 0.25, 0, Math.PI * 2);
            ctx.fill();
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}
