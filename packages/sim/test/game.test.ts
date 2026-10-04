import { describe, expect, it } from 'vitest';
import {
  BALL,
  FIELD,
  ITEMS,
  KICK,
  PLAYER,
  RIGHT,
  USE,
  addPlayer,
  cloneGame,
  createGame,
  hashState,
  ROLES,
  kickDirection,
  openCrate,
  setRole,
  step,
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

describe('ışınlanma', () => {
  const setup = () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'red');
    const b = addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    Object.assign(a, { x: 250, y: 120, vx: 3, vy: -2 });
    return { g, a, b };
  };

  it('kutudan çıkınca elde tutulur, tuşa basınca kendi kalesinin önüne ışınlar', () => {
    const { g, a } = setup();
    openCrate(g, a, a.x, a.y, 'teleport');
    expect(a.teleport).toBe(true);
    step(g);
    expect(a.x).toBeGreaterThan(200);
    step(g, new Map([['a', USE]]));
    expect(a.teleport).toBe(false);
    expect(a.x).toBeCloseTo(-(FIELD.halfW - ITEMS.teleportInset));
    expect(a.y).toBeCloseTo(0);
    expect(Math.abs(a.vx) + Math.abs(a.vy)).toBeLessThan(0.01);
    expect(g.blasts.filter((b) => b.kind === 'warp')).toHaveLength(2);
  });

  it('mavi takım kendi (sağ) kalesine ışınlanır; top yerinde kalır', () => {
    const { g, b } = setup();
    Object.assign(b, { x: -250, y: -100, teleport: true });
    g.ball = { x: -200, y: 50, vx: 0, vy: 0 };
    step(g, new Map([['b', USE]]));
    expect(b.x).toBeCloseTo(FIELD.halfW - ITEMS.teleportInset);
    expect(g.ball.x).toBeCloseTo(-200);
  });

  it('tuşu basılı tutarken kutu açılırsa ışınlanmak için yeniden basmak gerekir', () => {
    const { g, a } = setup();
    step(g, new Map([['a', USE]]));
    openCrate(g, a, a.x, a.y, 'teleport');
    run(g, 5, new Map([['a', USE]]));
    expect(a.teleport).toBe(true);
    expect(a.x).toBeGreaterThan(200);
    step(g, new Map([['a', 0]]));
    step(g, new Map([['a', USE]]));
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
    step(g, new Map([['a', USE]]));
    expect(a.teleport).toBe(true);
    expect(a.x).toBeGreaterThan(200);
    Object.assign(a, { frozen: 0, hp: 1 });
    openCrate(g, a, a.x, a.y, 'mine');
    expect(a.dead).toBeGreaterThan(0);
    expect(a.teleport).toBe(false);
  });

  it('bot, top kendi yarısının derinindeyken ileride kaldıysa ışınlanır', () => {
    const g = createGame(1);
    const bot = addPlayer(g, 'bot', 'Bot', 'red', true);
    addPlayer(g, 'b', 'B', 'blue');
    g.phase = 'play';
    Object.assign(bot, { x: 250, y: 0, teleport: true });
    g.ball = { x: -330, y: 0, vx: -1, vy: 0 };
    run(g, 10);
    expect(bot.teleport).toBe(false);
    expect(bot.x).toBeLessThan(0);
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
  it('ölen oyuncu orta çizginin üst ucunda, kendi yarısında doğar', () => {
    const g = createGame(1);
    const a = addPlayer(g, 'a', 'A', 'blue');
    g.phase = 'play';
    Object.assign(a, { hp: 0, dead: 1, x: 9999, y: 9999 });
    step(g);
    expect(a.dead).toBe(0);
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(60);
    expect(a.y).toBeLessThan(-FIELD.halfH + 40);
  });
});

describe('inceleme düzeltmeleri (sim)', () => {
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
