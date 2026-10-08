import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  PROTOCOL_VERSION,
  SNAP_DELTA,
  SNAP_KEY,
  createSnapDecoder,
  decodeClientMessage,
  decodeFrame,
  decodeServerData,
  decodeServerMessage,
  deltaBody,
  encode,
  encodeFrame,
  encodeGame,
  keyBody,
  snapState,
  type Plain,
} from '../src/index';
import { defaultWeights, type Game } from '@crateball/sim';

describe('istemci mesajları', () => {
  it('varsayılan kutu payları sim ile aynı', () => {
    expect(DEFAULT_WEIGHTS).toEqual(defaultWeights());
  });
  it('snapshot hassasiyeti simin durum hassasiyetiyle aynı', async () => {
    const sim = await import('@crateball/sim');
    const { STATE_SCALE } = await import('../src/index');
    expect(STATE_SCALE).toBe(sim.STATE_SCALE);
  });
  it('hello gidiş-dönüş (token ile ve tokensız)', () => {
    const a = { t: 'hello', protocolVersion: PROTOCOL_VERSION } as const;
    const b = { t: 'hello', protocolVersion: PROTOCOL_VERSION, sessionToken: 'abc' } as const;
    expect(decodeClientMessage(encode(a))).toEqual(a);
    expect(decodeClientMessage(encode(b))).toEqual(b);
  });
  it('ping gidiş-dönüş', () => {
    expect(decodeClientMessage(encode({ t: 'ping', id: 7 }))).toEqual({ t: 'ping', id: 7 });
  });
  it('fazladan alanları atar', () => {
    expect(decodeClientMessage('{"t":"ping","id":3,"evil":true}')).toEqual({ t: 'ping', id: 3 });
  });
  it.each([
    'not json',
    '[]',
    'null',
    '{"t":"hello"}',
    '{"t":"hello","protocolVersion":-1}',
    `{"t":"hello","protocolVersion":1,"sessionToken":"${'x'.repeat(129)}"}`,
    '{"t":"ping","id":1.5}',
    '{"t":"nope"}',
  ])('geçersiz mesajı reddeder: %s', (raw) => {
    expect(decodeClientMessage(raw)).toBeNull();
  });
});

describe('sunucu mesajları', () => {
  it('welcome ve pong gidiş-dönüş', () => {
    const w = { t: 'welcome', protocolVersion: 1, clientId: 'ab12cd34', serverTime: 123 } as const;
    expect(decodeServerMessage(encode(w))).toEqual(w);
    expect(decodeServerMessage(encode({ t: 'pong', id: 2, serverTime: 5 }))).toEqual({
      t: 'pong',
      id: 2,
      serverTime: 5,
    });
  });
  it('Türkçe hata metni bozulmadan taşınır', () => {
    const e = {
      t: 'error',
      code: 'version_mismatch',
      message: 'Oyun güncellendi — sayfayı yenile (Şş Ğğ İı)',
    } as const;
    expect(decodeServerMessage(encode(e))).toEqual(e);
  });
  it('bilinmeyen hata kodunu reddeder', () => {
    expect(decodeServerMessage('{"t":"error","code":"boom","message":"x"}')).toBeNull();
  });
});

describe('oyun mesajları', () => {
  it('join adı temizler, kodu doğrular', () => {
    expect(decodeClientMessage('{"t":"join","code":"ABCD","name":"  Şükrü\\u0007 "}')).toEqual({
      t: 'join',
      code: 'ABCD',
      name: 'Şükrü',
    });
    expect(decodeClientMessage('{"t":"join","code":"ABIO","name":"x"}')).toBeNull();
  });
  it('isimden yön çeviren ve görünmez karakterleri atar, emoji birleştiricisini bırakır', () => {
    const m = decodeClientMessage(
      JSON.stringify({ t: 'join', code: 'ABCD', name: 'a\u202Eb\u200Bc\u0085d👩\u200D💻' }),
    );
    expect(m).toMatchObject({ name: 'abcd👩\u200D💻' });
  });
  it('ayarları seçeneklerle sınırlar', () => {
    const ok = { minutes: 3, scoreLimit: 5, crates: 'chaos', bots: false };
    const raw = (settings: unknown) =>
      JSON.stringify({ t: 'create', name: 'A', roomName: '', public: true, settings });
    expect(decodeClientMessage(raw(ok))).toEqual({
      t: 'create',
      name: 'A',
      roomName: "A's room",
      public: true,
      settings: {
        ...ok,
        weights: defaultWeights(),
        roles: true,
        arenas: ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'],
      },
    });
    expect(decodeClientMessage(raw({ ...ok, minutes: 999 }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, minutes: 0 }))).toMatchObject({ settings: { minutes: 0 } });
    // Crate shares: whole numbers 0..100 adding up to 1..100, missing items = 0.
    expect(decodeClientMessage(raw({ ...ok, weights: { gun: 60, mine: 30 } }))).toMatchObject({
      settings: { weights: { gun: 60, mine: 30, ice: 0, bazooka: 0 } },
    });
    expect(decodeClientMessage(raw({ ...ok, weights: { gun: 70, mine: 40 } }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, weights: { gun: 0 } }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, weights: { gun: 2.5 } }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, weights: { gun: -1, mine: 50 } }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, weights: { nuke: 10 } }))).toBeNull();
    // An older loot list keeps the standard shares of the listed items.
    expect(decodeClientMessage(raw({ ...ok, loot: ['teleport', 'gun'] }))).toMatchObject({
      settings: { weights: { gun: 13, teleport: 12, mine: 0 } },
    });
    expect(decodeClientMessage(raw({ ...ok, loot: [] }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, roles: false }))).toMatchObject({ settings: { roles: false } });
    expect(decodeClientMessage(raw({ ...ok, roles: 'no' }))).toBeNull();
    // Arenas: missing = all, a list is sorted and de-duplicated, empty or unknown is refused.
    expect(decodeClientMessage(raw(ok))).toMatchObject({
      settings: { arenas: ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'] },
    });
    expect(decodeClientMessage(raw({ ...ok, arenas: ['wind', 'ice', 'ice'] }))).toMatchObject({
      settings: { arenas: ['ice', 'wind'] },
    });
    expect(decodeClientMessage(raw({ ...ok, arenas: [] }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, arenas: ['moon'] }))).toBeNull();
    expect(decodeClientMessage(JSON.stringify({ t: 'kick', id: 'x' }))).toEqual({ t: 'kick', id: 'x' });
    expect(decodeClientMessage(JSON.stringify({ t: 'kick', id: 5 }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, loot: ['nuke'] }))).toBeNull();
  });
  it('girdi baytı 0..63 aralığında', () => {
    expect(decodeClientMessage('{"t":"in","s":5,"b":17}')).toEqual({ t: 'in', s: 5, b: 17 });
    expect(decodeClientMessage('{"t":"in","s":5,"b":64}')).toBeNull();
  });
  it('girdi aktarımı çözülür, bozuk olanı atılır', () => {
    expect(decodeServerMessage('{"t":"ri","id":"abc","k":120,"b":24}')).toEqual({
      t: 'ri',
      id: 'abc',
      k: 120,
      b: 24,
    });
    expect(decodeServerMessage('{"t":"ri","id":"abc","k":120,"b":64}')).toBeNull();
    expect(decodeServerMessage('{"t":"ri","id":"abc","k":-1,"b":1}')).toBeNull();
  });
  it('snapshot ganimet rastgeleliğini taşımaz (yalnızca sunucuda)', async () => {
    const { createGame } = await import('@crateball/sim');
    const { encodeGame } = await import('../src/index');
    const g = createGame(1);
    g.lootRng = 123456;
    const json = encodeGame(g);
    expect((JSON.parse(json) as { lootRng: unknown }).lootRng).toBeNull();
    expect(json).not.toContain('123456');
    expect(g.lootRng).toBe(123456); // the server's own state is untouched
  });
});

describe('binary snapshot', () => {
  /** A bot match in progress: crates, items, bullets, weather all turn up within a few thousand ticks. */
  const match = async (seed: number) => {
    const sim = await import('@crateball/sim');
    const g = sim.createGame(seed, { ...sim.DEFAULT_SETTINGS, crates: 'chaos' });
    for (let i = 0; i < 3; i++) {
      sim.addPlayer(g, `r${i}`, `Kırmızı ${i}`, 'red', true);
      sim.addPlayer(g, `b${i}`, `Mavi ${i}`, 'blue', true);
    }
    sim.newArenaPlan(g);
    sim.restartMatch(g);
    return { g, step: () => sim.step(g) };
  };
  const head = { tick: 4, ack: 9, q: 2, lead: 3, h: { p1: 8, p2: 0 } };
  const asClient = (g: Game) => JSON.parse(encodeGame(g)) as unknown;

  it('key frame tam olarak eski JSON snapshotun verdiği durumu verir', async () => {
    const { g, step } = await match(1);
    for (let i = 0; i < 500; i++) step();
    g.lootRng = 987654;
    const dec = createSnapDecoder();
    const m = decodeServerData(encodeFrame(SNAP_KEY, head, 0, keyBody(snapState(g))), dec);
    expect(m?.t).toBe('snap');
    if (m?.t !== 'snap') return;
    // Same values and the same key order as JSON.parse gave (prediction starts from identical states).
    expect(JSON.stringify(m.g)).toBe(JSON.stringify(asClient(g)));
    expect(m.g.lootRng).toBeNull();
    expect([m.tick, m.ack, m.q, m.lead]).toEqual([4, 9, 2, 3]);
    expect(m.h).toEqual({ p1: 8, p2: 0 });
  });

  it('delta zinciri her snapshotta eski JSON ile birebir aynı durumu kurar ve çok daha küçük', async () => {
    for (const seed of [2, 3]) {
      const { g, step } = await match(seed);
      const dec = createSnapDecoder();
      let prev: { state: Plain; tick: number } | null = null;
      let json = 0;
      let bin = 0;
      for (let i = 0; i < 4000; i++) {
        step();
        if (g.tick % 2 !== 0) continue;
        const state = snapState(g);
        const frame = prev
          ? encodeFrame(SNAP_DELTA, { ...head, tick: g.tick }, prev.tick, deltaBody(prev.state, state))
          : encodeFrame(SNAP_KEY, { ...head, tick: g.tick }, 0, keyBody(state));
        prev = { state, tick: g.tick };
        const m = decodeServerData(frame, dec);
        expect(m?.t).toBe('snap');
        if (m?.t !== 'snap') return;
        expect(JSON.stringify(m.g)).toBe(JSON.stringify(asClient(g)));
        json += encodeGame(g).length + 60;
        bin += frame.length;
      }
      expect(bin * 4).toBeLessThan(json);
    }
  });

  it('elindeki durumla eşleşmeyen delta uygulanmaz; bozuk frame çözücüyü sıfırlar', async () => {
    const { g, step } = await match(4);
    const dec = createSnapDecoder();
    const a = snapState(g);
    decodeServerData(encodeFrame(SNAP_KEY, { ...head, tick: 10 }, 0, keyBody(a)), dec);
    step();
    const b = snapState(g);
    // A delta from tick 8, but this client holds tick 10: not applied, nothing changed.
    expect(decodeServerData(encodeFrame(SNAP_DELTA, head, 8, deltaBody(a, b)), dec)).toBeNull();
    expect(dec.tick).toBe(10);
    expect(decodeServerData(new Uint8Array([2, 1, 2]), dec)).toBeNull();
    expect(dec.state).toBeNull();
    expect(decodeServerData(new Uint8Array([7, 0, 0]), createSnapDecoder())).toBeNull();
  });

  it('sayılar, metinler, alan ekleme/silme, dizi büyüme/küçülme, tür değişimi', () => {
    const cases: Array<[Plain, Plain]> = [
      [
        { a: 1, b: [1, 2, 3], c: { d: 'x' } },
        { a: 1.5, b: [1], c: null, e: 'ğüşİöç 🎉' },
      ],
      [{ n: 0.001 }, { n: -123456.789 }],
      [{ n: 5 }, { n: 4_000_000_000 }],
      [{ n: 1e12 }, { n: 2e15 + 0.5 }],
      [[], [{ id: 1, rocket: true }, { id: 2 }]],
      [{ list: [{ x: 1 }, { x: 2 }] }, { list: [{ x: 1, target: 'p' }, { x: 3 }] }],
      [{ k: true }, { k: false }],
      [{ k: 'a' }, { k: 1 }],
      // Same keys in another order, a new key in the middle: sent whole, so the order matches too.
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [
        { a: 1, c: 3 },
        { a: 1, b: 2, c: 3 },
      ],
    ];
    for (const [a, b] of cases) {
      const dec = createSnapDecoder();
      const f1 = encodeFrame(SNAP_KEY, head, 0, keyBody(a));
      const f2 = encodeFrame(SNAP_DELTA, { ...head, tick: 5 }, 4, deltaBody(a, b));
      expect(decodeFrame(f1, dec)?.state).toEqual(a);
      const got = decodeFrame(f2, dec)?.state;
      expect(got).toEqual(b);
      expect(JSON.stringify(got)).toBe(JSON.stringify(b));
    }
    // As JSON did: -0 is 0, non-finite is null, undefined fields are left out.
    expect(snapState({ x: -0, y: NaN, z: Infinity, u: undefined } as unknown as Game)).toEqual({
      x: 0,
      y: null,
      z: null,
      lootRng: null,
    });
  });

  it('tutulan girdiler ve saat geri bildirimi doğrulanır; prototipe dokunulmaz', () => {
    const frame = (h: Record<string, number>, lead: number) =>
      decodeServerData(
        encodeFrame(SNAP_KEY, { ...head, h, lead }, 0, keyBody(asGameLike())),
        createSnapDecoder(),
      );
    const m = frame(JSON.parse('{"__proto__":5,"d":2,"e":64}') as Record<string, number>, 500);
    expect(m?.t === 'snap' && m.lead).toBe(0);
    const h = m?.t === 'snap' ? m.h : {};
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype);
    expect(h.d).toBe(2);
    expect(h.e).toBeUndefined(); // not an input byte
  });
});

/** The smallest state that passes as a game. */
const asGameLike = (): Plain => ({
  tick: 1,
  players: [],
  ball: {},
  crates: [],
  bullets: [],
  blasts: [],
  score: [0, 0],
});

describe('telemetri', () => {
  const ok = {
    fps: 59.8,
    frameMsMax: 21,
    longFrames: 0,
    rtt: 92,
    pending: 7,
    serverQueue: 0.4,
    corrections: 3,
    myCorrectionPx: 4.2,
    myCorrectionMaxPx: 1.9,
    ballCorrectionMaxPx: 12.5,
    othersCorrectionMaxPx: 7,
    simMsMax: 0.8,
    drawMsMax: 4.1,
    snapMsMax: 1.2,
  };
  it('istatistik penceresini kabul eder, bilinmeyen alanı atar', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'stats', s: { ...ok, evil: 1 } }))).toEqual({
      t: 'stats',
      s: ok,
    });
  });
  it('eksik ya da saçma sayıyı reddeder', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'stats', s: { ...ok, rtt: -1 } }))).toBeNull();
    expect(decodeClientMessage(JSON.stringify({ t: 'stats', s: { fps: 60 } }))).toBeNull();
  });
  it('F9 raporu en fazla 10 pencere taşır', () => {
    expect(decodeClientMessage(JSON.stringify({ t: 'report', note: 'zıpladı', recent: [ok] }))).toEqual({
      t: 'report',
      note: 'zıpladı',
      recent: [ok],
    });
    expect(
      decodeClientMessage(JSON.stringify({ t: 'report', note: '', recent: Array(11).fill(ok) })),
    ).toBeNull();
  });
});
