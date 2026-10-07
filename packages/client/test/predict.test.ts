import { describe, expect, it } from 'vitest';
import { KICK, RIGHT, addPlayer, cloneGame, createGame, hashState, step, type Game } from '@crateball/sim';
import { createPredictor } from '../src/predict';

/** Server consumes one queued input per tick; the client is `lag` ticks ahead. */
function simulate(lag: number) {
  const server = createGame(11);
  addPlayer(server, 'me', 'Me', 'red');
  addPlayer(server, 'b1', 'Bot', 'blue', true);
  const client = createPredictor();
  client.setMe('me');
  client.snapshot(0, cloneGame(server));
  const inflight: Array<[number, number]> = [];
  let ack = 0;
  for (let t = 0; t < 400; t++) {
    const bits = t % 50 < 30 ? RIGHT : t % 50 === 31 ? KICK : 0;
    const seq = client.tick(bits)!;
    inflight.push([seq, bits]);
    if (inflight.length > lag) {
      const [s, b] = inflight.shift()!;
      step(server, new Map([['me', b]]));
      ack = s;
      if (t % 2 === 0) client.snapshot(ack, cloneGame(server));
    }
  }
  return { server, client, ack, inflight };
}

describe('tahmin', () => {
  it('geri sarıp yeniden simüle edince sunucuyla aynı yere varır (gecikmeye rağmen)', () => {
    const { server, client, inflight } = simulate(6);
    // Remaining in-flight inputs applied on the server must land exactly where the client already is.
    for (const [, b] of inflight) step(server, new Map([['me', b]]));
    expect(hashState(client.game)).toBe(hashState(server));
  });

  it('düzeltme yokken yumuşatma ofseti sıfır kalır', () => {
    const { client } = simulate(4);
    const p = client.pos('me', 1)!;
    const g = client.game!;
    const me = g.players.find((o) => o.id === 'me')!;
    expect(p.x).toBeCloseTo(me.x, 6);
    expect(client.pending).toBeGreaterThan(0);
  });

  it('sunucu farklı derse fark yumuşatılır ve söner', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    c.snapshot(0, g);
    const moved = cloneGame(g);
    moved.ball.x = 20;
    c.snapshot(0, moved);
    expect(c.pos('ball', 1)!.x).toBeCloseTo(0, 6);
    c.decay(4);
    expect(c.pos('ball', 1)!.x).toBeCloseTo(20, 2);
  });

  it('top uzaktayken düzeltme daha yavaş (akıcı) söner, yanımdayken hızlı', () => {
    const shownAfter = (meX: number) => {
      const c = createPredictor();
      c.setMe('me');
      const g = createGame(1);
      const me = addPlayer(g, 'me', 'Me', 'red');
      Object.assign(me, { x: meX, y: 0 });
      c.snapshot(0, g);
      const moved = cloneGame(g);
      moved.ball.x = 20;
      c.snapshot(0, moved);
      c.decay(0.1);
      return 20 - c.pos('ball', 1)!.x; // offset still left
    };
    const far = shownAfter(-300);
    const near = shownAfter(-18); // within touching distance of the ball (at x 20)
    expect(near).toBeLessThan(far);
    expect(far).toBeGreaterThan(12); // ~200 ms half-life
    expect(near).toBeLessThan(10); // ~90 ms half-life
  });
});

describe('ışınlanma', () => {
  it('üst üste gelen küçük düzeltmeler biriken farkı bir anda sıfırlamaz (zıplama yok)', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    c.snapshot(0, g);
    let shown = c.pos('ball', 1)!.x;
    for (let i = 1; i <= 8; i++) {
      const moved = cloneGame(g);
      moved.ball.x = i * 15; // her snapshot 15 px düzeltme → toplam 120 px
      c.snapshot(0, moved);
      const now = c.pos('ball', 1)!.x;
      expect(Math.abs(now - shown)).toBeLessThanOrEqual(15 + 1e-9);
      shown = now;
    }
  });
  it('tek seferde büyük fark (yeniden doğma) doğrudan gösterilir', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    c.snapshot(0, g);
    const moved = cloneGame(g);
    moved.ball.x = 300;
    c.snapshot(0, moved);
    expect(c.pos('ball', 1)!.x).toBe(300);
  });
  it('sunucu bizim yerimize tick saydıysa sıra numarası onun ardından devam eder', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    c.snapshot(0, g);
    c.tick(0);
    c.snapshot(5, g);
    expect(c.tick(0)).toBe(6);
  });
});

describe('top', () => {
  it('başkasının sert vuruşu geç gelince top 120 px atlamaz, kayarak yerine gider', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    c.snapshot(0, g);
    const kicked = cloneGame(g);
    kicked.ball.x = 120;
    c.snapshot(0, kicked);
    expect(c.pos('ball', 1)!.x).toBeLessThan(5);
    c.decay(0.1);
    const mid = c.pos('ball', 1)!.x;
    expect(mid).toBeGreaterThan(30);
    expect(mid).toBeLessThan(110);
  });
  it('santra (top kaleden ortaya) hâlâ doğrudan ışınlanır', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    g.ball.x = 440;
    c.snapshot(0, g);
    const reset = cloneGame(g);
    reset.ball.x = 0;
    c.snapshot(0, reset);
    expect(c.pos('ball', 1)!.x).toBe(0);
  });
});

describe('girdi aktarımı', () => {
  /** Server and client start from the same snapshot; `r` is another human who presses RIGHT at tick k. */
  const setup = () => {
    const server = createGame(5);
    addPlayer(server, 'me', 'Me', 'red');
    addPlayer(server, 'r', 'R', 'blue');
    const c = createPredictor();
    c.setMe('me');
    c.snapshot(0, cloneGame(server));
    return { server, c, start: server.tick };
  };
  const serverRun = (server: Game, ticks: number, k: number) => {
    for (let i = 0; i < ticks; i++) {
      const inputs = new Map([['me', 0]]);
      if (server.tick === k) inputs.set('r', RIGHT);
      step(server, inputs);
    }
  };

  it('tahminin geçmişine düşen aktarım hemen yeniden simüle edilir ve sunucuyla aynı yere varır', () => {
    const { server, c, start } = setup();
    for (let i = 0; i < 8; i++) c.tick(0);
    const k = start + 3;
    const before = c.corrections;
    c.remoteInput('r', k, RIGHT);
    serverRun(server, 8, k);
    expect(hashState(c.game)).toBe(hashState(server));
    expect(c.corrections).toBeGreaterThan(before); // r's position changed: an offset now glides it
  });

  it('henüz gelmediğimiz tick için gelen aktarım düzeltmesiz, zamanı gelince oynanır', () => {
    const { server, c, start } = setup();
    for (let i = 0; i < 2; i++) c.tick(0);
    const k = start + 5;
    c.remoteInput('r', k, RIGHT);
    expect(c.corrections).toBe(0);
    for (let i = 0; i < 6; i++) c.tick(0);
    serverRun(server, 8, k);
    expect(hashState(c.game)).toBe(hashState(server));
    expect(c.corrections).toBe(0);
  });

  it('kendi girdimiz aktarımla ezilmez; snapshot içindeki eski aktarım sonucu bozmaz', () => {
    const { server, c, start } = setup();
    c.remoteInput('r', start, RIGHT);
    serverRun(server, 3, start);
    c.snapshot(0, cloneGame(server));
    c.remoteInput('me', server.tick, RIGHT);
    c.tick(0);
    step(server, new Map([['me', 0]]));
    expect(hashState(c.game)).toBe(hashState(server));
  });

  it('başlama vuruşu girdiyi sıfırlasa da basılı tutulan tuş tahminde sürer', () => {
    const { server, c, start } = setup();
    c.remoteInput('r', start, RIGHT);
    const held = () =>
      step(
        server,
        new Map([
          ['me', 0],
          ['r', RIGHT],
        ]),
      );
    held();
    // The server's kickoff reset zeroes every input inside the step; the server still applies RIGHT next.
    const snap = cloneGame(server);
    snap.players.find((p) => p.id === 'r')!.input = 0;
    server.players.find((p) => p.id === 'r')!.input = 0;
    c.snapshot(0, snap);
    for (let i = 0; i < 5; i++) {
      c.tick(0);
      held();
    }
    expect(hashState(c.game)).toBe(hashState(server));
  });

  it('sunucu ileride duyurduğu değişikliği geri alınca (kırpma) tahmin onu oynamaz', () => {
    const { server, c, start } = setup();
    c.remoteInput('r', start + 4, KICK | RIGHT); // announced for later…
    c.remoteInput('r', start, RIGHT); // …then re-sent from an earlier tick: replaces it
    for (let i = 0; i < 8; i++) c.tick(0);
    for (let i = 0; i < 8; i++)
      step(
        server,
        new Map([
          ['me', 0],
          ['r', RIGHT],
        ]),
      );
    expect(hashState(c.game)).toBe(hashState(server));
  });

  it('aynı karede gelen birçok aktarım tek yeniden simülasyon; giden oyuncunun kaydı silinir', () => {
    const { server, c, start } = setup();
    for (let i = 0; i < 6; i++) c.tick(0);
    const before = c.corrections;
    for (let i = 0; i < 50; i++) c.remoteInput('r', start + 1 + (i % 3), i % 2 ? RIGHT : 0);
    expect(c.corrections).toBe(before); // nothing re-simulated yet
    c.pos('ball', 1);
    // Gone from the match: its relayed keys are dropped with the next snapshot, nothing breaks.
    const gone = cloneGame(server);
    gone.players = gone.players.filter((p) => p.id !== 'r');
    c.snapshot(6, gone);
    c.remoteInput('r', gone.tick + 1, RIGHT);
    c.tick(0);
    step(gone, new Map([['me', 0]]));
    expect(hashState(c.game)).toBe(hashState(gone));
  });
});

describe('düzeltme sunumu', () => {
  it('düzeltme anında çizilen top yerinde kalır (hız değişse de ara karede sıçramaz)', () => {
    const c = createPredictor();
    c.setMe('me');
    const g = createGame(1);
    addPlayer(g, 'me', 'Me', 'red');
    Object.assign(g.ball, { x: 0, y: 0, vx: 6, vy: 0 });
    c.snapshot(0, cloneGame(g));
    c.tick(0);
    c.tick(0);
    const drawn = c.pos('ball', 0.3)!;
    // The server says the ball was kicked back: same place, opposite velocity.
    const kicked = cloneGame(g);
    kicked.ball.vx = -6;
    c.snapshot(0, kicked);
    const now = c.pos('ball', 0.3)!;
    expect(now.x).toBeCloseTo(drawn.x, 9);
    expect(now.y).toBeCloseTo(drawn.y, 9);
  });
});
