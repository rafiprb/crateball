import {
  BALL,
  CRATES,
  FIELD,
  ITEMS,
  PLAYER,
  KICK,
  TICK_HZ,
  kickDirection,
  type Game,
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
  boost: ['#7CFF7A', 'SPEED!'],
  shield: ['#7AF0FF', 'SHIELD!'],
  power: ['#FFA94D', 'POWER KICK!'],
  teleport: ['#C77DFF', 'TELEPORT!'],
  warp: ['#C77DFF', ''],
};

const ROLE_STYLE: Record<Role, [string, string]> = {
  gk: ['GK', 'Keeper: bigger in your box'],
  def: ['DF', 'Defender: heavier + faster in your half'],
  mid: ['MF', 'Midfielder: longer reach + crisper passes in midfield'],
  fwd: ['FW', 'Forward: fastest + hardest shot up front'],
};

const HUD_H = 56;
const MAX_DPR = 2;
const MAX_PIXELS = 3840 * 2160;
const W = FIELD.halfW + FIELD.margin + 10;
const H = FIELD.halfH + FIELD.margin + 10;

export interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  draw(p: Predictor, alpha: number, fx: Particles, hud: { rtt: number | null }): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  let pitch: HTMLCanvasElement | null = null;
  let scale = 1;
  let cx = 0;
  let cy = 0;
  let dpr = 1;
  let shake = 0;

  const buildPitch = () => {
    const c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d')!;
    g.fillStyle = COLORS.outside;
    g.fillRect(0, 0, c.width, c.height);
    g.setTransform(scale, 0, 0, scale, cx, cy);
    const { halfW, halfH, goalHalf, goalDepth, centerRadius, postRadius } = FIELD;
    const stripe = (halfW * 2) / 12;
    for (let i = 0; i < 12; i++) {
      g.fillStyle = i % 2 ? COLORS.grassA : COLORS.grassB;
      g.fillRect(-halfW + i * stripe, -halfH, stripe + 0.5, halfH * 2);
    }
    g.strokeStyle = COLORS.line;
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
      g.strokeStyle = COLORS.line;
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
      g.strokeStyle = COLORS.line;
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

  const drawWorld = (g: Game, pr: Predictor, alpha: number, now: number, fx: Particles) => {
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
        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.rotate(Math.atan2(p.fy, p.fx));
        ctx.fillStyle = '#2A2F3A';
        ctx.fillRect(r - 4, -3, 14, 6);
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
      text(ROLE_STYLE[p.role][0], pos.x, pos.y + 1, 10, p.buff ? '#FFF4E0' : 'rgba(255,244,224,.55)', 800);
      text(p.name, pos.x, pos.y + r + 10, 11, me ? '#FFF4E0' : 'rgba(255,244,224,.85)', 700);
    }
    const bp = pr.pos('ball', alpha) ?? g.ball;
    circle(bp.x + 2, bp.y + 3, BALL.radius, 'rgba(0,0,0,.25)');
    circle(bp.x, bp.y, BALL.radius, COLORS.ball, COLORS.ink, 2);
    // Aim arrow: where my kick would send the ball; turns gold and rings the teammate on an assisted pass.
    const mine = g.players.find((p) => p.id === pr.me);
    const aim = mine && mine.dead === 0 && mine.frozen === 0 ? kickDirection(g, mine) : null;
    if (aim) {
      const color = aim.to ? '#FFE066' : 'rgba(255,255,255,.75)';
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
      const mate = aim.to ? pr.pos(aim.to, alpha) : null;
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
  };

  const drawHud = (g: Game, pr: Predictor, w: number) => {
    const mid = w / 2;
    ctx.fillStyle = 'rgba(20,24,40,.82)';
    ctx.beginPath();
    ctx.roundRect(mid - 170, 8, 340, HUD_H - 16, 14);
    ctx.fill();
    text(String(g.score[0]), mid - 60, HUD_H / 2, 30, COLORS.red, 800);
    text(String(g.score[1]), mid + 60, HUD_H / 2, 30, COLORS.blue, 800);
    const secs = Math.ceil(g.clock / TICK_HZ);
    const clock =
      g.clock === 0 ? 'GOLDEN GOAL' : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const hurry = g.clock > 0 && secs <= 30;
    text(clock, mid, HUD_H / 2, g.clock === 0 ? 15 : 22, hurry ? '#FF6A5E' : '#FFF4E0', 800);
    text('RED', mid - 130, HUD_H / 2, 14, COLORS.red, 800);
    text('BLUE', mid + 130, HUD_H / 2, 14, COLORS.blue, 800);
    const me = g.players.find((p) => p.id === pr.me);
    const h = canvas.height / dpr;
    if (me) {
      const bits: string[] = [];
      bits.push(`${ROLE_STYLE[me.role][1]}${me.buff ? ' ✓' : ''}`);
      if (me.dead > 0) bits.push(`Respawn in ${Math.ceil(me.dead / TICK_HZ)}…`);
      if (me.gun > 0) bits.push(`Gun ×${me.gun} [E]`);
      if (me.teleport) bits.push('Teleport: blink [E]');
      if (me.power) bits.push('Power kick ready');
      if (me.shield) bits.push('Shield');
      if (me.boost > 0) bits.push('Speed');
      if (me.slow > 0) bits.push('Slowed');
      if (me.frozen > 0) bits.push('Frozen');
      if (bits.length) text(bits.join('  ·  '), mid, h - 44, 18, '#FFF4E0', 800);
    }
    ctx.globalAlpha = 0.6;
    ctx.textAlign = 'left';
    ctx.font = '600 12px Nunito, system-ui, sans-serif';
    ctx.fillStyle = '#FFF4E0';
    ctx.fillText(
      'Move: WASD/Arrows · Kick: Space/X · Shoot/Teleport: E/Shift · Team: T · Role: 1 GK 2 DF 3 MF 4 FW · Report a glitch: R',
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
      const why = g.clock === 0 ? 'FULL TIME' : `FIRST TO ${g.settings.scoreLimit}`;
      text(`${why}  ·  ${g.score[0]} – ${g.score[1]}`, mid, h / 2 + 56, 26, '#FFF4E0', 800);
    }
    if (banner) text(banner, mid, h / 2, 72, color, 800);
    else if (g.phase === 'play' && g.clock > 0 && secs <= 10) {
      // Final countdown, big and fading in the middle of the pitch.
      ctx.globalAlpha = 0.55;
      text(String(secs), mid, h / 2, 120, '#FF6A5E', 800);
      ctx.globalAlpha = 1;
    } else if (
      g.phase === 'kickoff' &&
      g.score[0] + g.score[1] === 0 &&
      g.clock === g.settings.minutes * 60 * TICK_HZ
    )
      text(`First to ${g.settings.scoreLimit}`, mid, h / 2 - 60, 28, '#FFF4E0', 800);
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
    draw(pr, alpha, fx, hudInfo) {
      const now = performance.now();
      if (!pitch) buildPitch();
      const g = pr.game;
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
      drawHud(g, pr, canvas.width / dpr);
      drawPing(hudInfo.rtt, canvas.width / dpr);
    },
  };
}
