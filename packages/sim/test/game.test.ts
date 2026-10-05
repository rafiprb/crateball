import { describe, expect, it } from 'vitest';
import {
  BALL,
  CRATES,
  FIELD,
  ITEMS,
  KICK,
  UP,
  LEFT,
  DOWN,
  PLAYER,
  RIGHT,
  USE,
  ARENAS,
  ITEM_KINDS,
  newArenaPlan,
  restartMatch,
  inHotLava,
  gunTarget,
  addPlayer,
  cloneGame,
  createGame,
  hashState,
  ROLES,
  kickDirection,
  openCrate,
  setRole,
  step,
  botInput,
  type Game,
} from '../src';

const run = (g: Game, n: number, inputs?: Map<string, number>) => {
  for (let i = 0; i < n; i++) step(g, inputs);
};

describe('sim', () => {
  it('aynı seed + aynı girdi → aynı hash', () => {
    const make = () => {
      const g = createGame(42);
      addPlayer(g, 'a', 'A', 'red');
      addPlayer(g, 'b', 'B', 'blue', true);
      addPlayer(g, 'c', 'C', 'red', true);
      return g;
    };
    const a = make();
    const b = make();
    for (let t = 0; t < 3000; t++) {
      const inp = new Map([['a', (t * 7) % 64]]);
      step(a, inp);
      step(b, inp);
    }
    expect(hashState(a)).toBe(hashState(b));
    expect(a.crates.length + a.blasts.length + a.score[0] + a.score[1]).toBeGreaterThanOrEqual(0);
  });

  it('clone + resim tahmini sunucuyla birebir eşleşir', () => {
    const server = createGame(7);
    addPlayer(server, 'a', 'A', 'red');
    addPlayer(server, 'b', 'B', 'blue', true);
    run(server, 100);
    const snap = cloneGame(server);
    const inputs = [RIGHT, RIGHT | KICK, RIGHT, 0, KICK];
    for (const i of inputs) step(server, new Map([['a', i]]));
    for (const i of inputs) step(snap, new Map([['a', i]]));
    expect(hashState(snap)).toBe(hashState(server));
  });

  it('vuruş topu iter ve başlama vuruşunu oyuna çevirir', () => {
    const g = createGame(1);
    const p = addPlayer(g, 'a', 'A', 'red');
    p.x = -(PLAYER.radius + BALL.radius + 1);
    p.y = 0;
    step(g, new Map([['a', KICK]]));
    expect(g.ball.vx).toBeGreaterThan(3);
    expect(g.phase).toBe('play');
    step(g, new Map([['a', KICK]]));
    const v = g.ball.vx;
    step(g, new Map([['a', KICK]]));
    expect(g.ball.vx).toBeLessThanOrEqual(v); // tuşu bırakmadan ikinci vuruş yok
  });

  it('top kale çizgisini geçince gol sayılır ve başlama vuruşu sıfırlanır', () => {
    const g = createGame(1);
    addPlayer(g, 'a', 'A', 'red');
    g.phase = 'play';
    g.ball = { x: FIELD.halfW - 5, y: 0, vx: 6, vy: 0 };
    run(g, 10);
    expect(g.score).toEqual([1, 0]);
    expect(g.phase).toBe('goal');
    run(g, 200);
    expect(g.phase).toBe('kickoff');
    expect(g.kickoffTeam).toBe('blue');
    expect(g.ball.x).toBe(0);
  });

  it('top kale dışındaki çizgiden seker', () => {
    const g = createGame(1);
    g.phase = 'play';
    g.ball = { x: FIELD.halfW - 20, y: FIELD.goalHalf + 40, vx: 8, vy: 0 };
    run(g, 10);
    expect(g.ball.vx).toBeLessThan(0);
    expect(g.score).toEqual([0, 0]);
  });

  it('silah 3 isabette öldürür, ölü oyuncu yeniden doğar', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    a.gun = ITEMS.gunAmmo;
    for (let shot = 0; shot < 3; shot++) {
      a.x = 0;
      a.y = -150;
      a.vx = a.vy = 0;
      a.fx = 1;
      a.fy = 0;
      b.x = 80;
      b.y = -150;
      b.vx = b.vy = 0;
      step(g, new Map([['a', USE]]));
      run(g, 20, new Map([['a', 0]]));
    }
    expect(b.dead).toBeGreaterThan(0);
    expect(a.gun).toBe(ITEMS.gunAmmo - 3);
    run(g, PLAYER.respawn);
    expect(b.dead).toBe(0);
    expect(b.hp).toBe(PLAYER.maxHp);
  });

  it('ölen, orta çizginin öldüğü yere uzak ucunda doğar', () => {
    for (const [diedAt, back] of [
      [-150, 1],
      [150, -1],
    ] as const) {
      const g = createGame(1);
      const a = addPlayer(g, 'a', 'A', 'red');
      g.phase = 'play';
      Object.assign(a, { x: -200, y: diedAt, hp: 1 });
      openCrate(g, a, a.x, a.y, 'mine');
      expect(a.dead).toBeGreaterThan(0);
      run(g, PLAYER.respawn);
      expect(a.dead).toBe(0);
      expect(Math.sign(a.y)).toBe(back);
      expect(Math.abs(a.y)).toBeGreaterThan(FIELD.halfH - 60);
    }
  });

  it('sarhoş: 4 sn tuşlar ters çalışır, sonra düzelir; santrada ve ölünce geçer', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    g.phase = 'play';
    Object.assign(a, { x: -200, y: 0, vx: 0, vy: 0 });
    openCrate(g, a, a.x, a.y, 'dizzy');
    expect(a.dizzy).toBe(ITEMS.dizzy);
    run(g, 20, new Map([['a', RIGHT]]));
    expect(a.vx).toBeLessThan(0); // pressing right goes left
    run(g, ITEMS.dizzy, new Map([['a', RIGHT]]));
    expect(a.dizzy).toBe(0);
    expect(a.vx).toBeGreaterThan(0);
    openCrate(g, a, a.x, a.y, 'dizzy');
    restartMatch(g);
    expect(a.dizzy).toBe(0);
  });

  it('kalkan ilk kötü şeyi (mayın, buz, sarhoş, mermi) tek seferlik engeller ve bunu gösterir', () => {
    for (const bad of ['mine', 'ice', 'dizzy'] as const) {
      const g = createGame(1);
      const a = addPlayer(g, 'a', 'A', 'red');
      g.phase = 'play';
      Object.assign(a, { x: -200, y: 0, vx: 0, vy: 0 });
      openCrate(g, a, a.x, a.y, 'shield');
      openCrate(g, a, a.x, a.y, bad);
      expect(a).toMatchObject({ shield: false, hp: PLAYER.maxHp, slow: 0, frozen: 0, dizzy: 0 });
      expect(g.blasts.some((b) => b.kind === 'block')).toBe(true);
      // Only once: the next one lands.
      openCrate(g, a, a.x, a.y, bad);
      expect(a.hp < PLAYER.maxHp || a.frozen > 0 || a.dizzy > 0).toBe(true);
    }
  });

  it('süresiz maç: saat ileri sayar, süre bitmez, yalnızca gol limitiyle biter', () => {
    const g = createGame(1, { minutes: 0, scoreLimit: 3, crates: 'off', loot: ['gun'], bots: false });
    addPlayer(g, 'a', 'A', 'red');
    restartMatch(g);
    expect(g.clock).toBe(0);
    g.phase = 'play';
    run(g, 60 * 60);
    expect(g.clock).toBeGreaterThan(60 * 50);
    expect(g.phase).not.toBe('over'); // 0-0 after a minute: nothing ends it
    g.score = [2, 1];
    g.ball = { x: FIELD.halfW - 5, y: 0, vx: 6, vy: 0 };
    run(g, 10);
    run(g, 200);
    expect(g.score[0]).toBe(3);
    expect(g.phase).toBe('over');
  });

  it('oyuncu kalenin arkasından geçebilir (ağın arkasında yer var)', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    g.phase = 'play';
    Object.assign(a, { x: FIELD.halfW + FIELD.goalDepth + PLAYER.radius + 2, y: -FIELD.goalHalf - 30 });
    run(g, 90, new Map([['a', DOWN]]));
    expect(a.y).toBeGreaterThan(FIELD.goalHalf + 10); // went all the way past the back of the net
    expect(a.x).toBeGreaterThan(FIELD.halfW + FIELD.goalDepth);
  });

  it('kaleci ceza sahasında biraz büyük ve çevik: aynı son hız, daha çabuk dönüş', () => {
    const turn = (inBox: boolean) => {
      const g = createGame(1);
      const k = addPlayer(g, 'k', 'K', 'red');
      setRole(g, 'k', 'gk');
      g.phase = 'play';
      Object.assign(k, { x: inBox ? -FIELD.halfW + 60 : -100, y: 0, vx: 0, vy: 0 });
      run(g, 60, new Map([['k', UP]]));
      const top = Math.abs(k.vy);
      // Reverse: how many ticks until moving the other way?
      let t = 0;
      while (k.vy <= 0 && t < 200) {
        step(g, new Map([['k', DOWN]]));
        t++;
      }
      return { top, t, r: k.r };
    };
    const box = turn(true);
    const out = turn(false);
    expect(box.r).toBe(ROLES.gk.radius);
    expect(ROLES.gk.radius).toBeLessThan(22);
    expect(box.t).toBeLessThan(out.t);
    expect(box.top).toBeGreaterThan(out.top * 0.95);
  });

  it('mayın can götürür ve yavaşlatır; buz dondurur', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.hp).toBe(PLAYER.maxHp - 1);
    expect(a.slow).toBe(ITEMS.mineSlow);
    openCrate(g, a, a.x, a.y, 'ice');
    const x = a.x;
    run(g, 30, new Map([['a', RIGHT]]));
    expect(Math.abs(a.x - x)).toBeLessThan(5);
    expect(a.frozen).toBeGreaterThan(0);
  });

  it('kutular zamanla doğar ve dokununca açılır', () => {
    const g = createGame(3);
    const a = addPlayer(g, 'a', 'A', 'red');
    a.x = 9999; // uzakta, kutulara değmesin
    run(g, 60 * 12);
    expect(g.crates.length).toBeGreaterThan(0);
    const c = g.crates[0]!;
    a.x = c.x;
    a.y = c.y;
    step(g);
    expect(g.crates.find((o) => o.id === c.id)).toBeUndefined();
    expect(g.blasts.length).toBeGreaterThan(0);
  });

  it('yalnız botlar ortada birbirine vurup kilitlenmez: her maçta gol olur', () => {
    const goals: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const g = createGame(seed, { minutes: 3, scoreLimit: 5, crates: 'off', loot: ['gun'], bots: true });
      addPlayer(g, 'r', 'R', 'red', true);
      addPlayer(g, 'b', 'B', 'blue', true);
      g.arenaPlan = ['classic'];
      restartMatch(g);
      run(g, 60 * 60);
      goals.push(g.score[0] + g.score[1]);
    }
    expect(Math.min(...goals)).toBeGreaterThan(0);
  });

  it('botlar kendi başına gol atabilir', () => {
    const g = createGame(5);
    addPlayer(g, 'r', 'R', 'red', true);
    run(g, 60 * 30);
    expect(g.score[0]).toBeGreaterThan(0);
  });
});

describe('mevkiler', () => {
  it('takım içinde mevkiler sırayla dağılır ve takas edilir', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'red');
    expect([a.role, b.role]).toEqual(['fwd', 'gk']);
    setRole(g, 'a', 'gk');
    expect([a.role, b.role]).toEqual(['gk', 'fwd']);
  });
  it('kaleci kendi ceza sahasında büyür, dışarıda normale döner', () => {
    const g = createGame(1);
    const k = addPlayer(g, 'k', 'K', 'red');
    setRole(g, 'k', 'gk');
    k.x = -FIELD.halfW + 30;
    k.y = 0;
    step(g);
    expect(k.r).toBe(ROLES.gk.radius);
    k.x = 0;
    step(g);
    expect(k.r).toBe(PLAYER.radius);
  });
  it('forvet hücum bölgesinde daha hızlı koşar', () => {
    const speed = (x: number) => {
      const g = createGame(1);
      g.phase = 'play';
      const p = addPlayer(g, 'f', 'F', 'red');
      p.x = x;
      p.y = 150;
      run(g, 20, new Map([['f', RIGHT]]));
      return p.x - x;
    };
    expect(speed(250)).toBeGreaterThan(speed(-250) * 1.15);
  });
});

describe('pas', () => {
  const setup = (role: 'mid' | 'fwd', mateAngleY: number) => {
    const g = createGame(1);
    g.phase = 'play';
    const a = addPlayer(g, 'a', 'A', 'red');
    const m = addPlayer(g, 'm', 'M', 'red');
    setRole(g, 'a', role);
    a.buff = role === 'mid';
    a.x = -50;
    a.y = 150;
    g.ball = { x: -50 + PLAYER.radius + BALL.radius, y: 150, vx: 0, vy: 0 };
    m.x = 200;
    m.y = 150 + mateAngleY;
    return { g, a, m };
  };
  it('orta saha 15° içindeki arkadaşına pası büker', () => {
    const { g, a } = setup('mid', -50); // ~11°
    expect(kickDirection(g, a)?.to).toBe('m');
  });
  it('forvet yalnızca 6° içinde yardım alır', () => {
    expect(kickDirection(setup('fwd', -50).g, setup('fwd', -50).a)?.to).toBeNull();
    const { g, a } = setup('fwd', -15); // ~3.5°
    expect(kickDirection(g, a)?.to).toBe('m');
  });
  it('kaleye giden şut arkadaşa bükülmez', () => {
    const { g, a, m } = setup('mid', 0);
    a.y = g.ball.y = 0;
    m.y = 8;
    expect(kickDirection(g, a)?.to).toBeNull();
  });
  it('vuruş tuşu basılı değilken top daha az seker (hafif dokunuş)', () => {
    const bounceBack = (bits: number) => {
      const g = createGame(1);
      g.phase = 'play';
      const p = addPlayer(g, 'a', 'A', 'red');
      p.x = 0;
      p.y = 150;
      p.kickArmed = false;
      g.ball = { x: 40, y: 150, vx: -6, vy: 0 };
      run(g, 6, new Map([['a', bits]]));
      return g.ball.vx;
    };
    expect(bounceBack(0)).toBeLessThan(bounceBack(KICK));
  });
});

describe('ışınlanma (sıçrama)', () => {
  const setup = () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    Object.assign(a, { x: 0, y: 0, vx: 0, vy: 0 });
    Object.assign(b, { x: 0, y: -150 });
    return { g, a, b };
  };

  it('basılan yöne sabit mesafe sıçrar, hız korunur', () => {
    const { g, a } = setup();
    openCrate(g, a, a.x, a.y, 'teleport');
    run(g, 10, new Map([['a', RIGHT]]));
    const x0 = a.x;
    const v0 = a.vx;
    step(g, new Map([['a', RIGHT | USE]]));
    expect(a.teleport).toBe(false);
    expect(a.x - x0).toBeGreaterThan(ITEMS.blinkDistance);
    expect(a.x - x0).toBeLessThan(ITEMS.blinkDistance + 5);
    expect(a.vx).toBeGreaterThan(v0 * 0.9);
    expect(g.blasts.filter((x) => x.kind === 'warp')).toHaveLength(2);
  });

  it('çapraz basınca çapraz gider, toplam mesafe aynı', () => {
    const { g, a } = setup();
    a.teleport = true;
    step(g, new Map([['a', UP | LEFT | USE]]));
    expect(a.x).toBeCloseTo(-ITEMS.blinkDistance / Math.SQRT2, 0);
    expect(a.y).toBeCloseTo(-ITEMS.blinkDistance / Math.SQRT2, 0);
  });

  it('yön tuşuna basılmıyorsa son hareket yönüne gider', () => {
    const { g, a } = setup();
    a.teleport = true;
    run(g, 3, new Map([['a', DOWN]]));
    run(g, 20, new Map([['a', 0]]));
    const y0 = a.y;
    step(g, new Map([['a', USE]]));
    expect(a.y - y0).toBeGreaterThan(ITEMS.blinkDistance - 2);
  });

  it('saha sınırında durur', () => {
    const { g, a } = setup();
    Object.assign(a, { teleport: true, x: 400 });
    step(g, new Map([['a', RIGHT | USE]]));
    expect(a.x).toBeLessThanOrEqual(FIELD.halfW + FIELD.marginX - PLAYER.radius);
  });

  it('tuşu basılı tutarken kutu açılırsa sıçramak için yeniden basmak gerekir', () => {
    const { g, a } = setup();
    step(g, new Map([['a', USE]]));
    openCrate(g, a, a.x, a.y, 'teleport');
    run(g, 5, new Map([['a', USE]]));
    expect(a.teleport).toBe(true);
    step(g, new Map([['a', 0]]));
    step(g, new Map([['a', RIGHT | USE]]));
    expect(a.teleport).toBe(false);
  });

  it('elde tek eşya: silah ışınlanmanın, ışınlanma silahın yerini alır', () => {
    const { g, a } = setup();
    openCrate(g, a, a.x, a.y, 'teleport');
    openCrate(g, a, a.x, a.y, 'gun');
    expect(a).toMatchObject({ teleport: false, gun: ITEMS.gunAmmo });
    openCrate(g, a, a.x, a.y, 'teleport');
    expect(a).toMatchObject({ teleport: true, gun: 0 });
  });

  it('donmuşken kullanılamaz, ölünce kaybolur', () => {
    const { g, a } = setup();
    Object.assign(a, { teleport: true, frozen: 30 });
    step(g, new Map([['a', RIGHT | USE]]));
    expect(a.teleport).toBe(true);
    Object.assign(a, { frozen: 0, hp: 1 });
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.dead).toBeGreaterThan(0);
    expect(a.teleport).toBe(false);
  });

  it('bot hedefine uzak kalınca o yöne sıçrar', () => {
    const g = createGame(1);
    const bot = addPlayer(g, 'bot', 'Bot', 'red', true);
    addPlayer(g, 'b', 'B', 'blue').x = 400;
    g.phase = 'play';
    Object.assign(bot, { x: -350, y: 0, teleport: true });
    g.ball = { x: 150, y: 0, vx: 0, vy: 0 };
    run(g, 60);
    expect(bot.teleport).toBe(false);
  });
});

describe('gol sonrası ve yeniden doğma', () => {
  it('gol sonrası santrada her şey sıfırlanır: can, silah, etkiler, ölüler, kutular', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    Object.assign(a, { hp: 1, gun: 4, shield: true, power: true, slow: 100, boost: 50 });
    Object.assign(b, { hp: 0, dead: 120, frozen: 30, teleport: true });
    g.crates = [{ id: 99, x: 100, y: 100 }];
    g.ball = { x: FIELD.halfW - 5, y: 0, vx: 6, vy: 0 };
    run(g, 10);
    expect(g.phase).toBe('goal');
    run(g, 160);
    expect(g.phase).toBe('kickoff');
    for (const p of [a, b]) {
      expect(p).toMatchObject({
        hp: PLAYER.maxHp,
        dead: 0,
        gun: 0,
        teleport: false,
        shield: false,
        power: false,
        slow: 0,
        boost: 0,
        frozen: 0,
      });
    }
    expect(g.crates).toEqual([]);
  });
  it('ölen oyuncu orta çizginin ucunda, kendi yarısında doğar', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'blue');
    g.phase = 'play';
    // Parked at -9999: died in the bottom half, so back in at the top end.
    Object.assign(a, { hp: 0, dead: 1, x: 9999, y: -9999 });
    step(g);
    expect(a.dead).toBe(0);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(60);
    expect(a.y).toBeLessThan(-FIELD.halfH + 40);
  });
});

describe('inceleme düzeltmeleri (sim)', () => {
  it('aşırı hızlı top bile kale yanındaki duvardan geçmez (hız tavanı)', () => {
    const g = createGame(1);
    addPlayer(g, 'a', 'A', 'red').x = -300;
    g.phase = 'play';
    g.ball = { x: FIELD.halfW - 11, y: FIELD.goalHalf + 30, vx: 100, vy: -12 };
    run(g, 3);
    expect(g.score).toEqual([0, 0]);
  });

  it('çok hızlı top kalenin yanındaki çizgiden geçip gol olmaz (#4)', () => {
    const g = createGame(1);
    addPlayer(g, 'a', 'A', 'red').x = -300;
    g.phase = 'play';
    g.ball = { x: 409, y: 100, vx: 23, vy: 0 };
    run(g, 5);
    expect(g.score).toEqual([0, 0]);
    expect(g.ball.x).toBeLessThan(FIELD.halfW);
  });
  it('aynı noktada doğan iki oyuncu ayrılır (#11)', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'red');
    g.phase = 'play';
    for (const p of [a, b]) Object.assign(p, { hp: 0, dead: 1, x: 9999, y: 9999 });
    run(g, 10);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(PLAYER.radius * 2 - 1);
  });
});

describe('bazuka', () => {
  const setup = () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const m = addPlayer(g, 'm', 'M', 'red');
    const b = addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    Object.assign(a, { x: -300, y: 0, vx: 0, vy: 0, fx: 0, fy: -1 });
    Object.assign(m, { x: -300, y: 250 });
    Object.assign(b, { x: 150, y: 120 });
    g.ball = { x: 0, y: -170, vx: 0, vy: 0 };
    openCrate(g, a, a.x, a.y, 'bazooka');
    return { g, a, m, b };
  };

  it('tuşla yön verilmez: en yakın rakibe kilitlenir, tek roket onu tek vuruşta öldürür', () => {
    const { g, a, m, b } = setup();
    expect(a).toMatchObject({ bazooka: true, gun: 0, teleport: false });
    expect(gunTarget(g, a)?.id).toBe('b');
    // Pressing UP does not matter: the rocket goes for the locked-on enemy.
    step(g, new Map([['a', UP | USE]]));
    expect(a.bazooka).toBe(false);
    expect(g.bullets).toHaveLength(1);
    expect(g.bullets[0]).toMatchObject({ rocket: true, target: 'b' });
    expect(g.bullets[0]!.vx).toBeGreaterThan(0);
    run(g, 150, new Map([['a', USE]]));
    expect(m.hp).toBe(PLAYER.maxHp);
    expect(b.dead).toBeGreaterThan(0);
    expect(g.bullets).toHaveLength(0);
  });

  it('roket hedefi takip eder: kaçan rakibe döner', () => {
    const { g, b } = setup();
    step(g, new Map([['a', USE]]));
    const r = g.bullets[0]!;
    const vy0 = r.vy;
    // The target runs down: the rocket bends after them.
    run(g, 20, new Map([['b', DOWN]]));
    expect(r.vy).toBeGreaterThan(vy0);
    expect(Math.hypot(r.vx, r.vy)).toBeCloseTo(ITEMS.rocketSpeed);
    run(g, 200, new Map([['b', DOWN]]));
    expect(b.dead).toBeGreaterThan(0);
  });

  it('kalkan roketi bir kez durdurur; menzilde kimse yoksa düz gider', () => {
    const { g, b } = setup();
    b.shield = true;
    step(g, new Map([['a', USE]]));
    run(g, 150);
    expect(b).toMatchObject({ shield: false, dead: 0, hp: PLAYER.maxHp });
    const g2 = setup().g;
    const a2 = g2.players.find((p) => p.id === 'a')!;
    g2.players.find((p) => p.id === 'b')!.x = 600;
    a2.x = -400;
    expect(gunTarget(g2, a2)).toBeNull();
    step(g2, new Map([['a', USE]]));
    expect(g2.bullets[0]).toMatchObject({ vx: 0, vy: -ITEMS.rocketSpeed });
    expect(g2.bullets[0]!.target).toBeUndefined();
  });

  it('kutularda iyiler ve kötüler eşit ağırlıkta; bazuka silahtan nadir', () => {
    const weight = (k: string) => CRATES.loot.find(([kind]) => kind === k)![1];
    const bad = ['mine', 'ice', 'dizzy'];
    const sum = (ks: string[]) => ks.reduce((s, k) => s + weight(k), 0);
    const all = CRATES.loot.map(([k]) => k);
    expect(sum(bad)).toBe(sum(all.filter((k) => !bad.includes(k))));
    expect(weight('bazooka')).toBeLessThan(weight('gun'));
  });

  it('bot kilitlenince ateşler', () => {
    const { g, a } = setup();
    a.bot = true;
    let bits = 0;
    for (let t = 0; t < 30 && !(bits & USE); t++) {
      g.tick++;
      bits = botInput(g, a);
    }
    expect(bits & USE).toBe(USE);
  });
});

describe('kutu içeriği ayarı', () => {
  it('tek tür seçilince her kutudan o çıkar', () => {
    const g = createGame(3, { minutes: 3, scoreLimit: 5, crates: 'chaos', loot: ['teleport'], bots: false });
    const a = addPlayer(g, 'a', 'A', 'red');
    g.phase = 'play';
    a.x = 9999;
    for (let i = 0; i < 5; i++) {
      run(g, 60 * 6);
      const c = g.crates[0];
      if (!c) continue;
      a.x = c.x;
      a.y = c.y;
      step(g);
      expect(a.teleport).toBe(true);
      a.teleport = false;
      a.x = 9999;
    }
  });
});

describe('sahalar', () => {
  const arenaGame = (seed = 1, scoreLimit = 5) => {
    const g = createGame(seed, { minutes: 3, scoreLimit, crates: 'off', loot: [...ITEM_KINDS], bots: false });
    addPlayer(g, 'a', 'A', 'red');
    return g;
  };

  it('sıra: gol limitinin iki katı uzunlukta, her 5 santrada 5 sahanın hepsi, üst üste aynı saha yok', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g = arenaGame(seed, 7);
      newArenaPlan(g);
      expect(g.arenaPlan).toHaveLength(14);
      expect(new Set(g.arenaPlan.slice(0, 5)).size).toBe(5);
      expect(new Set(g.arenaPlan.slice(5, 10)).size).toBe(5);
      for (let i = 1; i < g.arenaPlan.length; i++) expect(g.arenaPlan[i]).not.toBe(g.arenaPlan[i - 1]);
    }
  });

  it('sıra yalnızca seçilen sahalardan; tek saha seçiliyse hep o', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = arenaGame(seed, 5);
      g.settings.arenas = ['rain', 'volcano', 'wind'];
      newArenaPlan(g);
      expect(g.arenaPlan).toHaveLength(10);
      expect(new Set(g.arenaPlan.slice(0, 3))).toEqual(new Set(['rain', 'volcano', 'wind']));
      for (let i = 1; i < g.arenaPlan.length; i++) expect(g.arenaPlan[i]).not.toBe(g.arenaPlan[i - 1]);
    }
    const g = arenaGame(1, 3);
    g.settings.arenas = ['ice'];
    newArenaPlan(g);
    expect(g.arenaPlan).toEqual(Array(6).fill('ice'));
  });

  it('her santrada plandaki sıradaki sahaya geçilir', () => {
    const g = arenaGame();
    newArenaPlan(g);
    restartMatch(g);
    expect(g.arena.kind).toBe(g.arenaPlan[0]);
    g.phase = 'play';
    g.ball = { x: FIELD.halfW - 5, y: 0, vx: 6, vy: 0 };
    run(g, 10);
    expect(g.phase).toBe('goal');
    run(g, 160);
    expect(g.arena.kind).toBe(g.arenaPlan[1]);
  });

  const onArena = (kind: (typeof ARENAS.kinds)[number], seed = 1) => {
    const g = arenaGame(seed);
    g.arenaPlan = [kind];
    restartMatch(g);
    g.phase = 'play';
    return g;
  };

  it('yağmur: herkes biraz, birikintide çok yavaşlar; birikintiler oluşup kurur', () => {
    const speed = (kind: 'classic' | 'rain') => {
      const g = onArena(kind);
      g.arena.puddles = [];
      g.arena.nextSpawn = 1e9;
      const p = g.players[0]!;
      Object.assign(p, { x: -300, y: 150, vx: 0, vy: 0 });
      run(g, 30, new Map([['a', RIGHT]]));
      return p.x + 300;
    };
    expect(speed('rain')).toBeLessThan(speed('classic') * 0.95);
    const g = onArena('rain');
    expect(g.arena.puddles.length).toBeGreaterThanOrEqual(3);
    const first = g.arena.puddles[0]!;
    run(g, first.life + 10);
    expect(g.arena.puddles.includes(first)).toBe(false);
    expect(g.arena.puddles.length).toBeGreaterThanOrEqual(3);
  });

  it('volkan: lav yukarıdan aşağı akar, yavaşlatır ama can götürmez; patlama sadece lavın üstünde', () => {
    const g = onArena('volcano', 4);
    const p = g.players[0]!;
    run(g, 60 * 8);
    const s = g.arena.streams[0]!;
    expect(s.points.length).toBeGreaterThan(5);
    const ys = s.points.map((pt) => pt.y);
    expect(ys.at(-1)!).toBeGreaterThan(ys[0]!);
    // stand in the hottest lava: slowed, no damage
    const hot = s.points.at(-1)!;
    Object.assign(p, { x: hot.x, y: hot.y, vx: 0, vy: 0, hp: PLAYER.maxHp });
    expect(inHotLava(g, p)).toBe(true);
    let erupted = false;
    for (let t = 0; t < 60 * 30; t++) {
      const warn = g.arena.warn;
      step(g);
      if (warn && !g.arena.warn) {
        erupted = true;
        const onLava = g.arena.streams.some((st) =>
          st.points.some((pt) => pt.x === warn.x && pt.y === warn.y),
        );
        expect(onLava).toBe(true);
      }
    }
    expect(erupted).toBe(true);
  });

  it('rüzgâr: yönü zamanla döner ve topu iter', () => {
    const g = onArena('wind', 2);
    const w0 = { ...g.arena.wind };
    g.ball = { x: 0, y: 0, vx: 0, vy: 0 };
    run(g, 120);
    expect(Math.hypot(g.ball.x, g.ball.y)).toBeGreaterThan(5);
    run(g, 60 * 20);
    const w1 = g.arena.wind;
    expect(Math.hypot(w1.x, w1.y)).toBeCloseTo(1, 6);
    expect(Math.abs(w1.x - w0.x) + Math.abs(w1.y - w0.y)).toBeGreaterThan(0.1);
  });

  it('sahalarla birlikte de deterministik', () => {
    const play = () => {
      const g = arenaGame(9);
      addPlayer(g, 'b', 'B', 'blue', true);
      newArenaPlan(g);
      restartMatch(g);
      for (let t = 0; t < 60 * 90; t++) step(g, new Map([['a', (t * 13) % 64]]));
      return hashState(g);
    };
    expect(play()).toBe(play());
  });
});

describe('silah otomatik nişan', () => {
  const setup = () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const near = addPlayer(g, 'near', 'N', 'blue');
    const far = addPlayer(g, 'far', 'F', 'blue');
    g.phase = 'play';
    Object.assign(a, { x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: -1, gun: ITEMS.gunAmmo });
    Object.assign(near, { x: 150, y: 0, vx: 0, vy: 0 });
    Object.assign(far, { x: 0, y: 160, vx: 0, vy: 0 });
    g.ball = { x: -300, y: -150, vx: 0, vy: 0 };
    return { g, a, near, far };
  };
  const bulletDir = (g: ReturnType<typeof createGame>) => {
    const b = g.bullets.at(-1)!;
    return { x: b.vx / ITEMS.bulletSpeed, y: b.vy / ITEMS.bulletSpeed };
  };

  it('en yakın rakibe sıkar, baktığın yöne değil', () => {
    const { g } = setup();
    step(g, new Map([['a', USE]]));
    expect(bulletDir(g).x).toBeCloseTo(1, 3);
  });
  it('arada takım arkadaşı varsa sıradaki rakibe sıkar', () => {
    const { g } = setup();
    addPlayer(g, 'mate', 'M', 'red');
    Object.assign(
      g.players.find((p) => p.id === 'mate')!,
      { x: 75, y: 0 },
    );
    step(g, new Map([['a', USE]]));
    expect(bulletDir(g).y).toBeCloseTo(1, 3);
  });
  it('arada top varsa da atlar', () => {
    const { g } = setup();
    g.ball = { x: 0, y: 80, vx: 0, vy: 0 };
    expect(gunTarget(g, g.players[0]!)?.id).toBe('near');
    g.ball = { x: 75, y: 0, vx: 0, vy: 0 };
    expect(gunTarget(g, g.players[0]!)?.id).toBe('far');
  });
  it('menzilde kimse yoksa baktığı yöne sıkar', () => {
    const { g, near, far } = setup();
    Object.assign(near, { x: 2000 });
    Object.assign(far, { x: 2000, y: 2000 });
    step(g, new Map([['a', USE]]));
    expect(bulletDir(g).y).toBeCloseTo(-1, 3);
  });
  it('koşan rakibin önüne nişan alır', () => {
    const { g, near } = setup();
    Object.assign(near, { vy: 2 });
    const t = gunTarget(g, g.players[0]!)!;
    expect(t.y).toBeGreaterThan(20);
  });
});
