/**
 * Load test: headless clients that join real rooms over real sockets and play.
 *   pnpm loadtest --url wss://playcrateball.com/ws --players 60 --seconds 300
 *
 * Every client is named `load-…`; rooms are private and called `load`, so nobody sees them in the
 * room list and the logs tell them apart. Each room's first client creates it, the rest join by code,
 * and the host starts the match (again whenever one ends). A client chases the ball and kicks near it,
 * so the server runs kicks, relays, goals and crates like in a real match.
 *
 * Per address the server allows 96 connections and 20 rooms: one machine can run up to 96 clients.
 * Downlink is the other limit here: about 1 Mbit/s per client (JSON snapshots at 30 Hz).
 *
 * Measured per 5 s window and in total: clients connected / in a match, bytes and snapshots received
 * per client, snapshot gaps (a gap over 100 ms is a stall the player would see), ping RTT, errors.
 */
import { writeFileSync } from 'node:fs';
import {
  PROTOCOL_VERSION,
  createSnapDecoder,
  decodeServerData,
  type ServerMessage,
} from '../../packages/protocol/src/index';
import { DEFAULT_SETTINGS, DOWN, KICK, LEFT, RIGHT, UP, type Game } from '../../packages/sim/src/index';

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
};
const URL_ = opt('url', 'ws://localhost:3000/ws');
const PLAYERS = Number(opt('players', '12'));
const PER_ROOM = Number(opt('per-room', '6'));
const SECONDS = Number(opt('seconds', '60'));
/** Clients start spread over this many seconds (the server meters new connections per address). */
const RAMP = Number(opt('ramp', String(Math.max(5, Math.ceil(PLAYERS / 2)))));
const BOTS = opt('bots', 'false') === 'true';
const TAG = opt('tag', Math.random().toString(36).slice(2, 6));
const OUT = opt('json', '');

const TICK_MS = 1000 / 60;
const GAP_MS = 100;

interface Win {
  bytes: number;
  snaps: number;
  gaps: number;
  maxGap: number;
  rtts: number[];
}
const newWin = (): Win => ({ bytes: 0, snaps: 0, gaps: 0, maxGap: 0, rtts: [] });

interface Client {
  name: string;
  ws: WebSocket | null;
  open: boolean;
  playing: boolean;
  me: string | null;
  seq: number;
  bits: number;
  lastSnapAt: number;
  win: Win;
}

const clients: Client[] = [];
const errors = new Map<string, number>();
let closes = 0;
const total = newWin();
interface Row {
  t: number;
  open: number;
  playing: number;
  kbitPerClient: number;
  mbitTotal: number;
  snapsPerSec: number;
  gaps: number;
  maxGapMs: number;
  rttP50: number;
  rttP95: number;
  rttMax: number;
}
const windows: Row[] = [];
const t0 = Date.now();
const note = (k: string) => errors.set(k, (errors.get(k) ?? 0) + 1);

/** Chase the ball, kick when close; a little noise so players do not stack perfectly. */
function think(g: Game, id: string): number {
  const p = g.players.find((o) => o.id === id);
  if (!p) return 0;
  const dx = g.ball.x - p.x + (Math.random() - 0.5) * 40;
  const dy = g.ball.y - p.y + (Math.random() - 0.5) * 40;
  let b = 0;
  if (dx > 8) b |= RIGHT;
  else if (dx < -8) b |= LEFT;
  if (dy > 8) b |= DOWN;
  else if (dy < -8) b |= UP;
  if (Math.hypot(g.ball.x - p.x, g.ball.y - p.y) < p.r + 30 && Math.random() < 0.5) b |= KICK;
  return b;
}

function connect(c: Client, host: boolean, room: { code: Promise<string>; resolve: (s: string) => void }) {
  const ws = new WebSocket(URL_);
  c.ws = ws;
  let snapN = 0;
  let pingId = 0;
  const pings = new Map<number, number>();
  const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  let input: ReturnType<typeof setInterval> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  ws.onopen = () => {
    c.open = true;
    send({ t: 'hello', protocolVersion: PROTOCOL_VERSION });
  };
  ws.onerror = () => note('socket error');
  ws.onclose = (e) => {
    if (c.open) closes++;
    else note(`refused (${e.code})`);
    c.open = false;
    c.playing = false;
    if (input) clearInterval(input);
    if (ping) clearInterval(ping);
  };
  ws.binaryType = 'arraybuffer';
  // Every snapshot frame is decoded (a delta builds on the one before), as a browser does.
  const snaps = createSnapDecoder();
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      c.win.bytes += e.data.byteLength;
      total.bytes += e.data.byteLength;
      const m = decodeServerData(e.data, snaps);
      if (m?.t !== 'snap') {
        note('snapshot not applied');
        return;
      }
      const t = performance.now();
      if (c.lastSnapAt) {
        const gap = t - c.lastSnapAt;
        if (gap > GAP_MS) {
          c.win.gaps++;
          total.gaps++;
        }
        c.win.maxGap = Math.max(c.win.maxGap, gap);
        total.maxGap = Math.max(total.maxGap, gap);
      }
      c.lastSnapAt = t;
      c.win.snaps++;
      total.snaps++;
      c.playing = true;
      if (m.ack > c.seq) c.seq = m.ack;
      // Decide 10 times a second.
      if (snapN++ % 3 === 0 && c.me) c.bits = think(m.g, c.me);
      return;
    }
    const raw = e.data as string;
    c.win.bytes += raw.length;
    total.bytes += raw.length;
    if (raw.startsWith('{"t":"ri"')) return;
    const m = JSON.parse(raw) as ServerMessage;
    switch (m.t) {
      case 'welcome':
        ping = setInterval(() => {
          pings.set(++pingId, performance.now());
          send({ t: 'ping', id: pingId });
        }, 1000);
        // 60 inputs a second, like a browser at 60 fps.
        input = setInterval(() => {
          if (c.playing) send({ t: 'in', s: ++c.seq, b: c.bits });
        }, TICK_MS);
        if (host)
          send({
            t: 'create',
            name: c.name,
            roomName: 'load',
            public: false,
            settings: { ...DEFAULT_SETTINGS, minutes: 10, scoreLimit: 10, bots: BOTS },
          });
        else void room.code.then((code) => send({ t: 'join', code, name: c.name }));
        break;
      case 'joined':
        c.me = m.playerId;
        if (host) room.resolve(m.code);
        break;
      case 'room':
        if (m.room.state === 'lobby') {
          c.playing = false;
          c.lastSnapAt = 0;
        }
        if (host && m.room.state === 'lobby' && (m.room.players.length >= PER_ROOM || BOTS)) {
          send({ t: 'start' });
        }
        break;
      case 'pong': {
        const at = pings.get(m.id);
        if (at !== undefined) {
          pings.delete(m.id);
          c.win.rtts.push(performance.now() - at);
          total.rtts.push(performance.now() - at);
        }
        break;
      }
      case 'error':
        note(m.code);
        break;
    }
  };
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
};

function report(): Row {
  const secs = 5;
  const open = clients.filter((c) => c.open);
  const playing = clients.filter((c) => c.playing);
  const per = playing.map((c) => c.win);
  const rtts = clients.flatMap((c) => c.win.rtts);
  const kbps = per.map((w) => (w.bytes * 8) / 1000 / secs);
  const row: Row = {
    t: Math.round((Date.now() - t0) / 1000),
    open: open.length,
    playing: playing.length,
    kbitPerClient: Math.round(kbps.reduce((a, b) => a + b, 0) / Math.max(1, kbps.length)),
    mbitTotal: Math.round(((clients.reduce((a, c) => a + c.win.bytes, 0) * 8) / 1e6 / secs) * 10) / 10,
    snapsPerSec:
      Math.round((per.reduce((a, w) => a + w.snaps, 0) / Math.max(1, per.length) / secs) * 10) / 10,
    gaps: per.reduce((a, w) => a + w.gaps, 0),
    maxGapMs: Math.round(Math.max(0, ...per.map((w) => w.maxGap))),
    rttP50: pct(rtts, 0.5),
    rttP95: pct(rtts, 0.95),
    rttMax: pct(rtts, 1),
  };
  windows.push(row);
  console.log(
    `${String(row.t).padStart(4)}s  open ${row.open}  playing ${row.playing}  ` +
      `${row.kbitPerClient} kbit/s per client (${row.mbitTotal} Mbit/s)  ${row.snapsPerSec} snap/s  ` +
      `gaps>${GAP_MS}ms ${row.gaps} (max ${row.maxGapMs} ms)  rtt ${row.rttP50}/${row.rttP95}/${row.rttMax} ms` +
      (errors.size ? `  errors ${JSON.stringify(Object.fromEntries(errors))}` : '') +
      (closes ? `  closed ${closes}` : ''),
  );
  for (const c of clients) c.win = newWin();
  return row;
}

const rooms = Math.ceil(PLAYERS / PER_ROOM);
console.log(`${PLAYERS} clients, ${rooms} rooms of ${PER_ROOM}, ramp ${RAMP}s, ${SECONDS}s → ${URL_}`);
for (let r = 0; r < rooms; r++) {
  let resolve!: (s: string) => void;
  const room = { code: new Promise<string>((res) => (resolve = res)), resolve: (s: string) => resolve(s) };
  for (let i = 0; i < PER_ROOM && r * PER_ROOM + i < PLAYERS; i++) {
    const n = r * PER_ROOM + i;
    const c: Client = {
      name: `load-${TAG}-${n}`,
      ws: null,
      open: false,
      playing: false,
      me: null,
      seq: 0,
      bits: 0,
      lastSnapAt: 0,
      win: newWin(),
    };
    clients.push(c);
    setTimeout(() => connect(c, i === 0, room), (n / PLAYERS) * RAMP * 1000);
  }
}
const timer = setInterval(() => void report(), 5000);
setTimeout(() => {
  clearInterval(timer);
  void report();
  for (const c of clients) c.ws?.close();
  const steady = windows.filter((w) => w.t > RAMP + 10);
  const worst = (k: keyof Row) => Math.max(0, ...steady.map((w) => w[k]));
  const summary = {
    url: URL_,
    players: PLAYERS,
    perRoom: PER_ROOM,
    seconds: SECONDS,
    rttP50: pct(total.rtts, 0.5),
    rttP95: pct(total.rtts, 0.95),
    rttP99: pct(total.rtts, 0.99),
    snapGaps: total.gaps,
    maxGapMs: Math.round(total.maxGap),
    worstWindowMaxGapMs: worst('maxGapMs'),
    minPlaying: Math.min(...steady.map((w) => w.playing)),
    errors: Object.fromEntries(errors),
    closed: closes,
    windows,
  };
  console.log(JSON.stringify({ ...summary, windows: undefined }, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
  setTimeout(() => process.exit(0), 500);
}, SECONDS * 1000);
