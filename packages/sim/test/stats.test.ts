import { describe, expect, it } from 'vitest';
import {
  BALL,
  DEFAULT_SETTINGS,
  FIELD,
  KICK,
  RIGHT,
  addPlayer,
  createGame,
  kickDirection,
  mvp,
  openCrate,
  restartMatch,
  step,
  type Game,
  type Player,
} from '../src/index';

const run = (g: Game, n: number, inputs?: Map<string, number>) => {
  for (let i = 0; i < n; i++) step(g, inputs);
};

/** Red `a` and blue `b`, ball in play, positions off (no passives bending kicks). */
function setup() {
  const g = createGame(1, { ...DEFAULT_SETTINGS, roles: false, crates: 'off' });
  const a = addPlayer(g, 'a', 'A', 'red');
  const b = addPlayer(g, 'b', 'B', 'blue');
  g.phase = 'play';
  Object.assign(b, { x: -350, y: 180 });
  return { g, a, b };
}

/** The ball just in front of `p` (touching), to the right. */
const ballAhead = (g: Game, p: Player, vx = 0) => {
  g.ball = { x: p.x + p.r + BALL.radius - 1, y: p.y, vx, vy: 0 };
};

describe('maç istatistikleri', () => {
  it('top sürmek tek dokunuş; vuruş ve başkasından sonra gelen temas yeni dokunuş', () => {
    const { g, a, b } = setup();
    Object.assign(a, { x: -200, y: 0 });
    ballAhead(g, a);
    run(g, 120, new Map([['a', RIGHT]]));
    expect(a.stats.touches).toBe(1);
    ballAhead(g, a);
    step(g, new Map([['a', RIGHT | KICK]]));
    expect(a.stats.touches).toBe(2);
    // The ball reaches b; b's first contact is a touch, and a's next contact after b is new again.
    run(g, 2, new Map([['a', 0]]));
    Object.assign(b, { x: g.ball.x + 40, y: g.ball.y, vx: 0, vy: 0 });
    run(g, 30, new Map([['a', 0]]));
    expect(b.stats.touches).toBe(1);
    ballAhead(g, a);
    step(g, new Map([['a', 0]]));
    expect(a.stats.touches).toBe(3);
  });

  it('kaleye giden vuruş şut, direklerin arasına giden isabetli şut; uzaktan zayıf vuruş şut değil', () => {
    const { g, a } = setup();
    Object.assign(a, { x: 250, y: 0 });
    ballAhead(g, a);
    step(g, new Map([['a', KICK]]));
    expect(a.stats).toMatchObject({ shots: 1, onTarget: 1 });

    // Aimed just wide of the post: a shot, not on target.
    const wide = setup();
    Object.assign(wide.a, { x: 250, y: 0 });
    const dx = FIELD.halfW - wide.a.x;
    const dy = 100;
    const n = Math.sqrt(dx * dx + dy * dy);
    const reach = wide.a.r + BALL.radius - 1;
    wide.g.ball = { x: wide.a.x + (dx / n) * reach, y: (dy / n) * reach, vx: 0, vy: 0 };
    step(wide.g, new Map([['a', KICK]]));
    expect(wide.a.stats).toMatchObject({ shots: 1, onTarget: 0 });

    // The same kick with a teammate on that line is a pass (bent toward them), not a shot.
    const pass = setup();
    Object.assign(pass.a, { x: 250, y: 0 });
    addPlayer(pass.g, 'm', 'M', 'red');
    const m = pass.g.players.find((p) => p.id === 'm')!;
    Object.assign(m, { x: 250 + dx * 0.6, y: dy * 0.6, vx: 0, vy: 0 });
    pass.g.ball = { x: pass.a.x + (dx / n) * reach, y: (dy / n) * reach, vx: 0, vy: 0 };
    expect(kickDirection(pass.g, pass.a)?.to).toBe('m');
    step(pass.g, new Map([['a', KICK]]));
    expect(pass.a.stats).toMatchObject({ touches: 1, shots: 0 });

    // From deep in the own half a normal kick would stop well short of the goal.
    const far = setup();
    Object.assign(far.a, { x: -330, y: 0 });
    ballAhead(far.g, far.a);
    step(far.g, new Map([['a', KICK]]));
    expect(far.a.stats.touches).toBe(1);
    expect(far.a.stats.shots).toBe(0);
  });

  it('her gol isabetli şut sayılır (sürerek atılan da)', () => {
    const { g, a } = setup();
    g.lastTouch = 'a';
    g.ball = { x: FIELD.halfW - 2, y: 0, vx: 4, vy: 0 };
    run(g, 10);
    expect(g.score).toEqual([1, 0]);
    expect(a.goals).toBe(1);
    expect(a.stats).toMatchObject({ shots: 1, onTarget: 1 });
  });

  it('kurtarış: yalnızca kaleci, yalnızca kaleye giden top', () => {
    /** A ball from 120 px out at the blue goal; the keeper stands 40 px off the line. */
    const save = (role: 'gk' | 'def', y: number, vy: number) => {
      const g = createGame(1, { ...DEFAULT_SETTINGS, crates: 'off' });
      const a = addPlayer(g, 'a', 'A', 'red');
      const k = addPlayer(g, 'k', 'K', 'blue');
      g.phase = 'play';
      k.role = role;
      Object.assign(a, { x: 0, y: 180 });
      Object.assign(k, { x: FIELD.halfW - 40, y: 0 });
      g.lastTouch = 'a';
      g.ball = { x: FIELD.halfW - 120, y, vx: 6, vy };
      run(g, 30);
      return k.stats;
    };
    expect(save('gk', 0, 0)).toMatchObject({ saves: 1, touches: 1 });
    expect(save('def', 0, 0)).toMatchObject({ saves: 0, touches: 1 });
    // Brushes the keeper but would have crossed the line wide of the post (y ≈ 66): no save.
    expect(save('gk', -58, 6.2)).toMatchObject({ saves: 0, touches: 1 });
    // Rolling back up the pitch: no save.
    const g = createGame(1);
    const k = addPlayer(g, 'k', 'K', 'blue');
    g.phase = 'play';
    k.role = 'gk';
    Object.assign(k, { x: FIELD.halfW - 40, y: 0 });
    g.ball = { x: FIELD.halfW - 40 - k.r - BALL.radius + 1, y: 0, vx: -1, vy: 0 };
    step(g);
    expect(k.stats).toMatchObject({ saves: 0, touches: 1 });
  });

  it('kutular iyi/kötü diye sayılır; kalkanın yuttuğu hasar ayrı', () => {
    const { g, a } = setup();
    openCrate(g, a, a.x, a.y, 'gun');
    openCrate(g, a, a.x, a.y, 'shield');
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.stats).toMatchObject({ goodCrates: 2, badCrates: 1, absorbed: 1 });
    expect(a.hp).toBe(3);
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.stats).toMatchObject({ badCrates: 2, absorbed: 1 });
    expect(a.hp).toBe(2);
  });

  it('mermi ve roket hasarı atana yazılır; ölüm sayılır; kalkan hasarı yutar', () => {
    const { g, a, b } = setup();
    Object.assign(a, { x: -300, y: 0 });
    Object.assign(b, { x: 100, y: 0 });
    g.ball = { x: 0, y: 150, vx: 0, vy: 0 };
    const shoot = (rocket = false) => {
      g.bullets.push({
        id: g.nextId++,
        owner: 'a',
        team: 'red',
        x: b.x - 30,
        y: b.y,
        vx: 9,
        vy: 0,
        life: 60,
        rocket,
      });
      run(g, 3);
    };
    shoot();
    expect(b.hp).toBe(2);
    expect(a.stats.damage).toBe(1);
    b.shield = true;
    shoot();
    expect(b.hp).toBe(2);
    expect(b.stats.absorbed).toBe(1);
    expect(a.stats.damage).toBe(1);
    // A rocket takes 3, but only 2 were left: 2 dealt, and b is down.
    shoot(true);
    expect(a.stats.damage).toBe(3);
    expect(b.stats.deaths).toBe(1);
  });

  it('MVP: gol + hasar + kurtarış − ölüm; eşitlikte kazanan takım, sonra dokunuş', () => {
    const g = createGame(1);
    const r1 = addPlayer(g, 'r1', 'R1', 'red');
    const r2 = addPlayer(g, 'r2', 'R2', 'red');
    const b1 = addPlayer(g, 'b1', 'B1', 'blue');
    g.score = [3, 2];
    r1.goals = 2;
    r1.stats.deaths = 1;
    b1.stats.saves = 4;
    expect(mvp(g)).toBe('b1');
    r2.stats.damage = 3;
    r2.stats.deaths = 1;
    r1.stats.damage = 2;
    // r1 3, r2 2, b1 4 → b1; one more for r1 ties it with b1, and red won.
    expect(mvp(g)).toBe('b1');
    r1.stats.damage = 3;
    expect(mvp(g)).toBe('r1');
    r2.stats.damage = 5;
    r2.stats.touches = 1;
    expect(mvp(g)).toBe('r2');
  });

  it('yeni maç istatistikleri sıfırlar', () => {
    const { g, a } = setup();
    a.goals = 2;
    a.stats.touches = 10;
    restartMatch(g);
    expect(a.goals).toBe(0);
    expect(a.stats.touches).toBe(0);
  });
});
