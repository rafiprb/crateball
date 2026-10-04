import { ITEMS, type BlastKind, type Game, type Team } from '@crateball/sim';

const KICK_WINDOW = 45;
const SEEN_TTL_TICKS = 180;

export type GameEvent =
  | { type: 'kick'; x: number; y: number; power: boolean }
  | { type: 'shot'; x: number; y: number; vx: number; vy: number }
  | { type: 'hit'; x: number; y: number; team: Team; killed: boolean }
  | { type: 'item'; x: number; y: number; kind: BlastKind }
  | { type: 'goal'; team: Team; x: number; y: number }
  | { type: 'whistle'; long: boolean };

/**
 * Turns successive predicted states into one-shot events (sounds, particles). Rollback re-simulation
 * replays the same ticks; tick stamps and growing ids keep each event from firing twice.
 */
export function createEventTracker() {
  let lastTick = -1;
  let lastPhase = '';
  let lastScore = '';
  let maxBullet = 0;
  const kickSeen = new Map<string, number>();
  const hp = new Map<string, { hp: number; x: number; y: number }>();
  /** Blast key → tick first seen. Kept across frames so a blast that a rollback removes and a later
   * replay brings back does not play twice; forgotten after a few seconds. */
  const blastsSeen = new Map<string, number>();

  return (g: Game | null): GameEvent[] => {
    const out: GameEvent[] = [];
    if (!g) {
      lastTick = -1;
      maxBullet = 0;
      return out;
    }
    const fresh = lastTick < 0 || g.tick < lastTick;
    lastTick = g.tick;
    const score = g.score.join(':');
    if (!fresh) {
      if (score !== lastScore && g.phase === 'goal')
        out.push({ type: 'goal', team: g.ball.x > 0 ? 'red' : 'blue', x: g.ball.x, y: g.ball.y });
      if (g.phase !== lastPhase && (g.phase === 'over' || g.phase === 'kickoff'))
        out.push({ type: 'whistle', long: g.phase === 'over' });
    } else if (g.phase === 'kickoff') out.push({ type: 'whistle', long: false });
    lastScore = score;
    lastPhase = g.phase;
    for (const p of g.players) {
      const seen = kickSeen.get(p.id) ?? -1;
      // Someone else's kick reaches us about a ping late, so accept kicks up to ~0.75 s old;
      // the per-player tick stamp still plays each kick once.
      if (!fresh && p.kickTick > seen && g.tick - p.kickTick < KICK_WINDOW)
        out.push({ type: 'kick', x: g.ball.x, y: g.ball.y, power: Math.hypot(g.ball.vx, g.ball.vy) > 8 });
      kickSeen.set(p.id, Math.max(p.kickTick, seen));
      const before = hp.get(p.id);
      if (!fresh && before !== undefined && p.hp < before.hp)
        out.push({ type: 'hit', x: before.x, y: before.y, team: p.team, killed: p.dead > 0 });
      hp.set(p.id, p.dead > 0 && before ? { ...before, hp: p.hp } : { hp: p.hp, x: p.x, y: p.y });
    }
    for (const b of g.bullets) {
      if (b.id > maxBullet) {
        if (!fresh) out.push({ type: 'shot', x: b.x, y: b.y, vx: b.vx, vy: b.vy });
        maxBullet = b.id;
      }
    }
    for (const b of g.blasts) {
      // Spawn tick plus a coarse position: two crates of the same kind opened on one tick stay apart,
      // while the small position drift of a re-simulation maps to the same key.
      const spawned = g.tick - (ITEMS.blastShow - b.t);
      const key = `${b.kind}:${spawned}:${Math.round(b.x / 40)}:${Math.round(b.y / 40)}`;
      if (!blastsSeen.has(key)) {
        blastsSeen.set(key, g.tick);
        if (!fresh) out.push({ type: 'item', x: b.x, y: b.y, kind: b.kind });
      }
    }
    for (const [key, seenAt] of blastsSeen)
      if (g.tick - seenAt > SEEN_TTL_TICKS || seenAt > g.tick) blastsSeen.delete(key);
    // Players who left: forget them (a long-lived room would otherwise grow these maps forever).
    if (kickSeen.size > g.players.length) {
      const ids = new Set(g.players.map((p) => p.id));
      for (const id of kickSeen.keys()) if (!ids.has(id)) kickSeen.delete(id);
      for (const id of hp.keys()) if (!ids.has(id)) hp.delete(id);
    }
    return out;
  };
}
