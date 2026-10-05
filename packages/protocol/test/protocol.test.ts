import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeServerMessage,
  encode,
} from '../src/index';
import { defaultWeights } from '@crateball/sim';

describe('istemci mesajları', () => {
  it('varsayılan kutu payları sim ile aynı', () => {
    expect(DEFAULT_WEIGHTS).toEqual(defaultWeights());
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
        arenas: ['classic', 'rain', 'volcano', 'ice', 'wind'],
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
      settings: { weights: { gun: 18, teleport: 6, mine: 0 } },
    });
    expect(decodeClientMessage(raw({ ...ok, loot: [] }))).toBeNull();
    expect(decodeClientMessage(raw({ ...ok, roles: false }))).toMatchObject({ settings: { roles: false } });
    expect(decodeClientMessage(raw({ ...ok, roles: 'no' }))).toBeNull();
    // Arenas: missing = all, a list is sorted and de-duplicated, empty or unknown is refused.
    expect(decodeClientMessage(raw(ok))).toMatchObject({
      settings: { arenas: ['classic', 'rain', 'volcano', 'ice', 'wind'] },
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
  it('snap sarmalayıcısı çözülür', async () => {
    const { createGame } = await import('@crateball/sim');
    const { encodeGame, encodeSnap } = await import('../src/index');
    const g = createGame(1);
    g.ball.x = 1 / 3;
    const m = decodeServerMessage(encodeSnap(4, 9, 2, encodeGame(g)));
    expect(m?.t === 'snap' && m.ack === 9 && m.g.ball.x).toBe(0.333);
  });
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
