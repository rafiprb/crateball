import { describe, expect, it } from 'vitest';
import {
  BALL,
  DEFAULT_SETTINGS,
  FIELD,
  KICK,
  RIGHT,
  addPlayer,
  cloneGame,
  createGame,
  STATS,
  kickDirection,
  mvp,
  mvpScore,
  setRole,
  openCrate,
  removePlayer,
  restartMatch,
  step,
  type Game,
  type Player,
} from '../src/index';
import { finishScoring, scoreGoal, touchBall, updateScoring } from '../src/stats';

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

describe('maç istatistikleri (fizikle)', () => {
  it('top sürmek tek dokunuş; vuruş yeni dokunuş; yarım saniye uzak kalınca temas yeni dokunuş', () => {
    const { g, a, b } = setup();
    Object.assign(a, { x: -200, y: 0 });
    ballAhead(g, a);
    run(g, 120, new Map([['a', RIGHT]]));
    expect(a.stats.touches).toBe(1);
    ballAhead(g, a);
    step(g, new Map([['a', RIGHT | KICK]]));
    expect(a.stats.touches).toBe(2);
    run(g, 2, new Map([['a', 0]]));
    Object.assign(b, { x: g.ball.x + 40, y: g.ball.y, vx: 0, vy: 0 });
    run(g, 30, new Map([['a', 0]]));
    expect(b.stats.touches).toBe(1);
    ballAhead(g, a);
    step(g, new Map([['a', 0]]));
    expect(a.stats.touches).toBe(3);
  });

  it('iki oyuncu topa aynı anda bastırınca dokunuş şişmez', () => {
    const { g, a, b } = setup();
    Object.assign(a, { x: -20, y: 0 });
    Object.assign(b, { x: 20, y: 0 });
    g.ball = { x: 0, y: 0, vx: 0, vy: 0 };
    run(
      g,
      60,
      new Map([
        ['a', RIGHT],
        ['b', 4],
      ]),
    );
    expect(a.stats.touches).toBeLessThanOrEqual(2);
    expect(b.stats.touches).toBeLessThanOrEqual(2);
  });

  it('kaleye vuruş şut; isabeti sonucu belirler (gol); kendi yarısından vuruş şut değil', () => {
    const { g, a } = setup();
    Object.assign(a, { x: 250, y: 0 });
    ballAhead(g, a);
    step(g, new Map([['a', KICK]]));
    expect(a.stats).toMatchObject({ shots: 1, onTarget: 0 });
    run(g, 90);
    expect(g.score).toEqual([1, 0]);
    expect(a.stats).toMatchObject({ shots: 1, onTarget: 1 });
    expect(a.goals).toBe(1);

    // The same kick with a teammate on the line is a pass (bent toward them), not a shot.
    const pass = setup();
    Object.assign(pass.a, { x: 250, y: 0 });
    const dx = FIELD.halfW - pass.a.x;
    const dy = 100;
    const n = Math.sqrt(dx * dx + dy * dy);
    const reach = pass.a.r + BALL.radius - 1;
    const m = addPlayer(pass.g, 'm', 'M', 'red');
    Object.assign(m, { x: 250 + dx * 0.6, y: dy * 0.6, vx: 0, vy: 0 });
    pass.g.ball = { x: pass.a.x + (dx / n) * reach, y: (dy / n) * reach, vx: 0, vy: 0 };
    expect(kickDirection(pass.g, pass.a)?.to).toBe('m');
    step(pass.g, new Map([['a', KICK]]));
    expect(pass.a.stats).toMatchObject({ touches: 1, shots: 0 });

    const far = setup();
    Object.assign(far.a, { x: -330, y: 0 });
    ballAhead(far.g, far.a);
    step(far.g, new Map([['a', KICK]]));
    expect(far.a.stats).toMatchObject({ touches: 1, shots: 0 });
  });

  it('kaleci şutu tutar: 2 sn içinde gol yoksa kurtarış', () => {
    const g = createGame(1, { ...DEFAULT_SETTINGS, crates: 'off' });
    const a = addPlayer(g, 'a', 'A', 'red');
    const k = addPlayer(g, 'k', 'K', 'blue');
    setRole(g, 'k', 'gk');
    g.phase = 'play';
    Object.assign(a, { x: 250, y: 0 });
    Object.assign(k, { x: FIELD.halfW - 40, y: 0 });
    ballAhead(g, a);
    step(g, new Map([['a', KICK]]));
    run(g, 30);
    expect(k.stats.touches).toBe(1);
    expect(a.stats).toMatchObject({ shots: 1, onTarget: 1 });
    expect(k.stats.saves).toBe(0);
    run(g, STATS.saveHold);
    expect(g.score).toEqual([0, 0]);
    expect(k.stats.saves).toBe(1);
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

  it('yeni maç istatistikleri sıfırlar', () => {
    const { g, a } = setup();
    a.goals = 2;
    a.stats.touches = 10;
    restartMatch(g);
    expect(a.goals).toBe(0);
    expect(a.stats.touches).toBe(0);
  });
});

/**
 * The rules on their own, without physics: who touched when, where the ball was and where it went.
 * Red: f (forward), m (midfield), k (keeper); blue: d (defence), o (forward), q (keeper).
 */
function pitch(roles = true) {
  const g = createGame(1, { ...DEFAULT_SETTINGS, crates: 'off', roles });
  const ps = {
    f: addPlayer(g, 'f', 'F', 'red'),
    m: addPlayer(g, 'm', 'M', 'red'),
    k: addPlayer(g, 'k', 'K', 'red'),
    d: addPlayer(g, 'd', 'D', 'blue'),
    o: addPlayer(g, 'o', 'O', 'blue'),
    q: addPlayer(g, 'q', 'Q', 'blue'),
  };
  // Set by hand: setRole swaps with whoever holds a role, and these are all people.
  if (roles)
    for (const [id, role] of [
      ['f', 'fwd'],
      ['m', 'mid'],
      ['k', 'gk'],
      ['d', 'def'],
      ['o', 'fwd'],
      ['q', 'gk'],
    ] as const)
      ps[id].role = role;
  g.phase = 'play';
  g.tick = 1000;
  /** At tick `t`, `p` touches the ball at (x, y): a contact, or a kick sending it at (vx, vy). The ball
   * was coming in at `inV` (for saves and blocks). Then the scoring ticks on to `t`. */
  const touch = (
    t: number,
    p: Player,
    x: number,
    y: number,
    opts: { kick?: [number, number]; pass?: boolean; inV?: [number, number] } = {},
  ) => {
    while (g.tick < t) {
      g.tick++;
      updateScoring(g);
    }
    const [ivx, ivy] = opts.inV ?? [0, 0];
    const [vx, vy] = opts.kick ?? [ivx * 0.2, ivy * 0.2];
    g.ball = { x, y, vx, vy };
    touchBall(g, p, opts.kick ? { pass: !!opts.pass } : null, { x, y, vx: ivx, vy: ivy });
    g.lastTouch = p.id;
  };
  const wait = (t: number) => {
    while (g.tick < t) {
      g.tick++;
      updateScoring(g);
    }
  };
  const goal = (team: 'red' | 'blue') => {
    g.score[team === 'red' ? 0 : 1]++;
    scoreGoal(g, team);
  };
  return { g, ...ps, touch, wait, goal };
}

const S = STATS.own; // half a second
const SHOT: [number, number] = [9, 0]; // red shooting at the blue goal (x = +halfW), dead centre

describe('skorlama kuralları', () => {
  it('karambol: kale önünde iki oyuncu 10 sn topu birbirine vurur: 0 şut, 0 top kapma', () => {
    const { g, f, d, touch } = pitch();
    // f owns it first (a clean start), then d pokes in and they trade kicks every 10 ticks.
    touch(1000, f, 300, 0);
    let t = 1000 + 2 * S;
    for (let i = 0; i < 60; i++, t += 10)
      if (i % 2) touch(t, f, 330, 0, { kick: SHOT });
      else touch(t, d, 332, 0, { kick: [-9, 0] });
    touch(t + 200, f, 0, 150); // long after: the ball is elsewhere
    expect(f.stats).toMatchObject({ shots: 0, tackles: 0 });
    expect(d.stats).toMatchObject({ shots: 0, tackles: 0, blocks: 0 });
    expect(g.scoring.shot).toBeNull();
  });

  it('top kapma: rakip yarım saniye topa sahipken alınır ve takımda yarım saniye kalır', () => {
    const { f, d, o, m, touch, wait } = pitch();
    // f dribbles for over half a second, then d takes it off them.
    for (let t = 1000; t <= 1000 + S; t += 10) touch(t, f, 200 + (t - 1000) / 10, 0);
    touch(1000 + S + 5, d, 210, 0);
    wait(1000 + 3 * S);
    expect(d.stats.tackles).toBe(1);
    // Won, but taken straight back: nothing.
    touch(2000, f, -200, 0);
    touch(2000 + S, d, -190, 0);
    touch(2000 + S + 10, f, -185, 0);
    wait(2000 + 4 * S);
    expect(d.stats.tackles).toBe(1);
    expect(f.stats.tackles).toBe(0);
    // A loose ball the opponent last touched long ago: picking it up is no tackle.
    touch(2500, o, 0, 100);
    touch(2500 + S + 20, f, 50, 120);
    wait(2500 + 4 * S);
    expect(f.stats.tackles).toBe(0);
    // Won, then a teammate keeps it: the side kept it, the tackle stands.
    touch(3000, o, 100, 0);
    touch(3000 + S, f, 110, 0);
    touch(3000 + S + 10, m, 150, 0);
    wait(3000 + 3 * S);
    expect(f.stats.tackles).toBe(1);
  });

  it('pas: sahip olunan toptan, en az 80 px, aynı ikili 10 sn de bir kez; yan yana sürtme sayılmaz', () => {
    const { f, m, touch } = pitch();
    let t = 1000;
    for (let i = 0; i < 20; i++, t += 40) touch(t, i % 2 ? f : m, i % 2 ? 0 : 20, 0, { kick: [1, 0] });
    expect(m.stats.passes + f.stats.passes).toBe(0);
    for (let i = 0; i < 20; i++, t += 40) touch(t, i % 2 ? f : m, i % 2 ? 0 : 120, 0, { kick: [3, 0] });
    // 800 ticks of passes back and forth (13 s): each direction counts at most twice.
    expect(m.stats.passes).toBeGreaterThanOrEqual(1);
    expect(m.stats.passes).toBeLessThanOrEqual(2);
    expect(f.stats.passes).toBeLessThanOrEqual(2);
  });

  it('uzaktan ya da kendi yarısından kaleye yuvarlanan top şut değil; zayıf vuruş da değil; santra da değil', () => {
    const { g, f, q, touch, wait } = pitch();
    touch(1000, f, -20, 0, { kick: [9, 0] });
    touch(1100, f, FIELD.halfW - STATS.shotRange - 10, 0, { kick: [9, 0] });
    expect(f.stats.shots).toBe(0);
    // A slow roller from range reaching the keeper: neither a shot on target nor a save.
    touch(1150, f, 200, 0, { kick: [4, 0] });
    expect(f.stats.shots).toBe(1);
    touch(1190, q, 400, 0, { inV: [1, 0] });
    wait(1400);
    expect(f.stats.onTarget).toBe(0);
    expect(q.stats.saves).toBe(0);
    f.stats.shots = 0;
    g.phase = 'kickoff';
    touch(1500, f, 0, 0, { kick: [9, 0] });
    expect(f.stats.shots).toBe(0);
    g.phase = 'play';
    touch(1200, f, 300, 0, { kick: [2, 0] });
    expect(f.stats.shots).toBe(0);
    touch(1400, f, 300, 0, { kick: SHOT });
    expect(f.stats.shots).toBe(1);
    // One per spell: shooting again while still on it does not add.
    touch(1405, f, 302, 0, { kick: SHOT });
    expect(f.stats.shots).toBe(1);
  });

  it('şutu kesmek ya da pası araya girip almak top kapma değil', () => {
    const { f, q, d, o, touch, wait } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1020, q, 400, 0, { inV: SHOT });
    touch(1100, o, 0, 0);
    touch(1100 + S, o, 10, 0, { kick: [-6, 0], pass: true });
    touch(1100 + S + 10, f, -40, 0);
    wait(1400);
    expect(q.stats.tackles + f.stats.tackles + d.stats.tackles).toBe(0);
  });

  it('kaleci topu tutar, bırakır, tekrar tutar: tek kurtarış', () => {
    const { f, q, touch, wait } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1010, q, 390, 0, { inV: SHOT });
    touch(1020, q, 392, 4, { inV: [2, 0] });
    touch(1040, q, 395, 2, { inV: [3, 0] });
    wait(1200);
    expect(q.stats.saves).toBe(1);
    expect(f.stats).toMatchObject({ shots: 1, onTarget: 1 });
  });

  it('kaleci şutu çeler, rakip dönen topu atar: kurtarış yok; şut isabetli, gol de isabetli şut', () => {
    const { f, m, q, touch, goal } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1010, q, 390, 0, { inV: SHOT });
    touch(1030, m, 370, 20, { kick: SHOT });
    goal('red');
    expect(q.stats).toMatchObject({ saves: 0, conceded: 1 });
    expect(f.stats).toMatchObject({ shots: 1, onTarget: 1 });
    expect(m.stats).toMatchObject({ shots: 1, onTarget: 1 });
    expect(m.goals).toBe(1);
    // The keeper's touch came between f's shot and m's goal: no assist.
    expect(f.stats.assists).toBe(0);
  });

  it('geri pas kaleciye kurtarış değil; auta giden şuta değmek de değil', () => {
    const { f, d, q, touch, wait } = pitch();
    touch(1000, d, 300, 0, { kick: SHOT });
    touch(1010, q, 390, 0, { inV: SHOT });
    touch(2000, f, 300, 0, { kick: [9, 3] }); // crosses the line at y ≈ 40: on target
    touch(2010, q, 390, 30, { inV: [9, 14] }); // but by then it was going well wide
    wait(2500);
    expect(q.stats.saves).toBe(0);
    expect(f.stats).toMatchObject({ shots: 1, onTarget: 0 });
  });

  it('blok: ceza sahasında kaleci olmayan biri isabetli şutu keser; sahanın ortasında kesmek blok değil', () => {
    const { f, d, touch, wait } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1005, d, 350, 0, { inV: SHOT });
    wait(1005 + STATS.saveHold);
    expect(d.stats.blocks).toBe(1);
    expect(f.stats.onTarget).toBe(1);
    touch(2000, f, 150, 0, { kick: SHOT });
    expect(f.stats.shots).toBe(2);
    touch(2010, d, 240, 0, { inV: SHOT });
    expect(d.stats.blocks).toBe(1);
    expect(f.stats.onTarget).toBe(1);
  });

  it('asist: takım arkadaşından gelen pas, 3 sn içinde; arada rakip yok', () => {
    const { m, f, d, touch, goal } = pitch();
    touch(1000, m, 100, 0);
    touch(1000 + S, m, 110, 0, { kick: [6, 0], pass: true });
    touch(1100, f, 250, 0);
    touch(1250, f, 330, 0, { kick: SHOT }); // dribbled 2.5 s: still an assist
    goal('red');
    expect(m.stats.assists).toBe(1);
    expect(f.goals).toBe(1);

    // An opponent's touch in between breaks it.
    touch(2000, m, 100, 0);
    touch(2000 + S, m, 110, 0, { kick: [6, 0], pass: true });
    touch(2050, d, 200, 0);
    touch(2060, f, 230, 0, { kick: SHOT });
    goal('red');
    expect(m.stats.assists).toBe(1);

    // More than 3 s from the pass to the scorer's first touch: no assist.
    touch(3000, m, 100, 0);
    touch(3000 + S, m, 110, 0, { kick: [1, 0], pass: true });
    touch(3000 + S + STATS.assistGap + 1, f, 230, 0, { kick: SHOT });
    goal('red');
    expect(m.stats.assists).toBe(1);
  });

  it('direkten dönen top zinciri bozmaz: şutu atan asist alır', () => {
    // The post is not a touch: f's shot comes back off it and m puts it in.
    const { f, m, touch, goal } = pitch();
    touch(1000, f, 300, 60, { kick: [9, 0] });
    touch(1030, m, 360, 40, { kick: SHOT });
    goal('red');
    expect(f.stats.assists).toBe(1);
  });

  it('karambolden çıkan pas asist değil', () => {
    const { m, f, d, touch, goal } = pitch();
    touch(1000, d, 100, 0);
    touch(1000 + S, d, 105, 0);
    touch(1000 + S + 5, m, 110, 0); // takes it off d (owned): clean
    touch(1000 + S + 10, d, 112, 0); // d straight back: d's spell is a scramble
    touch(1000 + S + 15, m, 115, 0, { kick: [6, 0], pass: true }); // m's spell is a scramble too
    touch(1000 + S + 40, f, 250, 0, { kick: SHOT });
    goal('red');
    expect(m.stats.assists).toBe(0);
  });

  it('rakibe çarpıp giren şut şutu atanın golü; blok ya da kurtarış yazılmaz', () => {
    const { g, f, d, q, touch, goal } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1008, d, 370, 0, { inV: SHOT }); // standing in the way: a brief contact
    goal('red');
    expect(f.goals).toBe(1);
    expect(f.stats).toMatchObject({ shots: 1, onTarget: 1 });
    expect(d.stats).toMatchObject({ ownGoals: 0, blocks: 0 });
    // The keeper gets a hand to it and it squirms in.
    touch(2000, f, 300, 0, { kick: SHOT });
    touch(2010, q, 405, 0, { inV: SHOT });
    goal('red');
    expect(f.goals).toBe(2);
    expect(f.stats).toMatchObject({ shots: 2, onTarget: 2 });
    expect(q.stats).toMatchObject({ saves: 0, ownGoals: 0, conceded: 2 });
    expect(g.score).toEqual([2, 0]);
    // A shot that sticks to a defender standing in the goal mouth and trickles in a moment later.
    touch(3000, f, 300, 0, { kick: SHOT });
    for (let t = 3010; t < 3010 + 50; t += 5) touch(t, d, 410, 0, { inV: [1, 0] });
    goal('red');
    expect(f.goals).toBe(3);
    expect(d.stats.ownGoals).toBe(0);
  });

  it('kendi kalesine gol: eksi, gol ve asist yazılmaz', () => {
    const { g, d, o, touch, goal } = pitch();
    touch(1000, o, 300, 0);
    touch(1000 + S, o, 310, 0, { kick: [-3, 0], pass: true });
    // d gets it under control and then puts it in their own net.
    touch(1100, d, 380, 0);
    touch(1100 + S, d, 395, 0, { kick: [6, 0] });
    goal('red');
    expect(d.stats.ownGoals).toBe(1);
    expect(d.goals).toBe(0);
    expect(o.stats.assists).toBe(0);
    expect(mvpScore(g, d)).toBe(STATS.ownGoal);
  });

  it('puanlar: mevkiye göre gol ve asist; mevki katkısı 3 puanla sınırlı; kaleciye yenen gol', () => {
    const { g, f, m, k, d } = pitch();
    f.goals = 2;
    f.stats.assists = 1;
    f.stats.onTarget = 16; // 4 → capped at 3
    expect(mvpScore(g, f)).toBe(2 * 3 + 2 + 3);
    m.goals = 1;
    m.stats.assists = 2;
    m.stats.passes = 4;
    expect(mvpScore(g, m)).toBe(2 + 6 + 1);
    d.stats.tackles = 1;
    d.stats.blocks = 1;
    expect(mvpScore(g, d)).toBe(2.5);
    k.stats.saves = 2;
    k.stats.cleanSheet = 1;
    k.stats.conceded = 3; // outside the cap
    expect(mvpScore(g, k)).toBe(3 - 1.5);
    // Roles off: everyone scores as "no role" (goal 3, assist 2, no extras).
    const off = pitch(false);
    off.f.goals = 1;
    off.f.stats.assists = 1;
    off.f.stats.onTarget = 4;
    expect(mvpScore(off.g, off.f)).toBe(5);
  });

  it('aynı adımda vuruş sonra temas: vuruş unutulmaz (kendi kalesine gol, top kapma yok)', () => {
    const { f, d, touch, goal } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1010, d, 380, 0, { kick: [6, 0] }); // d kicks it toward their own net...
    touch(1010, d, 381, 0); // ...and brushes it again in the same step
    goal('red');
    expect(d.stats.ownGoals).toBe(1);
    expect(f.goals).toBe(0);
  });

  it('iki savunmacıya çarpıp giren şut şutu atanın golü', () => {
    const { f, d, q, touch, goal } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1008, d, 360, 0, { inV: SHOT });
    touch(1010, q, 400, 0, { inV: [6, 0] });
    goal('red');
    expect(f.goals).toBe(1);
    expect(d.stats.ownGoals + q.stats.ownGoals).toBe(0);
  });

  it('savunmacı topu kontrol edip sonra kendi kalesine sokarsa kendi kalesine gol (süre şutçunun vuruşundan)', () => {
    const { f, d, touch, goal } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    for (let t = 1040; t <= 1080; t += 5) touch(t, d, 380, 0, { inV: [1, 0] });
    goal('red');
    expect(d.stats.ownGoals).toBe(1);
    expect(f.goals).toBe(0);
  });

  it('kaleci iki ayrı şutu kurtarır: iki kurtarış', () => {
    const { f, m, q, touch, wait } = pitch();
    touch(1000, f, 300, 0, { kick: SHOT });
    touch(1010, q, 400, 0, { inV: SHOT });
    touch(1060, m, 300, 0, { kick: SHOT }); // a clean rebound, still inside the first save's 2 s
    touch(1070, q, 400, 0, { inV: SHOT });
    wait(1300);
    expect(q.stats.saves).toBe(2);
    expect(f.stats.onTarget + m.stats.onTarget).toBe(2);
  });

  it('pas sırası değişince aynı ikili yine 10 sn de bir sayılır', () => {
    const { g, f, m, k, touch } = pitch();
    const o = addPlayer(g, 'x', 'X', 'red');
    let t = 1000;
    const seq = [f, m, f, k, f, m, f, o, f, m];
    for (const p of seq) {
      touch(t, p, p === f ? 0 : 150, 0, { kick: [4, 0] });
      t += 40;
    }
    // f → m three times in 360 ticks (6 s): once.
    expect(f.stats.passes).toBe(3); // to m, k and x once each
  });

  it('karambolde alınan topu takım arkadaşı hemen vurursa şut sayılmaz', () => {
    const { o, d, f, touch } = pitch();
    touch(1000, f, 250, 0);
    touch(1000 + S + 5, f, 255, 0);
    touch(1000 + S + 10, o, 258, 0); // blue takes it off red, who owned it: clean
    touch(1000 + S + 12, f, 260, 0); // red straight back: a scramble
    touch(1000 + S + 14, f, 262, 0);
    touch(1000 + S + 16, o, 264, 0); // blue pokes it back: a scramble too
    touch(1000 + S + 17, d, 266, 0, { kick: [-9, 0] }); // a blue teammate shoots at once
    expect(d.stats.shots).toBe(0);
  });

  it('maçtan ayrılan oyuncunun golleri kalır; bekleyen şutu gol olursa ona yazılır; dönerse devam eder', () => {
    const { g, f, m, touch, goal } = pitch();
    f.goals = 2;
    touch(1000, f, 300, 0, { kick: SHOT });
    removePlayer(g, 'f');
    goal('red');
    const gone = g.scoring.gone.find((p) => p.id === 'f')!;
    expect(gone.goals).toBe(3);
    expect(mvp(g)).toBe('f');
    expect(m.stats.assists).toBe(0);
    const back = addPlayer(g, 'f', 'F', 'red');
    expect(back.goals).toBe(3);
    expect(g.scoring.gone).toHaveLength(0);
    restartMatch(g);
    expect(back.goals).toBe(0);
  });

  it('gol sonrası duraklamada hasar, ölüm ve kutu sayılmaz', () => {
    const g = createGame(1, { ...DEFAULT_SETTINGS, crates: 'off' });
    const a = addPlayer(g, 'a', 'A', 'red');
    addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'goal';
    openCrate(g, a, a.x, a.y, 'gun');
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.stats).toMatchObject({ goodCrates: 0, badCrates: 0, deaths: 0 });
    finishScoring(g);
  });

  it('uzun sekme zinciri: savunmacılar arasında 10 kez seken şut yine şutçunun golü, asist de durur', () => {
    const { f, m, d, q, touch, goal } = pitch();
    touch(1000, m, 200, 0);
    touch(1000 + S, m, 210, 0, { kick: [6, 0], pass: true });
    touch(1000 + S + 20, f, 300, 0, { kick: SHOT });
    let t = 1000 + S + 25;
    for (let i = 0; i < 10; i++, t += 2) touch(t, i % 2 ? q : d, 380 + i, 0, { inV: [5, 0] });
    goal('red');
    expect(f.goals).toBe(1);
    expect(m.stats.assists).toBe(1);
    expect(d.stats.ownGoals + q.stats.ownGoals).toBe(0);
  });

  it('top kapma: sahibi vurup tekrar ayağına aldıysa sayılır; havadaki pası kesmek sayılmaz', () => {
    const { f, d, o, m, touch, wait } = pitch();
    touch(1000, f, 100, 0);
    touch(1000 + S, f, 110, 0, { kick: [2, 0] });
    touch(1000 + S + 10, f, 130, 0); // traps the rebound
    touch(1000 + S + 20, d, 135, 0);
    wait(1000 + 3 * S);
    expect(d.stats.tackles).toBe(1);
    // A pass in the air for 40 ticks, cut out: no tackle.
    touch(2000, o, 100, 0);
    touch(2000 + S, o, 110, 0, { kick: [3, 0], pass: true });
    touch(2000 + S + 40, m, 230, 0);
    wait(2000 + 4 * S);
    expect(m.stats.tackles).toBe(0);
  });

  it('ayrılan oyuncunun havadaki mermisi hasarını onun satırına yazar', () => {
    const { g, f, d } = pitch();
    Object.assign(d, { x: 100, y: 0 });
    g.ball = { x: 0, y: 150, vx: 0, vy: 0 };
    g.bullets.push({
      id: g.nextId++,
      owner: 'f',
      team: 'red',
      x: 70,
      y: 0,
      vx: 9,
      vy: 0,
      life: 60,
      rocket: false,
    });
    removePlayer(g, 'f');
    run(g, 3);
    expect(d.hp).toBeLessThan(3);
    expect(g.scoring.gone.find((p) => p.id === 'f')!.stats.damage).toBe(1);
    expect(f.stats.damage).toBe(0); // the old object is not the ledger line
  });

  it('kopya oyun ayarları paylaşmaz', () => {
    const { g } = pitch();
    const c = cloneGame(g);
    c.settings.weights.mine = 99;
    expect(g.settings.weights.mine).not.toBe(99);
  });

  it('MVP: en çok puan; eşitlikte kazanan takım, sonra gol, sonra asist', () => {
    const { g, f, m, o } = pitch();
    g.score = [2, 1];
    o.goals = 1; // 3
    m.stats.assists = 1; // 3
    expect(mvp(g)).toBe('m'); // tie: m is on the winning side
    f.goals = 1; // 3, winning side, a goal beats an assist
    expect(mvp(g)).toBe('f');
  });

  it('düdükte: bekleyen kurtarış sayılır; gol yemeyen kaleciye temiz kale', () => {
    const g = createGame(1, { ...DEFAULT_SETTINGS, crates: 'off', minutes: 1 });
    const a = addPlayer(g, 'a', 'A', 'red');
    const k = addPlayer(g, 'k', 'K', 'blue');
    const rk = addPlayer(g, 'rk', 'RK', 'red');
    setRole(g, 'k', 'gk');
    setRole(g, 'rk', 'gk');
    setRole(g, 'a', 'fwd');
    g.phase = 'play';
    g.score = [1, 0];
    g.clock = 1;
    step(g);
    expect(g.phase).toBe('over');
    expect(k.stats.cleanSheet).toBe(0);
    expect(rk.stats.cleanSheet).toBe(1);
    expect(a.stats.cleanSheet).toBe(0);
  });
});
