import {
  BALL,
  CRATES,
  FIELD,
  ITEMS,
  PLAYER,
  KICK,
  TICK_HZ,
  gunTarget,
  hasWeapon,
  kickDirection,
  type Game,
  ARENAS,
  type ArenaKind,
  lavaHeat,
  puddleScale,
  type BlastKind,
  type Role,
  type Team,
} from '@crateball/sim';
import type { Particles } from './particles';
import type { Predictor } from './predict';

export const COLORS = {
  red: '#E8574A',
  blue: '#4A7DE8',
  grassA: '#5E9A48',
  grassB: '#588F43',
  outside: '#4A7A3A',
  line: 'rgba(255,255,255,.85)',
  ball: '#FFFFFF',
  crate: '#C88A4A',
  crateEdge: '#7A4E22',
  bullet: '#FFE066',
  ink: '#1B2133',
  ice: 'rgba(170,225,255,.65)',
};

const ITEM_STYLE: Record<BlastKind, [string, string]> = {
  gun: ['#FFE066', 'GUN!'],
  mine: ['#FF6A3D', 'BOOM!'],
  ice: ['#9BE3FF', 'FROZEN!'],
  dizzy: ['#9FE8C8', 'DIZZY!'],
  boost: ['#7CFF7A', 'SPEED!'],
  shield: ['#7AF0FF', 'SHIELD!'],
  power: ['#FFA94D', 'POWER KICK!'],
  teleport: ['#C77DFF', 'TELEPORT!'],
  bazooka: ['#B8C890', 'BAZOOKA!'],
  rocket: ['#FF6A3D', 'BOOM!'],
  block: ['#7AF0FF', 'BLOCKED!'],
  save: ['#7CFF7A', 'SAVE!'],
  warp: ['#C77DFF', ''],
  erupt: ['#FF6A3D', 'ERUPTION!'],
};

/** Ground colours and the line shown at kickoff for each arena. */
const ARENA_LOOK: Record<
  ArenaKind,
  { outside: string; grassA: string; grassB: string; line: string; name: string; hint: string }
> = {
  classic: {
    outside: '#4A7A3A',
    grassA: '#5E9A48',
    grassB: '#588F43',
    line: 'rgba(255,255,255,.85)',
    name: 'Classic',
    hint: 'A normal pitch',
  },
  rain: {
    outside: '#3A5A3A',
    grassA: '#4C7A47',
    grassB: '#46713F',
    line: 'rgba(235,245,255,.75)',
    name: 'Rain',
    hint: 'Wet and slippery — puddles slow you and the ball',
  },
  volcano: {
    outside: '#211915',
    grassA: '#3B2F2A',
    grassB: '#342923',
    line: 'rgba(255,205,170,.6)',
    name: 'Volcano',
    hint: 'Lava slows you down — and it erupts',
  },
  ice: {
    outside: '#8FB9CF',
    grassA: '#D3EAF5',
    grassB: '#C6E2F0',
    line: 'rgba(40,90,140,.75)',
    name: 'Ice',
    hint: 'Hard to stop — the ball barely slows down',
  },
  wind: {
    outside: '#4F8540',
    grassA: '#69A653',
    grassB: '#629C4C',
    line: 'rgba(255,255,255,.85)',
    name: 'Wind',
    hint: 'The wind pushes the ball — watch the arrow',
  },
};

const ROLE_STYLE: Record<Role, [string, string]> = {
  gk: ['GK', 'Keeper: catches hard shots near your goal'],
  def: ['DF', 'Defender: shoulder charge in your half'],
  mid: ['MF', 'Midfielder: soft first touch + pass lock in midfield'],
  fwd: ['FW', 'Forward: fastest, near misses curl inside the post'],
  none: ['', 'No role'],
};

const HUD_H = 56;
const MAX_DPR = 2;
const MAX_PIXELS = 3840 * 2160;
const W = FIELD.halfW + FIELD.marginX + 10;
const H = FIELD.halfH + FIELD.margin + 10;

export interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  /** `banners: false` leaves out the centre-screen words (GOAL!, the countdown) and the wind pill: the
   * trailer frames its own shots and would cut them in half. */
  draw(p: Predictor, alpha: number, fx: Particles, hud: { rtt: number | null; banners?: boolean }): void;
  /** A chat line from a player: shown in a speech bubble above them for a few seconds. */
  say(id: string, text: string): void;
}

/** Chat bubbles: how long one stays (the last part fades) and how wide it may get, in pitch pixels. */
const BUBBLE_MS = 4500;
const BUBBLE_FADE_MS = 600;
const BUBBLE_MAX_W = 150;
const BUBBLE_LINES = 3;

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  let pitch: HTMLCanvasElement | null = null;
  let pitchKind: ArenaKind | null = null;
  let scale = 1;
  let cx = 0;
  let cy = 0;
  let dpr = 1;
  let shake = 0;

  const buildPitch = (kind: ArenaKind) => {
    const look = ARENA_LOOK[kind];
    pitchKind = kind;
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d')!;
    g.fillStyle = look.outside;
    g.fillRect(0, 0, c.width, c.height);
    g.setTransform(scale, 0, 0, scale, cx, cy);
    const { halfW, halfH, goalHalf, goalDepth, centerRadius, postRadius } = FIELD;
    const stripe = (halfW * 2) / 12;
    for (let i = 0; i < 12; i++) {
      g.fillStyle = i % 2 ? look.grassA : look.grassB;
      g.fillRect(-halfW + i * stripe, -halfH, stripe + 0.5, halfH * 2);
    }
    g.strokeStyle = look.line;
    g.lineWidth = 3;
    g.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
    g.beginPath();
    g.moveTo(0, -halfH);
    g.lineTo(0, halfH);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, centerRadius, 0, Math.PI * 2);
    g.stroke();
    for (const s of [-1, 1]) {
      g.strokeStyle = look.line;
      g.lineWidth = 3;
      g.strokeRect(s > 0 ? halfW - 90 : -halfW, -130, 90, 260);
      // Net
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(s > 0 ? halfW : -halfW - goalDepth, -goalHalf, goalDepth, goalHalf * 2);
      g.strokeStyle = 'rgba(255,255,255,.35)';
      g.lineWidth = 1;
      for (let y = -goalHalf; y <= goalHalf; y += 10) {
        g.beginPath();
        g.moveTo(s * halfW, y);
        g.lineTo(s * (halfW + goalDepth), y);
        g.stroke();
      }
      g.strokeStyle = look.line;
      g.lineWidth = 3;
      g.strokeRect(s > 0 ? halfW : -halfW - goalDepth, -goalHalf, goalDepth, goalHalf * 2);
      for (const sy of [-1, 1]) {
        g.beginPath();
        g.arc(s * halfW, sy * goalHalf, postRadius, 0, Math.PI * 2);
        g.fillStyle = s < 0 ? COLORS.red : COLORS.blue;
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = COLORS.ink;
        g.stroke();
      }
    }
    pitch = c;
  };

  const circle = (x: number, y: number, r: number, fill: string, stroke?: string, lw = 2) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  };

  const text = (s: string, x: number, y: number, size: number, color: string, weight = 700) => {
    ctx.font = `${weight} ${size}px 'Baloo 2', Nunito, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = 'rgba(20,24,40,.85)';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  };

  /** Puddles and lava are unions of circles, drawn on a layer so their overlaps do not darken. */
  const layer = document.createElement('canvas');
  const freshLayer = () => {
    if (layer.width !== canvas.width || layer.height !== canvas.height) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const l = layer.getContext('2d')!;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.clearRect(0, 0, layer.width, layer.height);
    l.setTransform(ctx.getTransform());
    return l;
  };
  const blitLayer = (alpha: number) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  };
  const fillCircles = (l: CanvasRenderingContext2D, list: Array<[number, number, number]>, fill: string) => {
    l.fillStyle = fill;
    for (const [x, y, r] of list) {
      if (r <= 0) continue;
      l.beginPath();
      l.arc(x, y, r, 0, Math.PI * 2);
      l.fill();
    }
  };

  const drawArena = (g: Game, now: number) => {
    const a = g.arena;
    if (a.kind === 'rain' && a.puddles.length) {
      const l = freshLayer();
      const parts: Array<[number, number, number]> = [];
      for (const p of a.puddles) {
        const k = puddleScale(g, p);
        for (const q of p.parts) parts.push([p.x + q.dx, p.y + q.dy, q.r * k]);
      }
      fillCircles(
        l,
        parts.map(([x, y, r]) => [x, y, r > 0 ? r + 2.5 : 0]),
        'rgb(205,232,255)',
      );
      fillCircles(l, parts, 'rgb(70,128,205)');
      l.fillStyle = 'rgba(255,255,255,.35)';
      for (const p of a.puddles) {
        const k = puddleScale(g, p);
        const q = p.parts[0];
        if (!q || k <= 0) continue;
        l.beginPath();
        l.ellipse(
          p.x + q.dx - q.r * 0.3 * k,
          p.y + q.dy - q.r * 0.35 * k,
          q.r * 0.35 * k,
          q.r * 0.15 * k,
          -0.4,
          0,
          Math.PI * 2,
        );
        l.fill();
      }
      blitLayer(0.55);
    }
    if (a.kind === 'volcano' && a.streams.length) {
      const l = freshLayer();
      const v = ARENAS.volcano;
      const gone = v.coolTicks + v.fadeTicks;
      // Cooling crust underneath (dark red → black, then fading), hot core on top.
      for (const st of a.streams)
        for (const pt of st.points) {
          const h = lavaHeat(g, pt.born);
          const fade = Math.min(1, (gone - (g.tick - pt.born)) / v.fadeTicks);
          l.fillStyle = `rgba(${Math.round(40 + 140 * h)},${Math.round(25 + 20 * h)},20,${fade})`;
          l.beginPath();
          l.arc(pt.x, pt.y, v.lavaRadius + 3, 0, Math.PI * 2);
          l.fill();
        }
      for (const st of a.streams)
        for (const pt of st.points) {
          const h = lavaHeat(g, pt.born);
          if (h <= 0) continue;
          const pulse = 0.85 + Math.sin(now / 250 + pt.x * 0.05) * 0.15;
          l.fillStyle = `rgba(255,${Math.round(90 + 120 * h * pulse)},${Math.round(30 + 60 * h)},${Math.min(1, h * 1.6)})`;
          l.beginPath();
          l.arc(pt.x, pt.y, v.lavaRadius * (0.55 + 0.4 * h), 0, Math.PI * 2);
          l.fill();
        }
      blitLayer(1);
      for (const st of a.streams) if (st.flowing) circle(st.x, st.y, 9, 'rgba(255,230,140,.9)');
    }
    const w = g.arena.warn;
    if (w) {
      const k = (now / 120) % 2 < 1;
      ctx.setLineDash([10, 8]);
      circle(w.x, w.y, ARENAS.volcano.eruptRadius, 'rgba(255,80,40,.12)', k ? '#FF5A3D' : '#FFB760', 3);
      ctx.setLineDash([]);
      text('!', w.x, w.y, 34, '#FF5A3D', 800);
    }
  };

  const drawWorld = (g: Game, pr: Predictor, alpha: number, now: number, fx: Particles) => {
    drawArena(g, now);
    for (const c of g.crates) {
      const r = CRATES.radius;
      const bob = Math.sin(now / 300 + c.id) * 1.5;
      ctx.save();
      ctx.translate(c.x, c.y + bob);
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      ctx.fillRect(-r + 2, -r + 4 - bob, r * 2, r * 2);
      ctx.fillStyle = COLORS.crate;
      ctx.strokeStyle = COLORS.crateEdge;
      ctx.lineWidth = 2.5;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.beginPath();
      ctx.moveTo(-r, -r);
      ctx.lineTo(r, r);
      ctx.moveTo(r, -r);
      ctx.lineTo(-r, r);
      ctx.stroke();
      ctx.restore();
      text('?', c.x, c.y + bob, 18, '#FFF4E0', 800);
    }
    for (const b of g.bullets) {
      if (b.rocket) {
        // A fat rocket with a flame at the back.
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(Math.atan2(b.vy, b.vx));
        ctx.fillStyle = now % 120 < 60 ? '#FFB760' : '#FF6A3D';
        ctx.beginPath();
        ctx.moveTo(-ITEMS.rocketRadius - 9, 0);
        ctx.lineTo(-ITEMS.rocketRadius, -4);
        ctx.lineTo(-ITEMS.rocketRadius, 4);
        ctx.fill();
        ctx.fillStyle = '#5E6B45';
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(
          -ITEMS.rocketRadius - 2,
          -ITEMS.rocketRadius * 0.7,
          ITEMS.rocketRadius * 2 + 2,
          ITEMS.rocketRadius * 1.4,
          3,
        );
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#E8574A';
        ctx.beginPath();
        ctx.arc(ITEMS.rocketRadius, 0, ITEMS.rocketRadius * 0.7, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.strokeStyle = 'rgba(255,224,102,.45)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(b.x - b.vx * 1.5, b.y - b.vy * 1.5);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      circle(b.x, b.y, ITEMS.bulletRadius, COLORS.bullet, COLORS.ink, 1.5);
    }
    fx.draw(ctx, true);
    for (const p of g.players) {
      if (p.dead > 0) continue;
      const pos = pr.pos(p.id, alpha) ?? p;
      const me = p.id === pr.me;
      const r = p.r;
      if (p.buff) circle(pos.x, pos.y, r + 3, 'rgba(255,244,224,.28)');
      if (p.boost > 0) circle(pos.x - p.vx * 3, pos.y - p.vy * 3, r * 0.8, 'rgba(124,255,122,.35)');
      if (me) circle(pos.x, pos.y, r + 7, 'rgba(255,255,255,.18)');
      if (p.power) circle(pos.x, pos.y, r + 4 + Math.sin(now / 80) * 1.5, 'rgba(255,169,77,.55)');
      const kicking = (p.input & KICK) !== 0 && p.frozen === 0;
      circle(pos.x, pos.y, r, COLORS[p.team], kicking ? '#FFFFFF' : COLORS.ink, kicking ? 3 : 2);
      if (p.gun > 0) {
        const aim = gunTarget(g, p);
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(aim ? Math.atan2(aim.y - p.y, aim.x - p.x) : Math.atan2(p.fy, p.fx));
        ctx.fillStyle = '#2A2F3A';
        ctx.fillRect(r - 4, -3, 14, 6);
        ctx.restore();
      }
      if (p.bazooka) {
        // A fat tube with a red warhead, pointing at whoever it is locked on to.
        const aim = gunTarget(g, p);
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(aim ? Math.atan2(aim.y - p.y, aim.x - p.x) : Math.atan2(p.fy, p.fx));
        ctx.fillStyle = '#5E6B45';
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1.5;
        ctx.fillRect(r - 8, -6, 24, 12);
        ctx.strokeRect(r - 8, -6, 24, 12);
        ctx.fillStyle = '#E8574A';
        ctx.beginPath();
        ctx.arc(r + 16, 0, 5, -Math.PI / 2, Math.PI / 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      if (p.teleport) {
        // A small orb on the side the blink will go (the direction you are pressing / last moved).
        circle(pos.x + p.fx * (r + 7), pos.y + p.fy * (r + 7), 4, '#C77DFF', '#F2E0FF', 1.5);
      }
      if (p.shield) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#7AF0FF';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (p.frozen > 0) {
        ctx.fillStyle = COLORS.ice;
        ctx.strokeStyle = '#E8F8FF';
        ctx.lineWidth = 2;
        ctx.fillRect(pos.x - r - 3, pos.y - r - 3, (r + 3) * 2, (r + 3) * 2);
        ctx.strokeRect(pos.x - r - 3, pos.y - r - 3, (r + 3) * 2, (r + 3) * 2);
      }
      if (p.slow > 0) text('~', pos.x, pos.y - r - 12, 16, '#C59BFF', 800);
      for (let i = 0; i < PLAYER.maxHp; i++)
        circle(pos.x - 8 + i * 8, pos.y - r - 5, 2.6, i < p.hp ? '#FF5A6E' : 'rgba(0,0,0,.35)');
      if (g.settings.roles !== false)
        text(ROLE_STYLE[p.role][0], pos.x, pos.y + 1, 10, p.buff ? '#FFF4E0' : 'rgba(255,244,224,.55)', 800);
      text(p.name, pos.x, pos.y + r + 10, 11, me ? '#FFF4E0' : 'rgba(255,244,224,.85)', 700);
    }
    const bp = pr.pos('ball', alpha) ?? g.ball;
    circle(bp.x + 2, bp.y + 3, BALL.radius, 'rgba(0,0,0,.25)');
    circle(bp.x, bp.y, BALL.radius, COLORS.ball, COLORS.ink, 2);
    // Someone has me in their sights: a red warning above my player.
    const myself = g.players.find((p) => p.id === pr.me);
    const hunted =
      myself &&
      myself.dead === 0 &&
      g.players.some(
        (e) => e.team !== myself.team && e.dead === 0 && hasWeapon(e) && gunTarget(g, e)?.id === myself.id,
      );
    const mp = hunted ? pr.pos(myself.id, alpha) : null;
    if (mp && myself) {
      const blink = Math.sin(now / 90) > -0.2;
      if (blink) {
        const y = mp.y - myself.r - 26;
        ctx.fillStyle = '#E8574A';
        ctx.strokeStyle = '#1B2133';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mp.x, y - 11);
        ctx.lineTo(mp.x + 11, y + 8);
        ctx.lineTo(mp.x - 11, y + 8);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        text('!', mp.x, y + 1, 15, '#FFF4E0', 800);
      }
    }
    // Gun auto-aim: a small crosshair on whoever my next shot will go to.
    const shooter = g.players.find((p) => p.id === pr.me);
    const target = shooter && hasWeapon(shooter) && shooter.dead === 0 ? gunTarget(g, shooter) : null;
    const tp = target ? pr.pos(target.id, alpha) : null;
    if (tp) {
      const rr = PLAYER.radius + 9 + Math.sin(now / 150) * 1.5;
      ctx.strokeStyle = '#FFE066';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        ctx.beginPath();
        ctx.moveTo(tp.x + dx * (rr - 4), tp.y + dy * (rr - 4));
        ctx.lineTo(tp.x + dx * (rr + 5), tp.y + dy * (rr + 5));
        ctx.stroke();
      }
    }
    // Aim arrow: where my kick would send the ball. For a midfielder (the playmaker) it turns gold and
    // rings the teammate on an assisted pass; for a forward in their zone it turns green when the shot is
    // on target (near misses included: the finisher bends those in) and marks the spot on the goal line.
    const mine = g.players.find((p) => p.id === pr.me);
    const aim = mine && mine.dead === 0 && mine.frozen === 0 ? kickDirection(g, mine) : null;
    if (aim) {
      const rolesOn = g.settings.roles !== false;
      const showPass = aim.to !== null && mine?.role === 'mid' && rolesOn;
      let onTarget: number | null = null;
      if (mine?.role === 'fwd' && mine.buff && rolesOn && aim.to === null) {
        const goalX = (mine.team === 'red' ? 1 : -1) * FIELD.halfW;
        if (aim.x * (goalX - bp.x) > 0) {
          const y = bp.y + (aim.y / aim.x) * (goalX - bp.x);
          if (Math.abs(y) < FIELD.goalHalf) onTarget = y;
        }
      }
      const color = showPass ? '#FFE066' : onTarget !== null ? '#7CFF7A' : 'rgba(255,255,255,.75)';
      if (onTarget !== null && mine) {
        const goalX = (mine.team === 'red' ? 1 : -1) * FIELD.halfW;
        const pulse = 1 + Math.sin(now / 90) * 0.15;
        ctx.strokeStyle = 'rgba(124,255,122,.85)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(goalX, onTarget, 7 * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(goalX, onTarget - 12 * pulse);
        ctx.lineTo(goalX, onTarget + 12 * pulse);
        ctx.stroke();
      }
      const sx = bp.x + aim.x * (BALL.radius + 4);
      const sy = bp.y + aim.y * (BALL.radius + 4);
      const ex = sx + aim.x * 17;
      const ey = sy + aim.y * 17;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex + aim.x * 6, ey + aim.y * 6);
      ctx.lineTo(ex - aim.y * 5, ey + aim.x * 5);
      ctx.lineTo(ex + aim.y * 5, ey - aim.x * 5);
      ctx.fill();
      const mate = showPass && aim.to ? pr.pos(aim.to, alpha) : null;
      if (mate) {
        ctx.beginPath();
        ctx.arc(mate.x, mate.y, PLAYER.radius + 8, 0, Math.PI * 2);
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    for (const b of g.blasts) {
      const [color, label] = ITEM_STYLE[b.kind];
      const k = 1 - b.t / ITEMS.blastShow;
      ctx.globalAlpha = 1 - k;
      if (b.kind === 'rocket') circle(b.x, b.y, 40 * (0.3 + k * 0.7), 'rgba(255,106,61,.35)');
      if (b.kind === 'mine') circle(b.x, b.y, ITEMS.blastRadius * (0.3 + k * 0.7), 'rgba(255,106,61,.35)');
      if (b.kind === 'warp') circle(b.x, b.y, PLAYER.radius + 6 * (1 - k), 'rgba(199,125,255,.4)');
      ctx.beginPath();
      ctx.arc(b.x, b.y, 10 + k * 40, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      if (label) text(label, b.x, b.y - 24 - k * 24, 16, color, 800);
      ctx.globalAlpha = 1;
    }
    fx.draw(ctx, false);
    drawBubbles(g, pr, alpha, now);
  };

  const bubbles = new Map<string, { text: string; at: number }>();
  /** Greedy word wrap into at most BUBBLE_LINES lines; the last one ends in … if text is left over. */
  const wrap = (s: string): string[] => {
    const lines: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= BUBBLE_MAX_W) line = next;
      else {
        if (line) lines.push(line);
        line = word;
        // A single word wider than the bubble: cut it.
        while (ctx.measureText(line).width > BUBBLE_MAX_W && line.length > 1) line = line.slice(0, -1);
      }
      if (lines.length === BUBBLE_LINES) break;
    }
    if (line && lines.length < BUBBLE_LINES) lines.push(line);
    if (lines.join(' ').length < s.trim().length) {
      let last = lines[lines.length - 1] ?? '';
      while (last && ctx.measureText(`${last}…`).width > BUBBLE_MAX_W) last = last.slice(0, -1);
      lines[lines.length - 1] = `${last}…`;
    }
    return lines;
  };
  const drawBubbles = (g: Game, pr: Predictor, alpha: number, now: number) => {
    for (const [id, b] of bubbles) {
      const age = now - b.at;
      if (age > BUBBLE_MS) {
        bubbles.delete(id);
        continue;
      }
      const p = g.players.find((o) => o.id === id);
      if (!p || p.dead > 0) continue;
      const pos = pr.pos(id, alpha) ?? p;
      ctx.globalAlpha = Math.min(1, (BUBBLE_MS - age) / BUBBLE_FADE_MS, age / 120);
      ctx.font = `700 11px 'Baloo 2', Nunito, system-ui, sans-serif`;
      const lines = wrap(b.text);
      const lh = 12;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      const h = lines.length * lh + 8;
      // Above the hp dots; kept inside the play area so it never leaves the screen.
      const bx = Math.max(-W + w / 2, Math.min(W - w / 2, pos.x));
      const by = pos.y - p.r - 14 - h / 2;
      ctx.fillStyle = '#FFF4E0';
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(bx - w / 2, by - h / 2, w, h, 7);
      ctx.fill();
      ctx.stroke();
      // Tail pointing down at the speaker.
      const tx = Math.max(bx - w / 2 + 8, Math.min(bx + w / 2 - 8, pos.x));
      ctx.beginPath();
      ctx.moveTo(tx - 5, by + h / 2 - 0.5);
      ctx.lineTo(tx, by + h / 2 + 6);
      ctx.lineTo(tx + 5, by + h / 2 - 0.5);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(tx - 5, by + h / 2);
      ctx.lineTo(tx, by + h / 2 + 6);
      ctx.lineTo(tx + 5, by + h / 2);
      ctx.stroke();
      ctx.fillStyle = COLORS.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => ctx.fillText(l, bx, by - h / 2 + 4 + lh / 2 + i * lh));
      ctx.globalAlpha = 1;
    }
  };

  const drawHud = (g: Game, pr: Predictor, w: number, banners = true) => {
    const mid = w / 2;
    ctx.fillStyle = 'rgba(20,24,40,.82)';
    ctx.beginPath();
    ctx.roundRect(mid - 170, 8, 340, HUD_H - 16, 14);
    ctx.fill();
    text(String(g.score[0]), mid - 60, HUD_H / 2, 30, COLORS.red, 800);
    text(String(g.score[1]), mid + 60, HUD_H / 2, 30, COLORS.blue, 800);
    const timed = g.settings.minutes > 0;
    // No time limit: the clock shows the time played (floor), and nothing is ever in a hurry.
    const secs = timed ? Math.ceil(g.clock / TICK_HZ) : Math.floor(g.clock / TICK_HZ);
    const golden = timed && g.clock === 0;
    const clock = golden ? 'GOLDEN GOAL' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const hurry = timed && g.clock > 0 && secs <= 30;
    text(clock, mid, HUD_H / 2, golden ? 15 : 22, hurry ? '#FF6A5E' : '#FFF4E0', 800);
    text('RED', mid - 130, HUD_H / 2, 14, COLORS.red, 800);
    text('BLUE', mid + 130, HUD_H / 2, 14, COLORS.blue, 800);
    const me = g.players.find((p) => p.id === pr.me);
    const h = canvas.height / dpr;
    if (me) {
      const bits: string[] = [];
      if (g.settings.roles !== false) bits.push(`${ROLE_STYLE[me.role][1]}${me.buff ? ' ✓' : ''}`);
      if (me.dead > 0) bits.push(`Respawn in ${Math.ceil(me.dead / TICK_HZ)}…`);
      if (me.gun > 0) bits.push(`Gun ×${me.gun} [E/Shift]`);
      if (me.teleport) bits.push('Teleport: blink [E/Shift]');
      if (me.bazooka) bits.push('Bazooka: homing rocket [E/Shift]');
      if (me.power) bits.push('Power kick ready');
      if (me.shield) bits.push('Shield');
      if (me.boost > 0) bits.push('Speed');
      if (me.slow > 0) bits.push('Slowed');
      if (me.frozen > 0) bits.push('Frozen');
      if (me.dizzy > 0) bits.push('Dizzy: keys reversed!');
      if (bits.length) text(bits.join('  ·  '), mid, h - 44, 18, '#FFF4E0', 800);
    } else if (pr.me)
      text('Spectating — you can join a team when the match is over', mid, h - 44, 18, '#FFF4E0', 800);
    ctx.globalAlpha = 0.6;
    ctx.textAlign = 'left';
    ctx.font = '600 12px Nunito, system-ui, sans-serif';
    ctx.fillStyle = '#FFF4E0';
    ctx.fillText(
      'Move: WASD/Arrows · Kick: Space/X · Use item: E/Shift · Chat: Enter · Role: 1 GK 2 DF 3 MF 4 FW 5 none · Report a glitch: R',
      12,
      h - 14,
    );
    ctx.globalAlpha = 1;
    let banner = '';
    let color = '#FFF4E0';
    if (g.phase === 'goal') {
      const scorer: Team = g.ball.x > 0 ? 'red' : 'blue';
      banner = 'GOAL!';
      color = COLORS[scorer];
    } else if (g.phase === 'over') {
      const t: Team = g.score[0] > g.score[1] ? 'red' : 'blue';
      banner = `${t.toUpperCase()} WINS!`;
      color = COLORS[t];
      // Say why it ended: the clock ran out (or golden goal) vs. someone reached the score limit.
      const why = golden ? 'FULL TIME' : `FIRST TO ${g.settings.scoreLimit}`;
      text(`${why}  ·  ${g.score[0]} – ${g.score[1]}`, mid, h / 2 + 56, 26, '#FFF4E0', 800);
    }
    if (banners && g.arena.kind === 'wind') {
      // Wind indicator under the scoreboard.
      const ax = mid;
      const ay = HUD_H + 18;
      ctx.fillStyle = 'rgba(20,24,40,.82)';
      ctx.beginPath();
      ctx.roundRect(ax - 52, ay - 14, 104, 28, 10);
      ctx.fill();
      text('WIND', ax - 20, ay + 1, 13, '#FFF4E0', 800);
      ctx.save();
      ctx.translate(ax + 26, ay);
      ctx.rotate(Math.atan2(g.arena.wind.y, g.arena.wind.x));
      ctx.strokeStyle = '#FFE066';
      ctx.fillStyle = '#FFE066';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(4, -6);
      ctx.lineTo(4, 6);
      ctx.fill();
      ctx.restore();
    }
    if (g.phase === 'kickoff') {
      // Which arena this kickoff is played on.
      const look = ARENA_LOOK[g.arena.kind];
      text(look.name.toUpperCase(), mid, h / 2 - 150, 40, '#FFF4E0', 800);
      text(look.hint, mid, h / 2 - 118, 18, '#FFF4E0', 700);
    }
    if (!banners) {
      // trailer: no centre-screen words
    } else if (banner) text(banner, mid, h / 2, 72, color, 800);
    else if (g.phase === 'play' && timed && g.clock > 0 && secs <= 10) {
      // Final countdown, big and fading in the middle of the pitch.
      ctx.globalAlpha = 0.55;
      text(String(secs), mid, h / 2, 120, '#FF6A5E', 800);
      ctx.globalAlpha = 1;
    } else if (
      g.phase === 'kickoff' &&
      g.score[0] + g.score[1] === 0 &&
      (timed ? g.clock === g.settings.minutes * 60 * TICK_HZ : g.clock === 0)
    )
      text(`First to ${g.settings.scoreLimit}`, mid, h / 2 - 82, 24, '#FFF4E0', 800);
  };

  const drawPing = (rtt: number | null, w: number) => {
    const label = rtt === null ? 'offline' : `${Math.round(rtt)} ms`;
    const color = rtt === null ? COLORS.red : rtt < 80 ? '#7CFF7A' : rtt < 150 ? '#FFE066' : COLORS.red;
    ctx.fillStyle = 'rgba(20,24,40,.82)';
    ctx.beginPath();
    ctx.roundRect(w - 104, 14, 92, 28, 10);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w - 88, 28, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = "700 14px 'Baloo 2', Nunito, system-ui, sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#FFF4E0';
    ctx.fillText(label, w - 76, 29);
  };

  return {
    resize(w, h, ratio) {
      // Cap the backing store: a 4K screen at DPR 2 would otherwise mean two 33-megapixel canvases
      // (the view and the cached pitch) and a full copy of one every frame.
      dpr = Math.min(ratio, MAX_DPR, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      scale = Math.min(w / (W * 2), (h - HUD_H - 30) / (H * 2)) * dpr;
      cx = canvas.width / 2;
      cy = (HUD_H * dpr + canvas.height - 30 * dpr) / 2;
      pitch = null;
    },
    say(id, s) {
      bubbles.set(id, { text: s, at: performance.now() });
    },
    draw(pr, alpha, fx, hudInfo) {
      const now = performance.now();
      const g = pr.game;
      const kind = g?.arena.kind ?? 'classic';
      if (!pitch || pitchKind !== kind) buildPitch(kind);
      shake = Math.max(shake, fx.takeShake());
      shake *= 0.88;
      const sx = shake > 0.3 ? (Math.random() - 0.5) * shake * dpr : 0;
      const sy = shake > 0.3 ? (Math.random() - 0.5) * shake * dpr : 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(pitch!, sx, sy);
      if (!g) return;
      ctx.setTransform(scale, 0, 0, scale, cx + sx, cy + sy);
      drawWorld(g, pr, alpha, now, fx);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawHud(g, pr, canvas.width / dpr, hudInfo.banners);
      drawPing(hudInfo.rtt, canvas.width / dpr);
    },
  };
}
