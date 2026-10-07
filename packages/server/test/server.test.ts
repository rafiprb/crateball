import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ServerMessage,
} from '@crateball/protocol';
import { defaultWeights, type Settings } from '@crateball/sim';
import { createLogger, loadConfig, startServer, type RunningServer, type ServerConfig } from '../src/app';

const silent = new Writable({ write: (_c, _e, cb) => cb() });
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

async function boot(over: Partial<ServerConfig> = {}, helloTimeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'gg-'));
  const cfg: ServerConfig = {
    port: 0,
    mode: 'development',
    staticDir: null,
    logFile: join(dir, 'dev.log'),
    version: 'test',
    ...over,
  };
  running = await startServer(cfg, createLogger(cfg, { stdout: silent }), { helloTimeoutMs });
  return { cfg, dir, base: `http://127.0.0.1:${running.port}`, wsUrl: `ws://127.0.0.1:${running.port}/ws` };
}

function client(url: string) {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    const m = decodeServerMessage(data.toString());
    if (m) inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const next = async (): Promise<ServerMessage> => {
    while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
    return inbox.shift() as ServerMessage;
  };
  return { socket, opened, closed, next };
}

describe('loadConfig', () => {
  it('dev varsayılanları: port 3000, log dosyası depo kökünde', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('development');
    expect(cfg.port).toBe(3000);
    expect(cfg.logFile?.endsWith(join('logs', 'dev.log'))).toBe(true);
    expect(cfg.staticDir).toBeNull();
  });
  it('prod varsayılanları: port 8080, log dosyası yok', () => {
    const cfg = loadConfig({ NODE_ENV: 'production' });
    expect(cfg.port).toBe(8080);
    expect(cfg.logFile).toBeNull();
  });
  it('geçersiz PORT hata verir', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('Geçersiz PORT');
  });
});

describe('HTTP', () => {
  it('/health sürüm ve modu döner', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: 'test',
      mode: 'development',
      rooms: 0,
      playing: 0,
      players: 0,
    });
  });
  it('/__log Türkçe kaydı log dosyasına yazar', async () => {
    const { base, cfg } = await boot();
    const msg = 'Şafak söktü — ğüşıöç İ';
    const res = await fetch(`${base}/__log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ level: 'warn', msg, clientId: 'c-abc', ts: 1 }]),
    });
    expect(res.status).toBe(204);
    const text = readFileSync(cfg.logFile as string, 'utf8');
    expect(text).toContain(msg);
    expect(text).toContain('"src":"client"');
  });
  it('/__log bozuk gövdeye 400 döner', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/__log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
  it('/__log prototip anahtarlı geçersiz seviyeye 400 döner', async () => {
    const { base } = await boot();
    for (const level of ['toString', '__proto__', 'constructor', 'trace']) {
      const res = await fetch(`${base}/__log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ level, msg: 'x', clientId: 'c', ts: 1 }]),
      });
      expect(res.status).toBe(400);
    }
  });
  it('/__log beş konsol seviyesinin hepsini (debug dahil) dosyaya yazar', async () => {
    const { base, cfg } = await boot();
    const levels = ['debug', 'log', 'info', 'warn', 'error'];
    const res = await fetch(`${base}/__log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(levels.map((level) => ({ level, msg: `seviye-${level}`, clientId: 'c', ts: 1 }))),
    });
    expect(res.status).toBe(204);
    const text = readFileSync(cfg.logFile as string, 'utf8');
    for (const level of levels) expect(text).toContain(`seviye-${level}`);
  });
  it('/__log 64 KB üstü gövdeye 413 döner', async () => {
    const { base } = await boot();
    const big = JSON.stringify([{ level: 'log', msg: 'x'.repeat(70_000), clientId: 'c', ts: 1 }]);
    const res = await fetch(`${base}/__log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(res.status).toBe(413);
  });
  it('/__log json olmayan content-type için 415 döner', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/__log`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '[]',
    });
    expect(res.status).toBe(415);
  });
  it('/__log yabancı Origin için 403, localhost Origin için 204 döner', async () => {
    const { base } = await boot();
    const send = (origin: string) =>
      fetch(`${base}/__log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: '[]',
      });
    expect((await send('https://evil.example')).status).toBe(403);
    expect((await send('http://localhost:5173')).status).toBe(204);
    expect((await send('http://127.0.0.1:5173')).status).toBe(204);
  });
  it('HEAD /health 200 döner', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
  it('prod modunda statik dosya servis eder, /__log yoktur', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'gg-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<title>Crateball</title>');
    const { base } = await boot({ mode: 'production', logFile: null, staticDir });
    expect(await (await fetch(`${base}/`)).text()).toContain('<title>Crateball</title>');
    expect(await (await fetch(`${base}/r/KXQT`)).text()).toContain('<title>Crateball</title>');
    expect((await fetch(`${base}/__log`, { method: 'POST', body: '[]' })).status).toBe(404);
  });
});

describe('startServer', () => {
  it('dolu port startServer çağrısını reddeder, yakalanmamış hata olmaz', async () => {
    const { cfg } = await boot();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const taken = { ...cfg, port: running?.port ?? 0 };
      await expect(startServer(taken, createLogger(taken, { stdout: silent }))).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('WebSocket', () => {
  it('doğru sürümle hello → welcome', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    c.socket.send(encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
    const m = await c.next();
    expect(m.t).toBe('welcome');
    if (m.t === 'welcome') expect(m.clientId).toHaveLength(12);
    c.socket.close();
  });
  it('yanlış sürüm → version_mismatch ve 4001 ile kapanış', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    c.socket.send(encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(await c.next()).toMatchObject({ t: 'error', code: 'version_mismatch' });
    expect(await c.closed).toBe(4001);
  });
  it('bozuk mesaj → bad_message, bağlantı açık kalır', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    c.socket.send('çöp {');
    expect(await c.next()).toMatchObject({ t: 'error', code: 'bad_message' });
    c.socket.send(encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
    expect((await c.next()).t).toBe('welcome');
    c.socket.send(encode({ t: 'ping', id: 7 }));
    expect(await c.next()).toMatchObject({ t: 'pong', id: 7 });
    c.socket.close();
  });
  it('hello öncesi ping → bad_message', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    c.socket.send(encode({ t: 'ping', id: 1 }));
    expect(await c.next()).toMatchObject({ t: 'error', code: 'bad_message', message: 'Send hello first' });
    c.socket.close();
  });
  it('64 KB üstü mesaj → 1009 ile kapanır, sunucu ayakta kalır', async () => {
    const { wsUrl, base } = await boot();
    const c = client(wsUrl);
    await c.opened;
    c.socket.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
    expect(await c.closed).toBe(1009);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
  it('hello gelmezse 4000 ile kapanır', async () => {
    const { wsUrl } = await boot({}, 50);
    const c = client(wsUrl);
    await c.opened;
    expect(await c.closed).toBe(4000);
  });
  it('log dosyası yoksa oluşturulur', async () => {
    const { cfg } = await boot();
    expect(existsSync(cfg.logFile as string)).toBe(true);
  });
  it('oda kur → kod, lobide bot; ikinci oyuncu kodla katılır; host başlatır, snap girdiyi onaylar', async () => {
    const { wsUrl, base } = await boot();
    const host = client(wsUrl);
    const guest = client(wsUrl);
    await Promise.all([host.opened, guest.opened]);
    for (const c of [host, guest]) {
      c.socket.send(encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
      await c.next();
    }
    const settings: Settings = {
      minutes: 2,
      scoreLimit: 3,
      crates: 'chaos',
      weights: defaultWeights(),
      roles: true,
      arenas: ['ice', 'wind'],
      bots: true,
    };
    host.socket.send(encode({ t: 'create', name: 'Ayşe', roomName: 'Pazar maçı', public: true, settings }));
    const until = async <T extends ServerMessage['t']>(c: ReturnType<typeof client>, t: T) => {
      for (;;) {
        const m = await c.next();
        if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
      }
    };
    const room = (await until(host, 'room')).room;
    const { code } = await until(host, 'joined');
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(room.players.map((p) => [p.name, p.team, p.bot])).toEqual([
      ['Ayşe', 'red', false],
      ['Bot 1', 'blue', true],
    ]);
    expect(await (await fetch(`${base}/rooms`)).json()).toEqual([
      { code, name: 'Pazar maçı', humans: 1, max: 6, full: false, state: 'lobby' },
    ]);

    guest.socket.send(encode({ t: 'join', code, name: 'Can' }));
    const after = (await until(guest, 'room')).room;
    expect(after.players.filter((p) => !p.bot).map((p) => [p.name, p.team])).toEqual([
      ['Ayşe', 'red'],
      ['Can', 'blue'],
    ]);
    const guestId = (await until(guest, 'joined')).playerId;
    const hostId = after.host;
    guest.socket.send(encode({ t: 'start' }));
    expect(await until(guest, 'error')).toMatchObject({ code: 'not_host' });
    host.socket.send(encode({ t: 'swap', a: hostId, b: guestId }));
    const swapped = (await until(guest, 'room')).room;
    expect(swapped.players.find((p) => p.id === guestId)?.team).toBe('red');

    host.socket.send(encode({ t: 'start' }));
    while ((await until(host, 'room')).room.state !== 'playing');
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ rooms: 1, playing: 1, players: 2 });
    for (let s = 1; s <= 5; s++) host.socket.send(encode({ t: 'in', s, b: 8 }));
    let snap = await until(host, 'snap');
    while (snap.ack < 5) snap = await until(host, 'snap');
    expect(snap.g.settings).toEqual(settings);
    // The arena order is drawn at the start, only from the host's pool.
    expect(snap.g.arenaPlan).toHaveLength(6);
    expect(new Set(snap.g.arenaPlan)).toEqual(new Set(['ice', 'wind']));
    guest.socket.send(encode({ t: 'join', code: 'ZZZZ', name: 'x' }));
    expect(await until(guest, 'error')).toMatchObject({ code: 'room_not_found' });
    host.socket.close();
    guest.socket.close();
  });
});

describe('girdi kuyruğu', () => {
  it('bekleme penceresi geçtikten sonra gelen geç girdi tuşları yeniden kilitlemez; kopunca tuş bırakılır', async () => {
    const { createRooms, STAND_IN_TICKS } = await import('../src/rooms');
    const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const room = rooms.create(
      'a',
      'A',
      'R',
      false,
      { minutes: 3, scoreLimit: 5, crates: 'off', weights: defaultWeights(), bots: false },
      () => {},
      'k',
    );
    if (typeof room === 'string') throw new Error(room);
    rooms.start('a');
    rooms.input('a', 1, 8);
    rooms.tickAll();
    for (let i = 0; i < STAND_IN_TICKS + 5; i++) rooms.tickAll();
    rooms.input('a', 2, 8); // a straggler from long ago
    for (let i = 0; i < 5; i++) rooms.tickAll();
    expect(room.game.players[0]?.input).toBe(0);
    // A drop: no stand-in keys after it.
    rooms.input('a', 100, 4);
    rooms.tickAll();
    rooms.disconnect('a');
    rooms.tickAll();
    expect(room.game.players[0]?.input).toBe(0);
    rooms.stop();
  });

  it('kısa bir ağ takılmasında (200 ms) tuşlar bırakılmış sayılmaz', async () => {
    const { createRooms } = await import('../src/rooms');
    const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const room = rooms.create(
      'a',
      'A',
      'R',
      false,
      { minutes: 3, scoreLimit: 5, crates: 'off', weights: defaultWeights(), bots: false },
      () => {},
    );
    if (typeof room === 'string') throw new Error(room);
    rooms.start('a');
    rooms.input('a', 1, 8);
    rooms.tickAll();
    for (let i = 0; i < 12; i++) rooms.tickAll(); // 200 ms without a word
    expect(room.game.players[0]?.input).toBe(8);
    rooms.stop();
  });

  it('kuyruk boşalınca son girdi o tick için yerine geçer ve sıra ilerler; geç gelen girdi son girdi olur', async () => {
    const { createRooms } = await import('../src/rooms');
    const log = createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent });
    const rooms = createRooms(log);
    const sent: string[] = [];
    const room = rooms.create(
      'a',
      'A',
      'R',
      false,
      { minutes: 3, scoreLimit: 5, crates: 'off', weights: defaultWeights(), bots: false },
      (r) => sent.push(r),
    );
    if (typeof room === 'string') throw new Error(room);
    rooms.start('a');
    const last = () =>
      JSON.parse(sent.filter((r) => r.startsWith('{"t":"snap"')).at(-1)!) as { ack: number; q: number };
    rooms.input('a', 1, 8);
    rooms.tickAll();
    rooms.tickAll(); // boş kuyruk: 8 yerine geçer, ack 2 sayılır
    expect(last().ack).toBe(2);
    rooms.input('a', 2, 4); // geç geldi
    rooms.input('a', 3, 4);
    rooms.input('a', 4, 4);
    rooms.tickAll();
    rooms.tickAll();
    expect(last()).toMatchObject({ ack: 4, q: 0 });
    expect(room.game.players[0]?.input).toBe(4);
    rooms.stop();
  });
});

describe('saat eşitleme (uyarlanır girdi tamponu)', () => {
  const settings: Settings = {
    minutes: 3,
    scoreLimit: 5,
    crates: 'off',
    weights: defaultWeights(),
    bots: false,
  };
  const setup = async () => {
    const { createRooms, LEAD_BLOCK, LEAD_TARGET } = await import('../src/rooms');
    const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const sent: Record<string, string[]> = { a: [], b: [] };
    const room = rooms.create('a', 'A', 'R', false, settings, (r) => sent.a!.push(r));
    if (typeof room === 'string') throw new Error(room);
    rooms.join(room.code, 'b', 'B', (r) => sent.b!.push(r));
    rooms.start('a');
    const lead = (id: 'a' | 'b') =>
      (JSON.parse(sent[id]!.filter((r) => r.startsWith('{"t":"snap"')).at(-1)!) as { lead: number }).lead;
    return { rooms, room, sent, lead, LEAD_BLOCK, LEAD_TARGET };
  };

  it('hep fazladan girdisi bekleyen istemciye fazlası bildirilir; tam zamanında gelene 0', async () => {
    const { rooms, lead, LEAD_BLOCK, LEAD_TARGET } = await setup();
    // a: 6 inputs ahead all the time (as after a long Wi-Fi stall). b: each input just in time.
    for (let s = 1; s <= 6; s++) rooms.input('a', s, 8);
    for (let t = 1; t <= LEAD_BLOCK * 4; t++) {
      rooms.input('a', t + 6, 8);
      rooms.input('b', t, 4);
      rooms.tickAll();
    }
    expect(lead('a')).toBe(6 - LEAD_TARGET);
    expect(lead('b')).toBe(0);
    rooms.stop();
  });

  it('pencerede bir kez bile dibe vuran (seğiren) istemcinin tamponu küçültülmez', async () => {
    const { rooms, lead, LEAD_BLOCK } = await setup();
    let s = 0;
    for (let i = 0; i < 3; i++) rooms.input('a', ++s, 8);
    for (let t = 1; t <= LEAD_BLOCK * 4; t++) {
      // Clumps of four every fourth tick: 3, 2, 1, 0 left waiting, again and again.
      if (t % 4 === 0) for (let i = 0; i < 4; i++) rooms.input('a', ++s, 8);
      rooms.tickAll();
    }
    expect(lead('a')).toBe(0);
    rooms.stop();
  });

  it('maç yeniden başlayınca ölçüm sıfırlanır', async () => {
    const { rooms, room, lead, LEAD_BLOCK } = await setup();
    for (let s = 1; s <= 6; s++) rooms.input('a', s, 8);
    for (let t = 1; t <= LEAD_BLOCK * 4; t++) {
      rooms.input('a', t + 6, 8);
      rooms.tickAll();
    }
    expect(lead('a')).toBeGreaterThan(0);
    room.state = 'lobby';
    rooms.start('a');
    expect(lead('a')).toBe(0);
    rooms.stop();
  });
});

describe('girdi aktarımı', () => {
  const settings: Settings = {
    minutes: 3,
    scoreLimit: 5,
    crates: 'off',
    weights: defaultWeights(),
    bots: false,
  };
  type Relay = { t: 'ri'; id: string; k: number; b: number };
  const setup = async () => {
    const { createRooms } = await import('../src/rooms');
    const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const sent: Record<string, string[]> = { a: [], b: [] };
    const room = rooms.create('a', 'A', 'R', false, settings, (r) => sent.a!.push(r));
    if (typeof room === 'string') throw new Error(room);
    rooms.join(room.code, 'b', 'B', (r) => sent.b!.push(r));
    rooms.start('a');
    const relays = (id: 'a' | 'b') =>
      sent[id]!.filter((r) => r.startsWith('{"t":"ri"')).map((r) => JSON.parse(r) as Relay);
    return { rooms, room, relays };
  };

  it('tuş değişikliği gelir gelmez diğerlerine, uygulanacağı tick ile gider; aynı tuş tekrar gitmez', async () => {
    const { rooms, room, relays } = await setup();
    rooms.input('b', 1, 8);
    expect(relays('a')).toEqual([{ t: 'ri', id: 'b', k: room.game.tick, b: 8 }]);
    expect(relays('b')).toEqual([]); // not to the sender
    rooms.input('b', 2, 8); // same keys: nothing new
    rooms.input('b', 3, 4); // third in the queue: applied two steps later
    const k = room.game.tick + 2;
    expect(relays('a').at(-1)).toEqual({ t: 'ri', id: 'b', k, b: 4 });
    expect(relays('a')).toHaveLength(2);
    // The relayed tick is the one the server really applies it in: the step from tick k.
    const p = room.game.players.find((o) => o.id === 'b')!;
    while (room.game.tick < k) rooms.tickAll();
    expect(p.input).toBe(8);
    rooms.tickAll();
    expect(p.input).toBe(4);
    rooms.stop();
  });

  it('geç gelen girdi yerine geçecekse bir sonraki tick ile aktarılır', async () => {
    const { rooms, room, relays } = await setup();
    rooms.input('b', 1, 8);
    rooms.tickAll();
    rooms.tickAll(); // b starved: stand-in, its ack counts on
    rooms.input('b', 2, 1); // late: stands in from the next tick
    expect(relays('a').at(-1)).toEqual({ t: 'ri', id: 'b', k: room.game.tick, b: 1 });
    rooms.tickAll();
    expect(room.game.players.find((o) => o.id === 'b')!.input).toBe(1);
    rooms.stop();
  });
});

describe('girdi aktarımı: inceleme düzeltmeleri', () => {
  const settings: Settings = {
    minutes: 3,
    scoreLimit: 5,
    crates: 'off',
    weights: defaultWeights(),
    bots: false,
  };
  type Relay = { t: 'ri'; id: string; k: number; b: number };
  const setup = async () => {
    const mod = await import('../src/rooms');
    const rooms = mod.createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const sent: Record<string, string[]> = { a: [], b: [], c: [] };
    const sendTo = (id: string) => (r: string) => sent[id]!.push(r);
    const room = rooms.create('a', 'A', 'R', false, settings, sendTo('a'));
    if (typeof room === 'string') throw new Error(room);
    rooms.join(room.code, 'b', 'B', sendTo('b'));
    rooms.start('a');
    const relays = (to: string) =>
      sent[to]!.filter((r) => r.startsWith('{"t":"ri"')).map((r) => JSON.parse(r) as Relay);
    /** What a receiver believes `id` plays in the step from tick t (it keeps changes the same way). */
    const believed = (to: string, id: string, t: number) => {
      const s: Array<[number, number]> = [];
      for (const r of relays(to))
        if (r.id === id) {
          while (s.length > 0 && s.at(-1)![0] >= r.k) s.pop();
          s.push([r.k, r.b]);
        }
      let b: number | undefined;
      for (const [k, v] of s) if (k <= t) b = v;
      return b;
    };
    const member = (id: string) => room.members.get(id)!;
    /** Ticks and checks after each: the receiver was told what was really applied (no later than the
     * step itself), and what it was told about the queued ticks matches the queue. */
    const tickChecked = (n: number, to = 'a', id = 'b') => {
      for (let i = 0; i < n; i++) {
        const t = room.game.tick;
        rooms.tickAll();
        expect(believed(to, id, t)).toBe(member(id).last);
        if (!member(id).relayDirty)
          member(id).queue.forEach(([, bits], j) => expect(believed(to, id, room.game.tick + j)).toBe(bits));
      }
    };
    return { ...mod, rooms, room, sent, sendTo, relays, believed, member, tickChecked };
  };

  it('kuyruk tick başında kırpılınca ileriye duyurulmuş tuşlar iptal edilir (hayalet vuruş yok)', async () => {
    const { rooms, tickChecked, believed, room } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(1);
    // A stall ends: 11 inputs at once, keys changing among them (16 = kick).
    const bits = [1, 1, 2, 2, 4, 4, 16, 16, 8, 8, 1];
    bits.forEach((b, i) => rooms.input('b', 2 + i, b));
    const kickAt = room.game.tick + 6; // announced: the kick in the step from here
    tickChecked(1); // > 10 waiting: trimmed to the last 4, they now land on the next ticks
    expect(believed('a', 'b', kickAt)).not.toBe(16);
    for (let s = 13; s < 30; s++) {
      rooms.input('b', s, s % 3 === 0 ? 2 : 4);
      tickChecked(1);
    }
    rooms.stop();
  });

  it('gelirken kırpılan sel kuyruğu da (21+) yeniden duyurulur', async () => {
    const { rooms, tickChecked } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(1);
    for (let s = 2; s < 30; s++) rooms.input('b', s, Math.floor(s / 5) % 2 ? 1 : 16);
    tickChecked(15);
    rooms.stop();
  });

  it('kopma ve yeniden bağlanmada kuyruktaki duyurulmuş tuşlar geçersiz olur', async () => {
    const { rooms, room, tickChecked, believed, sendTo } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(1);
    for (let s = 2; s < 8; s++) rooms.input('b', s, s < 5 ? 8 : 16);
    rooms.disconnect('b');
    tickChecked(1);
    expect(believed('a', 'b', room.game.tick + 5)).toBe(0); // the queued kick is void, keys released
    tickChecked(5);
    rooms.reattach('b', sendTo('b'));
    for (let s = 1; s < 10; s++) {
      rooms.input('b', s, s < 5 ? 4 : 1);
      tickChecked(1);
    }
    rooms.stop();
  });

  it('uzun sessizlikte tuş bırakılınca bu da aktarılır; aynı tuşa dönüş yeniden gider', async () => {
    const { rooms, room, tickChecked, relays, STAND_IN_TICKS } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(1);
    tickChecked(STAND_IN_TICKS + 5); // silent: stand-ins, then released
    expect(relays('a').at(-1)).toMatchObject({ id: 'b', b: 0 });
    const ack = room.members.get('b')!.ack;
    rooms.input('b', ack + 1, 8); // the same key as before the silence
    expect(relays('a').at(-1)).toMatchObject({ id: 'b', b: 8 });
    tickChecked(3);
    rooms.stop();
  });

  it('bütçe bitmişken kırpılan kuyruğun ileriye duyurulmuş tuşları yine iptal edilir', async () => {
    const { rooms, room, tickChecked, believed, member } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(1);
    // Every input a different key: the budget runs out on the way, then the queue is trimmed.
    for (let s = 2; s < 14; s++) rooms.input('b', s, s % 2 ? 1 : 16);
    member('b').relayTokens = 0;
    const t = room.game.tick;
    rooms.tickAll();
    expect(believed('a', 'b', t)).toBe(member('b').last);
    for (let j = 1; j < 12; j++) expect([member('b').last, undefined]).toContain(believed('a', 'b', t + j));
    rooms.stop();
  });

  it('eski sıra numarasıyla tuş seli tek düzeltme sayılır; aktarım oyuncu başına bütçeli', async () => {
    const { rooms, relays, member, tickChecked, RELAY_BURST, RELAY_PER_SEC } = await setup();
    rooms.input('b', 1, 8);
    tickChecked(2); // the second tick stands in: ack 2, queue empty
    const before = relays('a').length;
    for (let i = 0; i < 720; i++) rooms.input('b', 2, i % 2 ? 1 : 2);
    expect(member('b').last).toBe(2); // the first one counted, the 719 repeats did not
    expect(relays('a').length - before).toBeLessThanOrEqual(1);
    // New sequence numbers with alternating keys: only the budget is relayed.
    const start = relays('a').length;
    for (let i = 0; i < 720; i++) rooms.input('b', 3 + i, i % 2 ? 1 : 2);
    expect(relays('a').length - start).toBeLessThanOrEqual(RELAY_BURST);
    for (let i = 0; i < 60; i++) rooms.tickAll();
    expect(relays('a').length - start).toBeLessThanOrEqual(RELAY_BURST + RELAY_PER_SEC + 1);
    // Once the flood stops and the budget refills, the schedule is right again.
    for (let i = 0; i < 120; i++) rooms.tickAll();
    for (let s = 0; s < 10; s++) {
      rooms.input('b', member('b').ack + 1, 4);
      tickChecked(1);
    }
    rooms.stop();
  });

  it('maç ortasında gelen izleyici herkesin tuşlarını öğrenir; kendi girdisi aktarılmaz', async () => {
    const { rooms, room, sendTo, relays, believed, tickChecked } = await setup();
    rooms.input('a', 1, 4);
    rooms.input('b', 1, 8);
    tickChecked(1);
    rooms.join(room.code, 'c', 'C', sendTo('c'));
    expect(room.members.get('c')!.spectator).toBe(true);
    rooms.input('c', 1, 16);
    rooms.input('a', 2, 4);
    rooms.input('b', 2, 8);
    tickChecked(1, 'c');
    expect(believed('c', 'a', room.game.tick - 1)).toBe(4);
    expect(relays('a').some((r) => r.id === 'c')).toBe(false);
    expect(relays('b').some((r) => r.id === 'c')).toBe(false);
    rooms.stop();
  });

  it('maç ortasında çıkan oyuncunun aktarımı biter, oda akmaya devam eder', async () => {
    const { rooms, room, relays } = await setup();
    rooms.input('b', 1, 8);
    rooms.tickAll();
    rooms.leave('b');
    const n = relays('a').length;
    for (let i = 0; i < 30; i++) rooms.tickAll();
    expect(relays('a').length).toBe(n);
    expect(room.game.players.some((p) => p.id === 'b')).toBe(false);
    rooms.stop();
  });
});

describe('saat eşitleme: bayat geri bildirim', () => {
  const settings: Settings = {
    minutes: 3,
    scoreLimit: 5,
    crates: 'off',
    weights: defaultWeights(),
    bots: false,
  };
  const ahead = async () => {
    const { createRooms, LEAD_BLOCK } = await import('../src/rooms');
    const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
    const sent: string[] = [];
    const room = rooms.create('a', 'A', 'R', false, settings, (r) => sent.push(r));
    if (typeof room === 'string') throw new Error(room);
    rooms.start('a');
    const lead = () =>
      (JSON.parse(sent.filter((r) => r.startsWith('{"t":"snap"')).at(-1)!) as { lead: number }).lead;
    let s = 0;
    for (let i = 0; i < 6; i++) rooms.input('a', ++s, 8);
    for (let t = 0; t < LEAD_BLOCK * 4; t++) {
      rooms.input('a', ++s, 8);
      rooms.tickAll();
    }
    expect(lead()).toBe(5);
    return { rooms, room, lead };
  };

  it('sekme askıya alınınca (uzun sessizlik) fazlalık bildirimi sıfırlanır', async () => {
    const { rooms, room, lead } = await ahead();
    for (let i = 0; i < 120; i++) rooms.tickAll();
    expect(lead()).toBe(0);
    expect(room.members.get('a')!.lead).toBe(0);
    rooms.stop();
  });

  it('gönderim yönü takılıp kuyruk boşalınca bildirilen fazlalık bekleyen girdiyi aşmaz', async () => {
    const { rooms, room, lead } = await ahead();
    for (let i = 0; i < 8; i++) rooms.tickAll(); // uplink stalled: the 6 spare inputs run out
    expect(room.members.get('a')!.queue.length).toBe(0);
    expect(lead()).toBe(0);
    rooms.stop();
  });
});

describe('inceleme düzeltmeleri (sunucu)', () => {
  const settings: Settings = {
    minutes: 3,
    scoreLimit: 5,
    crates: 'off',
    weights: defaultWeights(),
    bots: true,
  };
  const make = async () => {
    const { createRooms } = await import('../src/rooms');
    return createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }));
  };
  const asRoom = <T>(r: T | string): T => {
    if (typeof r === 'string') throw new Error(r);
    return r;
  };

  it('yanlış kodla katılma denemesi mevcut odadan atmaz (#7)', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', () => {}));
    expect(rooms.join('ZZZZ', 'a', 'A', () => {})).toBe('room_not_found');
    expect(room.members.has('a')).toBe(true);
    expect(room.host).toBe('a');
    rooms.stop();
  });

  it('maç sırasında kimse takım değiştiremez; takas da yok (#8)', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', () => {}));
    rooms.start('a');
    expect(rooms.swap('a', 'a', 'b')).toBe('bad_message');
    expect(rooms.move('a', 'b', 'red')).toBe('bad_message');
    const teamOf = (id: string) => room.game.players.find((p) => p.id === id)?.team;
    const before = teamOf('b');
    expect(rooms.move('b', 'b', before === 'red' ? 'blue' : 'red')).toBe('bad_message');
    expect(rooms.move('b', 'b', 'spec')).toBe('bad_message');
    expect(teamOf('b')).toBe(before);
    rooms.stop();
  });

  it('maç başlayınca mevkiler kilitlenir', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    const me = () => room.game.players.find((p) => p.id === 'a')!;
    rooms.setRole('a', 'fwd');
    expect(me().role).toBe('fwd');
    rooms.start('a');
    rooms.setRole('a', 'gk');
    expect(me().role).toBe('fwd');
    rooms.stop();
  });

  it('maç sırasında gelen izleyici olur; lobide takıma geçer, izleyiciye döner', async () => {
    const { info } = await import('../src/rooms');
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    rooms.start('a');
    asRoom(rooms.join(room.code, 'c', 'C', () => {}));
    expect(room.game.players.some((p) => p.id === 'c')).toBe(false);
    expect(info(room).spectators).toEqual([{ id: 'c', name: 'C' }]);
    expect(rooms.stopMatch('c')).toBe('not_host');
    expect(rooms.stopMatch('a')).toBeNull();
    expect(room.state).toBe('lobby');
    expect(rooms.move('c', 'c', 'blue')).toBeNull();
    expect(room.game.players.find((p) => p.id === 'c')?.team).toBe('blue');
    expect(info(room).spectators).toEqual([]);
    expect(rooms.move('a', 'c', 'spec')).toBeNull();
    expect(room.game.players.some((p) => p.id === 'c')).toBe(false);
    expect(room.members.has('c')).toBe(true);
    rooms.stop();
  });

  it('sohbet herkese gider, geçmiş yeni gelene gösterilir, flood sınırlı', async () => {
    const rooms = await make();
    const got: string[] = [];
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, (raw) => got.push(raw)));
    expect(rooms.chat('a', 'merhaba')).toBeNull();
    expect(got.some((r) => r.includes('"t":"chat"') && r.includes('merhaba'))).toBe(true);
    const late: string[] = [];
    asRoom(rooms.join(room.code, 'b', 'B', (raw) => late.push(raw)));
    expect(late.some((r) => r.includes('merhaba'))).toBe(true);
    const results = Array.from({ length: 10 }, () => rooms.chat('a', 'spam'));
    expect(results).toContain('rate_limited');
    rooms.stop();
  });

  it('bir adres en fazla 5 oda tutar; bot takası botları dengeler, bot adları küçük kalır', async () => {
    const rooms = await make();
    for (const id of ['a', 'b', 'c', 'g', 'h'])
      asRoom(rooms.create(id, id, 'R', false, settings, () => {}, id, 'ip1'));
    expect(rooms.create('d', 'd', 'R', false, settings, () => {}, 'd', 'ip1')).toBe('rate_limited');
    expect(typeof rooms.create('e', 'e', 'R', false, settings, () => {}, 'e', 'ip2')).not.toBe('string');
    // a's room: a (red) vs a bot. b joins red -> two bots on blue; host swaps b with a blue bot.
    const room = rooms.rooms.get(rooms.whereIs('a').room!)!;
    asRoom(rooms.join(room.code, 'f', 'F', () => {}));
    const teams = () => ({
      red: room.game.players.filter((p) => p.team === 'red').length,
      blue: room.game.players.filter((p) => p.team === 'blue').length,
    });
    for (let i = 0; i < 6; i++) rooms.move('f', 'f', i % 2 ? 'red' : 'blue');
    expect(room.game.players.filter((p) => p.bot).every((p) => /^Bot [1-3]$/.test(p.name))).toBe(true);
    const fTeam = room.game.players.find((p) => p.id === 'f')!.team;
    const bot = room.game.players.find((p) => p.bot && p.team !== fTeam)!;
    rooms.move('a', 'a', fTeam);
    expect(rooms.swap('a', 'a', bot.id)).toBeNull();
    expect(teams().red).toBe(teams().blue);
    rooms.stop();
  });

  it('host takası ve takım değişimi bir takımda aynı gerçek mevkiyi iki insana vermez', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    for (const id of ['b', 'c', 'd']) asRoom(rooms.join(room.code, id, id.toUpperCase(), () => {}));
    const ok = () => {
      for (const team of ['red', 'blue'] as const) {
        const roles = room.game.players
          .filter((p) => p.team === team && p.role !== 'none')
          .map((p) => p.role);
        expect(new Set(roles).size).toBe(roles.length);
      }
    };
    const humans = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 12; i++) {
      const x = humans[i % 4]!;
      const y = humans[(i * 3 + 1) % 4]!;
      if (x !== y) rooms.swap('a', x, y);
      ok();
      rooms.move('a', humans[(i + 2) % 4]!, i % 2 ? 'red' : 'blue');
      ok();
    }
    rooms.stop();
  });

  it('oyuncusuz maç başlamaz; son oyuncu maçta çıkarsa lobiye dönülür', async () => {
    const rooms = await make();
    const noBots = { ...settings, bots: false };
    const room = asRoom(rooms.create('a', 'A', 'R', false, noBots, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', () => {}));
    rooms.move('a', 'a', 'spec');
    rooms.move('a', 'b', 'spec');
    expect(rooms.start('a')).toBe('no_players');
    rooms.move('b', 'b', 'red');
    expect(rooms.start('a')).toBeNull();
    rooms.leave('b');
    expect(room.state).toBe('lobby');
    rooms.stop();
  });

  it('değişmeyen mevki herkese oda güncellemesi yollamaz (izleyici spamı)', async () => {
    const rooms = await make();
    const got: string[] = [];
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, (r) => got.push(r)));
    asRoom(rooms.join(room.code, 'c', 'C', () => {}));
    rooms.move('c', 'c', 'spec');
    const before = got.length;
    for (let i = 0; i < 5; i++) rooms.setRole('c', 'gk');
    const p = room.game.players.find((o) => o.id === 'a')!;
    rooms.setRole('a', p.role);
    expect(got.length).toBe(before);
    rooms.stop();
  });

  it('sohbet sınırı çıkıp girince sıfırlanmaz; geri dönen sekme geçmişi numarasıyla alır', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', () => {}, 'tab-b'));
    for (let i = 0; i < 5; i++) expect(rooms.chat('b', `m${i}`)).toBeNull();
    rooms.leave('b');
    asRoom(rooms.join(room.code, 'b2', 'B', () => {}, 'tab-b'));
    expect(rooms.chat('b2', 'again')).toBe('rate_limited');
    rooms.disconnect('b2');
    const replay: string[] = [];
    rooms.reattach('b2', (r) => replay.push(r));
    const lines = replay.filter((r) => r.includes('"t":"chat"')).map((r) => JSON.parse(r) as { n: number });
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5]);
    rooms.stop();
  });

  it('bağlıyken aynı odaya tekrar katılmak bir şey değiştirmez', async () => {
    const rooms = await make();
    const got: string[] = [];
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', (raw) => got.push(raw)));
    rooms.start('a');
    room.members.get('b')!.ack = 40;
    const before = got.length;
    expect(rooms.join(room.code, 'b', 'B', () => {})).toBe(room);
    expect(room.members.get('b')!.ack).toBe(40);
    expect(got.length).toBe(before + 1); // only the joiner hears about it
    rooms.stop();
  });

  it('host oyuncuyu odadan atar; atılan geri giremez, başkası atamaz, host kendini atamaz', async () => {
    const rooms = await make();
    const got: string[] = [];
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', (raw) => got.push(raw), 'tab-b'));
    asRoom(rooms.join(room.code, 'c', 'C', () => {}));
    expect(rooms.kick('b', 'c')).toBe('not_host');
    expect(rooms.kick('a', 'a')).toBe('bad_message');
    expect(rooms.kick('a', 'b')).toBeNull();
    expect(room.members.has('b')).toBe(false);
    expect(room.game.players.some((p) => p.id === 'b')).toBe(false);
    expect(got.some((raw) => raw.includes('"code":"kicked"'))).toBe(true);
    // Same tab after a reload: a new connection id, the same session key.
    expect(rooms.join(room.code, 'b2', 'B', () => {}, 'tab-b')).toBe('kicked');
    expect(rooms.kick('a', 'bot-1')).toBe('bad_message');
    rooms.stop();
  });

  it('kopan host yerini ve host’luğu korur, süre içinde dönerse devam eder (#6)', async () => {
    vi.useFakeTimers();
    try {
      const { RECONNECT_GRACE_MS } = await import('../src/rooms');
      const rooms = await make();
      const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
      asRoom(rooms.join(room.code, 'b', 'B', () => {}));
      rooms.disconnect('a');
      expect(rooms.isAway('a')).toBe(true);
      expect(room.host).toBe('a');
      vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1000);
      expect(rooms.reattach('a', () => {})).toBe(room);
      expect(rooms.isAway('a')).toBe(false);
      rooms.disconnect('a');
      vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);
      expect(room.members.has('a')).toBe(false);
      expect(room.host).toBe('b');
      rooms.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('bilerek çıkılan boş oda hemen silinir; oda sayısı sınırlı (#1)', async () => {
    const { MAX_ROOMS } = await import('../src/rooms');
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    rooms.leave('a');
    expect(rooms.rooms.has(room.code)).toBe(false);
    for (let i = 0; i < MAX_ROOMS; i++) asRoom(rooms.create(`p${i}`, 'P', 'R', false, settings, () => {}));
    expect(rooms.create('x', 'X', 'R', false, settings, () => {})).toBe('server_full');
    rooms.stop();
  });

  it('girdi kuyruğu gelirken de sınırlı (#2)', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    rooms.start('a');
    for (let s = 1; s <= 10_000; s++) rooms.input('a', s, 8);
    expect(room.members.get('a')!.queue.length).toBeLessThanOrEqual(20);
    rooms.stop();
  });
});

describe('WebSocket sınırları', () => {
  const hello = (c: ReturnType<typeof client>, sessionToken?: string) =>
    c.socket.send(
      encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION, ...(sessionToken ? { sessionToken } : {}) }),
    );

  it('mesaj yağmuru bağlantıyı 4008 ile kapatır (#2)', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    hello(c);
    for (let i = 0; i < 1000; i++) c.socket.send(encode({ t: 'ping', id: i }));
    expect(await c.closed).toBe(4008);
  });

  it('ağ takılmasından sonra toplu gelen birkaç saniyelik girdi bağlantıyı kesmez', async () => {
    const { wsUrl } = await boot();
    const c = client(wsUrl);
    await c.opened;
    hello(c);
    await c.next(); // welcome
    // ~8 s of normal traffic (60 inputs + a ping per second) arriving at once.
    for (let i = 0; i < 500; i++) c.socket.send(encode({ t: 'ping', id: i }));
    let last = -1;
    while (last < 499) {
      const m = await c.next();
      if (m.t === 'pong') last = m.id;
    }
    expect(c.socket.readyState).toBe(WebSocket.OPEN);
    c.socket.close();
  });

  it('aynı oturum anahtarıyla dönen host aynı kimlik ve host olarak devam eder (#6)', async () => {
    const { wsUrl } = await boot();
    const until = async <T extends ServerMessage['t']>(c: ReturnType<typeof client>, t: T) => {
      for (;;) {
        const m = await c.next();
        if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
      }
    };
    const a = client(wsUrl);
    await a.opened;
    hello(a, 'oturum-a');
    const first = await until(a, 'welcome');
    a.socket.send(
      encode({
        t: 'create',
        name: 'Host',
        roomName: 'R',
        public: false,
        settings: { minutes: 3, scoreLimit: 5, crates: 'off', weights: defaultWeights(), bots: true },
      }),
    );
    const { code } = await until(a, 'joined');
    a.socket.close();
    await a.closed;
    const b = client(wsUrl);
    await b.opened;
    hello(b, 'oturum-a');
    const again = await until(b, 'welcome');
    expect(again.clientId).toBe(first.clientId);
    b.socket.send(encode({ t: 'join', code, name: 'Host' }));
    expect((await until(b, 'joined')).playerId).toBe(first.clientId);
    b.socket.send(encode({ t: 'role', role: 'mid' }));
    const room = (await until(b, 'room')).room;
    expect(room.host).toBe(first.clientId);
    expect(room.players.filter((p) => !p.bot)).toHaveLength(1);
    b.socket.close();
  });

  it('aynı sekme hâlâ bağlı görünürken yeniden bağlanırsa yeri devralır, eski bağlantı 4011 ile kapanır', async () => {
    const { wsUrl } = await boot();
    const until = async <T extends ServerMessage['t']>(c: ReturnType<typeof client>, t: T) => {
      for (;;) {
        const m = await c.next();
        if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
      }
    };
    const a = client(wsUrl);
    await a.opened;
    hello(a, 'oturum-x');
    const first = await until(a, 'welcome');
    a.socket.send(
      encode({
        t: 'create',
        name: 'Host',
        roomName: 'R',
        public: false,
        settings: { minutes: 3, scoreLimit: 5, crates: 'off', weights: defaultWeights(), bots: true },
      }),
    );
    const { code } = await until(a, 'joined');
    // The old socket never closes (a sleeping laptop): the same token comes back on a new one.
    const b = client(wsUrl);
    await b.opened;
    hello(b, 'oturum-x');
    expect((await until(b, 'welcome')).clientId).toBe(first.clientId);
    expect(await a.closed).toBe(4011);
    b.socket.send(encode({ t: 'join', code, name: 'Host' }));
    const room = (await until(b, 'room')).room;
    expect(room.host).toBe(first.clientId);
    expect(room.players.filter((p) => !p.bot)).toHaveLength(1);
    b.socket.close();
  });

  it('adres başına bağlantı sınırını aşan bağlantı hiç dinlenmez', async () => {
    const { wsUrl } = await boot();
    const { LIMITS } = await import('../src/ws');
    const ok = Array.from({ length: LIMITS.connectionsPerIp }, () => client(wsUrl));
    await Promise.all(ok.map((c) => c.opened));
    const extra = client(wsUrl);
    await extra.opened.catch(() => {});
    hello(extra, 'fazla');
    expect(await extra.closed).toBe(4010);
    expect(extra.socket.readyState).toBe(WebSocket.CLOSED);
    for (const c of ok) c.socket.close();
  });
});

describe('uzun sessizlik', () => {
  it('sekme arka plandayken sayaç kısa süre sonra durur; dönen istemcinin girdileri geç sayılmaz', async () => {
    const { createRooms } = await import('../src/rooms');
    const log = createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent });
    const rooms = createRooms(log);
    const sent: string[] = [];
    const settings: Settings = {
      minutes: 3,
      scoreLimit: 5,
      crates: 'off',
      weights: defaultWeights(),
      bots: false,
    };
    const room = rooms.create('a', 'A', 'R', false, settings, (r) => sent.push(r));
    if (typeof room === 'string') throw new Error(room);
    rooms.start('a');
    const ack = () =>
      (JSON.parse(sent.filter((r) => r.startsWith('{"t":"snap"')).at(-1)!) as { ack: number }).ack;
    rooms.input('a', 1, 8);
    rooms.tickAll();
    for (let i = 0; i < 120; i++) rooms.tickAll(); // 2 s silence
    const { STAND_IN_TICKS } = await import('../src/rooms');
    expect(ack()).toBeLessThanOrEqual(1 + STAND_IN_TICKS);
    expect(room.game.players[0]?.input).toBe(0); // keys released
    // Waking up: its next inputs are ahead of the server count again, so they are queued and used.
    const next = ack() + 1;
    rooms.input('a', next, 4);
    rooms.tickAll();
    rooms.tickAll();
    expect(ack()).toBe(next);
    expect(room.game.players[0]?.input).toBe(4);
    rooms.stop();
  });
});
