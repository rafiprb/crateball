import { BALL, ITEMS } from './content/rules';
import type { Game, Player } from './types';

/** Does the segment a→b pass within `r` of point c (strictly between the ends)? */
function blocks(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  c: { x: number; y: number },
  r: number,
): boolean {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return false;
  const t = ((c.x - ax) * vx + (c.y - ay) * vy) / len2;
  if (t <= 0 || t >= 1) return false;
  const px = ax + vx * t - c.x;
  const py = ay + vy * t - c.y;
  return px * px + py * py < r * r;
}

/**
 * Auto-aim: the nearest enemy in range whose line of fire is not blocked by a teammate or the ball,
 * aimed where they are running to. Null when nobody qualifies (then the gun fires straight ahead).
 */
export function gunTarget(g: Game, p: Player): { id: string; x: number; y: number } | null {
  const range = ITEMS.bulletSpeed * ITEMS.bulletLife;
  const enemies = g.players
    .filter((e) => e.team !== p.team && e.dead === 0)
    .map((e) => ({ e, d2: (e.x - p.x) ** 2 + (e.y - p.y) ** 2 }))
    .filter(({ d2 }) => d2 < range * range)
    .sort((a, b) => a.d2 - b.d2 || (a.e.id < b.e.id ? -1 : 1));
  for (const { e, d2 } of enemies) {
    // Lead the target by the time the bullet needs to get there.
    const t = Math.sqrt(d2) / ITEMS.bulletSpeed;
    const x = e.x + e.vx * t;
    const y = e.y + e.vy * t;
    const mates = g.players.filter((m) => m !== p && m.team === p.team && m.dead === 0);
    const hidden =
      mates.some((m) => blocks(p.x, p.y, x, y, m, m.r + ITEMS.bulletRadius)) ||
      blocks(p.x, p.y, x, y, g.ball, BALL.radius + ITEMS.bulletRadius);
    if (!hidden) return { id: e.id, x, y };
  }
  return null;
}
