import { describe, expect, it } from 'vitest';
import { KICK, RIGHT, addPlayer, cloneGame, createGame, hashState, step } from '@crateball/sim';
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
    const near = shownAfter(-40);
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
