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
import { ITEM_KINDS, type Settings } from '@crateball/sim';
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
    if (m.t === 'welcome') expect(m.clientId).toHaveLength(8);
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
      loot: [...ITEM_KINDS],
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
      { code, name: 'Pazar maçı', humans: 1, max: 6, state: 'lobby' },
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
    guest.socket.send(encode({ t: 'join', code: 'ZZZZ', name: 'x' }));
    expect(await until(guest, 'error')).toMatchObject({ code: 'room_not_found' });
    host.socket.close();
    guest.socket.close();
  });
});

describe('girdi kuyruğu', () => {
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
      { minutes: 3, scoreLimit: 5, crates: 'off', loot: [...ITEM_KINDS], bots: false },
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

describe('inceleme düzeltmeleri (sunucu)', () => {
  const settings: Settings = { minutes: 3, scoreLimit: 5, crates: 'off', loot: [...ITEM_KINDS], bots: true };
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

  it('host maç sırasında takas edemez ve başkasını taşıyamaz; herkes kendi takımını değiştirebilir (#8)', async () => {
    const rooms = await make();
    const room = asRoom(rooms.create('a', 'A', 'R', false, settings, () => {}));
    asRoom(rooms.join(room.code, 'b', 'B', () => {}));
    rooms.start('a');
    expect(rooms.swap('a', 'a', 'b')).toBe('bad_message');
    expect(rooms.move('a', 'b', 'red')).toBe('bad_message');
    const teamOf = (id: string) => room.game.players.find((p) => p.id === id)?.team;
    const before = teamOf('b');
    expect(rooms.move('b', 'b', before === 'red' ? 'blue' : 'red')).toBeNull();
    expect(teamOf('b')).not.toBe(before);
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
        settings: { minutes: 3, scoreLimit: 5, crates: 'off', loot: [...ITEM_KINDS], bots: true },
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
});
