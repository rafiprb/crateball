import { BALL, BOT, FIELD, PLAYER } from './content/rules';
import { DOWN, KICK, LEFT, RIGHT, UP, USE, type Game, type Player } from './types';
import { gunTarget } from './aim';

const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2;

/** Stable small number per bot, so bots don't all think on the same tick. */
function idHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic 0..99 roll for this bot on this tick. */
const roll = (g: Game, p: Player) => (Math.imul(g.tick ^ idHash(p.id), 2654435761) >>> 0) % 100;

/**
 * Where in the goal mouth this bot aims: its own spot, redrawn every 1.5 s (deterministic). Two bots
 * aiming dead centre push the ball into each other forever; a little spread breaks the deadlock.
 */
function aimY(g: Game, p: Player): number {
  const h = Math.imul(Math.floor(g.tick / 90) ^ idHash(p.id), 2654435761) >>> 0;
  return ((h % 1000) / 500 - 1) * FIELD.goalHalf * 0.8;
}

/** Simple deterministic bot: chaser goes behind the ball toward the enemy goal, others hold. */
export function botInput(g: Game, p: Player): number {
  if (p.dead > 0 || p.frozen > 0 || g.phase === 'over') return 0;
  // Reaction time: between decisions keep the last input (minus kick, which is one press).
  if ((g.tick + idHash(p.id)) % BOT.thinkEvery !== 0) return p.input & ~KICK;
  const own = p.team === 'red' ? -1 : 1;
  const b = g.ball;
  let bits = 0;

  // The gun aims itself; bots just pull the trigger when a clear target is close enough.
  if (p.gun > 0 && p.cooldown === 0) {
    const t = gunTarget(g, p);
    if (t && (t.x - p.x) ** 2 + (t.y - p.y) ** 2 < BOT.shootRange ** 2) bits |= USE;
  }
  // The bazooka locks on the same way; its one rocket needs a fresh press (USE released in between).
  if (p.bazooka && p.useArmed && gunTarget(g, p)) bits |= USE;

  const mates = g.players.filter((o) => o.team === p.team && o.dead === 0 && o.role !== 'gk');
  const chaser = mates.reduce<Player | null>(
    (best, o) => (!best || d2(o.x, o.y, b.x, b.y) < d2(best.x, best.y, b.x, b.y) ? o : best),
    null,
  );
  // Keeper only comes out when the ball is in or near its box.
  const ballNearOwnGoal = b.x * own > FIELD.halfW - 150 && Math.abs(b.y) < 160;
  const attacking = p.role === 'gk' ? ballNearOwnGoal : chaser === p;
  let tx: number;
  let ty: number;
  let wantKick = false;
  const crate = g.crates.find((c) => d2(c.x, c.y, p.x, p.y) < 110 ** 2);
  if (g.phase === 'kickoff' && g.kickoffTeam !== p.team) {
    tx = own * 120;
    ty = p.role === 'gk' ? 0 : b.y;
    if (p.role === 'gk') tx = own * (FIELD.halfW - 25);
  } else if (!attacking) {
    const home: Record<string, number> = {
      gk: FIELD.halfW - 25,
      def: 230,
      mid: Math.min(140, b.x * own),
      fwd: -150,
    };
    tx = own * (home[p.role] ?? 0);
    ty = p.role === 'gk' ? Math.max(-FIELD.goalHalf, Math.min(FIELD.goalHalf, b.y * 0.7)) : b.y * 0.5;
    if (crate && p.role !== 'gk') {
      tx = crate.x;
      ty = crate.y;
    }
  } else {
    const gx = -own * (FIELD.halfW + 20) - b.x;
    const gy = aimY(g, p) - b.y;
    const gl = Math.sqrt(gx * gx + gy * gy) || 1;
    const nx = gx / gl;
    const ny = gy / gl;
    const reach = p.r + BALL.radius;
    const ahead = (p.x - b.x) * nx + (p.y - b.y) * ny;
    if (ahead > -reach * 0.5) {
      // On the wrong side: loop around the ball.
      const sideSign = (p.x - b.x) * -ny + (p.y - b.y) * nx >= 0 ? 1 : -1;
      tx = b.x - nx * 36 - ny * 34 * sideSign;
      ty = b.y - ny * 36 + nx * 34 * sideSign;
    } else {
      tx = b.x - nx * (reach - 6);
      ty = b.y - ny * (reach - 6);
      wantKick = d2(p.x, p.y, b.x, b.y) < (reach + PLAYER.kickReach) ** 2;
    }
  }
  const dx = tx - p.x;
  const dy = ty - p.y;
  if (dx > 4) bits |= RIGHT;
  else if (dx < -4) bits |= LEFT;
  if (dy > 4) bits |= DOWN;
  else if (dy < -4) bits |= UP;
  if (wantKick && p.kickArmed && roll(g, p) < BOT.kickChance * 100) bits |= KICK;
  // Far from where it wants to be and already facing that way (fx/fy follow the keys): blink there.
  if (
    p.teleport &&
    dx * dx + dy * dy > BOT.blinkFrom ** 2 &&
    (dx * p.fx + dy * p.fy) / Math.sqrt(dx * dx + dy * dy) > 0.9
  )
    bits |= USE;
  return bits;
}
