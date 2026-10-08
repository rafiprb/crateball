import { describe, expect, it } from 'vitest';
import {
  ARENAS,
  STATE_SCALE,
  FIELD,
  addPlayer,
  cloneGame,
  createGame,
  defaultWeights,
  duckFits,
  inWater,
  newArenaPlan,
  restartMatch,
  shoreY,
  step,
  type Game,
} from '../src/index';

/** A match on the beach only, with bots on both sides. */
const beachGame = (seed: number, bots = true): Game => {
  const g = createGame(seed, {
    minutes: 3,
    scoreLimit: 5,
    crates: bots ? 'chaos' : 'off',
    weights: defaultWeights(),
    bots,
    arenas: ['beach'],
  });
  if (bots)
    for (let i = 0; i < 3; i++) {
      addPlayer(g, `r${i}`, `R${i}`, 'red', true);
      addPlayer(g, `b${i}`, `B${i}`, 'blue', true);
    }
  newArenaPlan(g);
  restartMatch(g);
  return g;
};

describe('sahil', () => {
  it('su üst kenardan iki koy halinde girer; kaleler, ceza sahaları ve santra kuru', () => {
    expect(inWater(0, 0)).toBe(false);
    expect(inWater(0, -FIELD.halfH + 5)).toBe(true);
    expect(inWater(-200, -FIELD.halfH + 120)).toBe(true); // a bay reaches in
    for (const sx of [-1, 1]) {
      expect(inWater(sx * FIELD.halfW, 0)).toBe(false);
      expect(inWater(sx * (FIELD.halfW - 45), -130)).toBe(false);
    }
    // Mirror symmetric: no side plays downhill.
    for (let x = 0; x < FIELD.halfW; x += 17) expect(shoreY(x)).toBeCloseTo(shoreY(-x), 9);
  });

  it('ördekler suda doğar ve maç boyunca suda kalır; aynı tohum aynı maç', () => {
    const a = beachGame(7);
    const b = beachGame(7);
    expect(a.arena.kind).toBe('beach');
    expect(a.arena.ducks).toHaveLength(ARENAS.beach.ducks);
    for (let t = 0; t < 4000; t++) {
      step(a);
      step(b);
      for (const d of a.arena.ducks) expect(duckFits(d.x, d.y)).toBe(true);
      // Crates land on the sand.
      for (const c of a.crates) expect(inWater(c.x, c.y)).toBe(false);
      if (a.phase === 'over') break;
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('kopya bağımsız: tahmin kopyadaki ördeği değiştirince asıl durum değişmez', () => {
    const g = beachGame(3);
    const c = cloneGame(g);
    c.arena.ducks[0]!.x += 50;
    c.arena.ducks[0]!.bumps++;
    expect(c.arena.ducks[0]!.x).not.toBe(g.arena.ducks[0]!.x);
    expect(g.arena.ducks[0]!.bumps).toBe(0);
  });

  it('top ördekten seker: hızlı top sert QUACK, yavaş oyuncu hafif quack', () => {
    const g = beachGame(11, false);
    addPlayer(g, 'p', 'P', 'red');
    restartMatch(g);
    g.phase = 'play';
    const d = g.arena.ducks[0]!;
    // A still duck in the open water, the ball flying at it.
    Object.assign(d, { x: 0, y: -170, vx: 0, vy: 0, hx: 1, hy: 0, stun: 100 });
    for (const o of g.arena.ducks.slice(1)) Object.assign(o, { x: 200, y: -175, stun: 100 });
    Object.assign(g.ball, { x: -40, y: -170, vx: 6, vy: 0 });
    for (let t = 0; t < 12 && d.bumps === 0; t++) step(g);
    expect(d.bumps).toBe(1);
    expect(d.hard).toBe(1);
    expect(g.ball.vx).toBeLessThan(0); // bounced back off the heavy rubber toy
    // Later, a player wading into it slowly: a soft quack only.
    const p = g.players.find((o) => o.id === 'p')!;
    for (let t = 0; t < ARENAS.beach.duckCooldown + 5; t++) step(g);
    Object.assign(d, { x: 0, y: -170, vx: 0, vy: 0, stun: 100 });
    Object.assign(p, { x: -27, y: -170, vx: 0.8, vy: 0 });
    Object.assign(g.ball, { x: 300, y: 100, vx: 0, vy: 0 });
    const before = d.bumps;
    for (let t = 0; t < 6 && d.bumps === before; t++) step(g);
    expect(d.bumps).toBe(before + 1);
    expect(d.hard).toBe(1);
  });
});

describe('sahil (inceleme düzeltmeleri)', () => {
  it('ördek durumu her tick snapshotun yuvarladığı gibi: sunucu ile istemci aynı ördekten devam eder', () => {
    const g = beachGame(41);
    const exact = (v: number) => Math.round(v * STATE_SCALE) / STATE_SCALE === v && !Object.is(v, -0);
    for (let t = 0; t < 2000; t++) {
      step(g);
      for (const d of g.arena.ducks)
        for (const v of [d.x, d.y, d.vx, d.vy, d.hx, d.hy, d.turn]) expect(exact(v)).toBe(true);
    }
  });

  it('çok hızlı top ördeğin içinden geçemez', () => {
    const g = beachGame(11, false);
    addPlayer(g, 'p', 'P', 'red');
    restartMatch(g);
    g.phase = 'play';
    const d = g.arena.ducks[0]!;
    Object.assign(d, { x: 0, y: -170, vx: 0, vy: 0, stun: 100 });
    for (const o of g.arena.ducks.slice(1)) Object.assign(o, { x: 250, y: -175, stun: 100 });
    Object.assign(g.ball, { x: -11, y: -152, vx: 22, vy: 0 });
    step(g);
    expect(d.bumps).toBe(1);
    expect(g.ball.vx).toBeLessThan(22);
  });
});
