import { mkdtempSync } from 'node:fs';
import { connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  createSnapDecoder,
  decodeServerData,
  encode,
  type ServerMessage,
} from '@crateball/protocol';
import { defaultWeights, type Settings } from '@crateball/sim';
import { createLogger, startServer, type RunningServer, type ServerConfig } from '../src/app';
import { LIMITS, originAllowed } from '../src/ws';

const defaults = { ...LIMITS, maxBytes: { ...LIMITS.maxBytes } };
let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
  Object.assign(LIMITS, defaults);
});

/** Boots a server whose log lines are collected (to count what clients can make it write). */
async function boot(over: Partial<ServerConfig> = {}, now?: () => number) {
  const lines: string[] = [];
  const out = new Writable({
    write: (c: Buffer, _e, cb) => {
      lines.push(...c.toString().split('\n').filter(Boolean));
      cb();
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'gg-'));
  const cfg: ServerConfig = {
    port: 0,
    mode: 'development',
    staticDir: null,
    logFile: join(dir, 'dev.log'),
    version: 'test',
    extraOrigins: [],
    maintenanceFile: join(dir, 'maintenance'),
    caps: { rooms: 100, players: 600, sockets: 1000 },
    ...over,
  };
  running = await startServer(cfg, createLogger(cfg, { stdout: out }), { now });
  return { url: `ws://127.0.0.1:${running.port}/ws`, lines };
}

function client(url: string, headers: Record<string, string> = {}, origin?: string) {
  const socket = new WebSocket(url, { headers, ...(origin ? { origin } : {}) });
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  const dec = createSnapDecoder();
  socket.on('message', (d, isBinary) => {
    const m = decodeServerData(isBinary ? new Uint8Array(d as Buffer) : d.toString(), dec);
    if (m) inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const opened = new Promise<void>((ok, bad) => {
    socket.on('open', () => ok());
    socket.on('error', bad);
    socket.on('unexpected-response', (_req, res) => bad(new Error(`http ${res.statusCode}`)));
  });
  const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
  const until = async <T extends ServerMessage['t']>(t: T) => {
    for (;;) {
      while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
      const m = inbox.shift()!;
      if (m.t === t) return m as Extract<ServerMessage, { t: T }>;
    }
  };
  const hello = (sessionToken?: string) =>
    socket.send(
      encode({ t: 'hello', protocolVersion: PROTOCOL_VERSION, ...(sessionToken ? { sessionToken } : {}) }),
    );
  return { socket, opened, closed, until, hello, inbox };
}
const settings: Settings = {
  minutes: 3,
  scoreLimit: 5,
  crates: 'off',
  weights: defaultWeights(),
  bots: true,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSocket denetim çerçeveleri (#3)', () => {
  it('yerel ping seli bağlantıyı düşürür; ölçülü ping cevaplanır', async () => {
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    const pong = new Promise<void>((ok) => c.socket.once('pong', () => ok()));
    c.socket.ping();
    await pong;
    for (let i = 0; i < 200; i++) c.socket.ping();
    await c.closed;
    expect(c.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('istenmemiş pong seli de bağlantıyı düşürür', async () => {
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    for (let i = 0; i < 200; i++) c.socket.pong();
    await c.closed;
  });

  it('yarım kalan (parçalı) mesaj kalp atışına cevap verse de süre dolunca kapanır', async () => {
    LIMITS.heartbeatMs = 100;
    LIMITS.idleMs = 400;
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    c.hello();
    await c.until('welcome');
    c.socket.send('{"t":"ping",', { fin: false }); // never finished; the ws client answers pings itself
    expect(await c.closed).toBe(4012);
  });
});

/** A raw TCP client: does the WebSocket upgrade by hand, then sends whatever bytes it likes. */
async function rawUpgrade(port: number): Promise<{ status: number; send(b: Buffer): void; end(): void }> {
  const s = tcp(port, '127.0.0.1');
  await new Promise<void>((ok) => s.once('connect', () => ok()));
  s.write(
    'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  const head = await new Promise<string>((ok) => s.once('data', (d: Buffer) => ok(d.toString())));
  s.on('error', () => {});
  return {
    status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]),
    send: (b) => s.write(b),
    end: () => s.destroy(),
  };
}

describe('reddedilen bağlantı süreci çökertemez (#2)', () => {
  it('sınırı aşan bağlantıya geçersiz çerçeve: süreç ayakta, diğer oyuncu bağlı kalır', async () => {
    LIMITS.connectionsPerIp = 2;
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    try {
      const { url } = await boot();
      const port = Number(new URL(url).port);
      const a = client(url);
      const b = client(url);
      await Promise.all([a.opened, b.opened]);
      const extra = await rawUpgrade(port);
      // A masked frame with reserved opcode 3: invalid for any WebSocket that reads it.
      extra.send(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));
      await sleep(200);
      extra.end();
      expect(crashes).toEqual([]);
      expect(extra.status).toBe(429);
      a.hello();
      expect((await a.until('welcome')).t).toBe('welcome');
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });

  it('kabul edilmiş bağlantıda geçersiz çerçeve de yalnızca o bağlantıyı kapatır', async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    try {
      const { url } = await boot();
      const raw = await rawUpgrade(Number(new URL(url).port));
      expect(raw.status).toBe(101);
      raw.send(Buffer.from([0x83, 0x80, 1, 2, 3, 4]));
      await sleep(200);
      raw.end();
      expect(crashes).toEqual([]);
      const c = client(url);
      await c.opened;
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });
});

describe('kabul sınırları (#4, #9)', () => {
  it('sunucu çapında soket sınırı dolunca yeni bağlantı kurulamaz', async () => {
    const { url } = await boot({ caps: { rooms: 100, players: 600, sockets: 2 } });
    const a = client(url);
    const b = client(url);
    await Promise.all([a.opened, b.opened]);
    await expect(client(url).opened).rejects.toThrow('503');
  });

  it('bir adresten çok hızlı yeni bağlantı reddedilir; başka adres etkilenmez', async () => {
    LIMITS.connectsPerIpBurst = 3;
    const { url } = await boot();
    const ip = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 3; i++) await client(url, ip).opened;
    await expect(client(url, ip).opened).rejects.toThrow('429');
    await client(url, { 'x-forwarded-for': '203.0.113.8' }).opened;
  });

  it('ofis sınırları: tek adresten ~30 kişi ve birkaç sekme rahatça bağlanır', () => {
    expect(LIMITS.connectionsPerIp).toBeGreaterThanOrEqual(60);
    expect(LIMITS.connectsPerIpBurst).toBeGreaterThanOrEqual(60);
    expect(LIMITS.createsPerIpPerMin).toBeGreaterThanOrEqual(20);
    expect(LIMITS.maxSockets).toBeGreaterThanOrEqual(600);
  });

  it("Origin: prod'da yalnızca oyunun sitesi; dev'de localhost; Origin'siz (tarayıcı değil) geçer", () => {
    expect(originAllowed('https://playcrateball.com', true)).toBe(true);
    expect(originAllowed('https://evil.example', true)).toBe(false);
    expect(originAllowed('http://localhost:5173', true)).toBe(false);
    expect(originAllowed('http://localhost:5173', false)).toBe(true);
    expect(originAllowed('http://127.0.0.1:3000', false)).toBe(true);
    expect(originAllowed('https://evil.example', false)).toBe(false);
    expect(originAllowed(undefined, true)).toBe(true);
    // Running the prod image locally (docker smoke): only an Origin named in CRATEBALL_ORIGINS.
    expect(originAllowed('http://localhost:8080', true, ['http://localhost:8080'])).toBe(true);
  });

  it("prod modunda yabancı Origin'li tarayıcı soketi reddedilir, oyunun sitesi kabul edilir", async () => {
    const { url } = await boot({ mode: 'production' });
    await expect(client(url, {}, 'https://evil.example').opened).rejects.toThrow('403');
    await client(url, {}, 'https://playcrateball.com').opened;
  });
});

describe('bayt bütçesi ve log (#6)', () => {
  it('türüne göre fazla büyük mesaj ayrıştırılmadan reddedilir', async () => {
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    c.hello();
    await c.until('welcome');
    c.socket.send(JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(4000) }));
    expect((await c.until('error')).code).toBe('bad_message');
  });

  it('bayt bütçesi aşılınca bağlantı kesilir (mesaj sayısı sınırın altında olsa da)', async () => {
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    c.hello();
    await c.until('welcome');
    const big = JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(1900) });
    for (let i = 0; i < 200; i++) c.socket.send(big); // 200 messages (< 720) but ~400 KB
    expect(await c.closed).toBe(4008);
  });

  it('bozuk mesaj seli tek tek loglanmaz; odada olmayanın istatistiği loglanmaz', async () => {
    const { url, lines } = await boot();
    const c = client(url);
    await c.opened;
    c.hello();
    await c.until('welcome');
    for (let i = 0; i < 250; i++) c.socket.send('{nope');
    const stats = Object.fromEntries(
      [
        'fps',
        'frameMsMax',
        'longFrames',
        'rtt',
        'pending',
        'serverQueue',
        'corrections',
        'myCorrectionPx',
        'myCorrectionMaxPx',
        'ballCorrectionMaxPx',
        'othersCorrectionMaxPx',
        'simMsMax',
        'drawMsMax',
        'snapMsMax',
      ].map((k) => [k, 1]),
    );
    c.socket.send(JSON.stringify({ t: 'stats', s: stats }));
    c.socket.send(JSON.stringify({ t: 'ping', id: 9 }));
    await c.until('pong');
    expect(lines.filter((l) => l.includes('bozuk mesaj')).length).toBeLessThanOrEqual(3);
    expect(lines.some((l) => l.includes('istemci istatistik'))).toBe(false);
  });
});

describe('kimlik, atma, özel oda (#7, #8, #14)', () => {
  const create = (c: ReturnType<typeof client>) =>
    c.socket.send(encode({ t: 'create', name: 'Host', roomName: 'R', public: false, settings }));

  it('kendi uydurduğu oturum anahtarı kabul edilmez; sunucu yenisini verir', async () => {
    const { url } = await boot();
    const c = client(url);
    await c.opened;
    c.hello('benim-anahtarim');
    const w = await c.until('welcome');
    expect(w.token).toBeDefined();
    expect(w.token).not.toBe('benim-anahtarim');
    expect(w.token!.length).toBeGreaterThanOrEqual(32);
  });

  it('atılan oyuncu sunucunun verdiği anahtarla dönemez', async () => {
    const { url } = await boot();
    const host = client(url);
    await host.opened;
    host.hello();
    await host.until('welcome');
    create(host);
    const { code } = await host.until('joined');
    const g = client(url);
    await g.opened;
    g.hello();
    const gw = await g.until('welcome');
    g.socket.send(encode({ t: 'join', code, name: 'G' }));
    await g.until('joined');
    host.socket.send(encode({ t: 'kick', id: gw.clientId }));
    await g.until('error');
    const back = client(url);
    await back.opened;
    back.hello(gw.token);
    await back.until('welcome');
    back.socket.send(encode({ t: 'join', code, name: 'G' }));
    expect((await back.until('error')).code).toBe('kicked');
  });

  it('devralınan eski soketten gelen mesajlar yok sayılır', async () => {
    const { url } = await boot();
    const a = client(url);
    await a.opened;
    a.hello();
    const first = await a.until('welcome');
    create(a);
    const { code } = await a.until('joined');
    const b = client(url);
    await b.opened;
    b.hello(first.token);
    await b.until('welcome');
    // Still in flight from the replaced socket: must not act as the player.
    a.socket.send(encode({ t: 'leave' }));
    a.socket.send(encode({ t: 'stop' }));
    await sleep(100);
    b.socket.send(encode({ t: 'join', code, name: 'Host' }));
    const room = (await b.until('room')).room;
    expect(room.players.some((p) => p.id === first.clientId)).toBe(true);
  });

  it('sunucu çapında tahmin bütçesi dolunca ıskalayan adres bekler, hiç ıskalamamış adres katılır', async () => {
    LIMITS.failedJoinsPerMin = 3;
    const { url } = await boot();
    const host = client(url, { 'x-forwarded-for': '198.51.100.1' });
    await host.opened;
    host.hello();
    await host.until('welcome');
    create(host);
    const { code } = await host.until('joined');
    const guesser = client(url, { 'x-forwarded-for': '198.51.100.66' });
    await guesser.opened;
    guesser.hello();
    await guesser.until('welcome');
    for (const guess of ['AAAA', 'BBBB', 'CCCC']) {
      guesser.socket.send(encode({ t: 'join', code: guess, name: 'X' }));
      expect((await guesser.until('error')).code).toBe('room_not_found');
    }
    guesser.socket.send(encode({ t: 'join', code, name: 'X' }));
    expect((await guesser.until('error')).code).toBe('rate_limited'); // even the right code: no oracle
    const friend = client(url, { 'x-forwarded-for': '198.51.100.2' });
    await friend.opened;
    friend.hello();
    await friend.until('welcome');
    friend.socket.send(encode({ t: 'join', code, name: 'F' }));
    expect((await friend.until('joined')).code).toBe(code);
  });
});

describe('atma kalıcılığı ve log bütçesi (#3, #4)', () => {
  const create = (c: ReturnType<typeof client>) =>
    c.socket.send(encode({ t: 'create', name: 'Host', roomName: 'R', public: false, settings }));

  it('atılan sekme dakikalık temizlikten sonra aynı anahtarla dönse de hâlâ atılmış', async () => {
    LIMITS.sweepMs = 30;
    let t = Date.now();
    const { url } = await boot({}, () => t);
    const host = client(url);
    await host.opened;
    host.hello();
    await host.until('welcome');
    create(host);
    const { code } = await host.until('joined');
    const g = client(url, { 'x-forwarded-for': '192.0.2.5' });
    await g.opened;
    g.hello();
    const gw = await g.until('welcome');
    g.socket.send(encode({ t: 'join', code, name: 'G' }));
    await g.until('joined');
    host.socket.send(encode({ t: 'kick', id: gw.clientId }));
    await g.until('error');
    g.socket.close();
    await g.closed;
    t += 61_000; // past the old one-minute token cleanup, well inside the 30-minute ban
    await sleep(120); // several sweeps run
    const back = client(url, { 'x-forwarded-for': '192.0.2.5' });
    await back.opened;
    back.hello(gw.token);
    const bw = await back.until('welcome');
    expect(bw.token).toBe(gw.token);
    back.socket.send(encode({ t: 'join', code, name: 'G' }));
    expect((await back.until('error')).code).toBe('kicked');
  });

  it('meşru mesajlarla oda/maç çalkalama logu bütçeyi aşamaz; aşan satırlar özetlenir', async () => {
    LIMITS.logBudgets = { ...LIMITS.logBudgets, life: { burst: 40, perSec: 1 } };
    LIMITS.sweepMs = 100;
    const { url, lines } = await boot();
    const hosts = Array.from({ length: 30 }, (_, i) => client(url, { 'x-forwarded-for': `198.18.0.${i}` }));
    await Promise.all(hosts.map((h) => h.opened));
    for (const h of hosts) h.hello();
    await Promise.all(hosts.map((h) => h.until('welcome')));
    for (const h of hosts) create(h);
    await Promise.all(hosts.map((h) => h.until('joined')));
    for (let round = 0; round < 3; round++)
      for (const h of hosts) {
        h.socket.send(encode({ t: 'start' }));
        h.socket.send(encode({ t: 'stop' }));
      }
    for (const h of hosts) h.socket.close();
    await Promise.all(hosts.map((h) => h.closed));
    await sleep(250);
    const lifecycle = lines.filter((l) =>
      /oyuncu bağlandı|oda kuruldu|odaya girdi|maç başladı|maçı durdurdu|ws kapandı|boş oda kapandı/.test(l),
    );
    expect(lifecycle.length).toBeLessThanOrEqual(45);
    expect(lines.some((l) => l.includes('log bütçesi aşıldı'))).toBe(true);
  });

  it('normal yükte panonun satırları yazılır (bütçe yalnızca kötüye kullanımda devreye girer)', async () => {
    const { url, lines } = await boot();
    const host = client(url);
    await host.opened;
    host.hello();
    await host.until('welcome');
    create(host);
    const { code } = await host.until('joined');
    const g = client(url);
    await g.opened;
    g.hello();
    await g.until('welcome');
    g.socket.send(encode({ t: 'join', code, name: 'G' }));
    await g.until('joined');
    host.socket.send(encode({ t: 'start' }));
    await host.until('snap');
    for (const m of ['oyuncu bağlandı', 'oda kuruldu', 'oyuncu odaya girdi', 'maç başladı'])
      expect(
        lines.some((l) => l.includes(m)),
        m,
      ).toBe(true);
    expect(lines.some((l) => l.includes('log bütçesi aşıldı'))).toBe(false);
  });
});

describe('oturum sınırı ve HTTP hataları (#2, #3)', () => {
  it('yeni oturum seli atılmış sekmenin anahtarını unutturamaz (sınır küçültülmüş)', async () => {
    LIMITS.maxSessions = 10;
    const { url } = await boot();
    const host = client(url);
    await host.opened;
    host.hello();
    await host.until('welcome');
    host.socket.send(encode({ t: 'create', name: 'Host', roomName: 'R', public: false, settings }));
    const { code } = await host.until('joined');
    const g = client(url);
    await g.opened;
    g.hello();
    const gw = await g.until('welcome');
    g.socket.send(encode({ t: 'join', code, name: 'G' }));
    await g.until('joined');
    host.socket.send(encode({ t: 'kick', id: gw.clientId }));
    await g.until('error');
    g.socket.close();
    await g.closed;
    // Three times the cap in fresh sessions, each coming and going.
    for (let i = 0; i < 30; i++) {
      const f = client(url, { 'x-forwarded-for': `203.0.113.${i % 20}` });
      await f.opened;
      f.hello();
      await f.until('welcome');
      f.socket.close();
      await f.closed;
    }
    const back = client(url);
    await back.opened;
    back.hello(gw.token);
    expect((await back.until('welcome')).token).toBe(gw.token);
    back.socket.send(encode({ t: 'join', code, name: 'G' }));
    expect((await back.until('error')).code).toBe('kicked');
    // The host (in a room, connected) kept its token through the flood too.
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('bozuk istek hedefi 400 alır; istek başına log satırı yazılmaz', async () => {
    const { url, lines } = await boot();
    const port = Number(new URL(url).port);
    const codes: number[] = [];
    for (let i = 0; i < 300; i++) {
      const s = tcp(port, '127.0.0.1');
      await new Promise<void>((ok) => s.once('connect', () => ok()));
      s.write('GET //foo:bad/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      const head = await new Promise<string>((ok) => s.once('data', (d: Buffer) => ok(d.toString())));
      codes.push(Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1]));
      s.destroy();
    }
    expect(new Set(codes)).toEqual(new Set([400]));
    expect(lines.filter((l) => l.includes('http hatası')).length).toBe(0);
  });
});

describe('anahtar başına tek canlı bağlantı', () => {
  it('lobide aynı anahtarla ikinci bağlantı ilkinin yerini alır; korunan anahtar yeniden bağlanan oyuncuyu izler', async () => {
    LIMITS.maxSessions = 10;
    const { url } = await boot();
    const host = client(url);
    await host.opened;
    host.hello();
    await host.until('welcome');
    host.socket.send(encode({ t: 'create', name: 'Host', roomName: 'R', public: false, settings }));
    const { code } = await host.until('joined');
    // Two lobby connections with one token (the reported sequence): the newer one closes, then whoever
    // still holds the token joins the room.
    const a = client(url);
    await a.opened;
    a.hello();
    const aw = await a.until('welcome');
    const b = client(url);
    await b.opened;
    b.hello(aw.token);
    const bw = await b.until('welcome');
    expect(bw.clientId).toBe(aw.clientId); // the same player, not a second identity on one token
    expect(await a.closed).toBe(4011);
    b.socket.close();
    await b.closed;
    const holder = a.socket.readyState === WebSocket.OPEN ? a : client(url);
    let holderId = aw.clientId;
    if (holder !== a) {
      await holder.opened;
      holder.hello(aw.token);
      const hw = await holder.until('welcome');
      expect(hw.token).toBe(aw.token);
      holderId = hw.clientId;
    }
    holder.socket.send(encode({ t: 'join', code, name: 'G' }));
    await holder.until('joined');
    // Session churn far past the cap while the holder is in the room…
    for (let i = 0; i < 30; i++) {
      const f = client(url, { 'x-forwarded-for': `203.0.113.${i % 20}` });
      await f.opened;
      f.hello();
      await f.until('welcome');
      f.socket.close();
      await f.closed;
    }
    // …then a kick, and the same tab comes back with its token: still the same identity, still kicked.
    host.socket.send(encode({ t: 'kick', id: holderId }));
    await holder.until('error');
    holder.socket.close();
    await holder.closed;
    const back = client(url);
    await back.opened;
    back.hello(aw.token);
    expect((await back.until('welcome')).token).toBe(aw.token);
    back.socket.send(encode({ t: 'join', code, name: 'G' }));
    expect((await back.until('error')).code).toBe('kicked');
  });
});
