import './style.css';
import { CODE_RE, PROTOCOL_VERSION, type RoomInfo } from '@crateball/protocol';
import { DEFAULT_SETTINGS, TICK_HZ, type BlastKind, type Role } from '@crateball/sim';
import { createEventTracker } from './events';
import { createKeyboard } from './input';
import { connect, type NetStatus } from './net';
import { createParticles } from './particles';
import { createPredictor } from './predict';
import { createRenderer } from './render';
import { createSound } from './sound';
import { createTelemetry } from './telemetry';
import { createUi } from './ui';

const $ = <T extends HTMLElement>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`index.html eksik: ${sel}`);
  return el;
};
const canvas = $<HTMLCanvasElement>('#game');
const banner = $<HTMLDivElement>('#banner');

const params = new URLSearchParams(location.search);
const pathCode = /^\/r\/([A-Za-z]{4})\/?$/.exec(location.pathname)?.[1]?.toUpperCase();
// Query flags (debug, autoplay, name) survive the /r/CODE rewrite so a reload behaves the same.
const debugQuery = location.search;
let autoStarted = false;

const renderer = createRenderer(canvas);
const resize = () => renderer.resize(innerWidth, innerHeight, devicePixelRatio);
addEventListener('resize', resize);
resize();

const pred = createPredictor();
const fx = createParticles();
const sound = createSound();
const track = createEventTracker();
let mutedPref = false;
try {
  mutedPref = localStorage.getItem('muted') === '1';
} catch {
  /* private mode */
}
sound.setMuted(mutedPref);
const setMuted = (m: boolean) => {
  sound.setMuted(m);
  try {
    localStorage.setItem('muted', m ? '1' : '0');
  } catch {
    /* private mode */
  }
};
// Browsers only start audio from a user gesture; any of these counts (capture phase, so nothing can
// swallow it first).
for (const ev of ['pointerdown', 'click', 'keydown', 'touchstart'] as const)
  addEventListener(ev, () => sound.unlock(), { capture: true, passive: true });
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sound.unlock());

let room: RoomInfo | null = null;
let code: string | null = null;
let rtt = 0;
/** Smoothed count of our inputs waiting on the server (debug panel). */
let queueAvg = 0;

const showError = (text: string) => {
  banner.hidden = false;
  banner.textContent = text;
  setTimeout(() => (banner.hidden = true), 3500);
};

const toMenu = () => {
  room = null;
  code = null;
  pred.reset();
  history.replaceState(null, '', `/${params.has('debug') ? '?debug' : ''}`);
  ui.menu();
};

const lag = import.meta.env.DEV ? Number(params.get('lag') ?? 0) : 0;
const jitter = import.meta.env.DEV ? Number(params.get('jitter') ?? 0) : 0;
const { laggySocket } =
  import.meta.env.DEV && (lag > 0 || jitter > 0) ? await import('./lag') : { laggySocket: null };
/** Per tab (sessionStorage): a reload or a dropped connection gets the same player back. */
const sessionToken = (() => {
  try {
    const existing = sessionStorage.getItem('crateball-session');
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem('crateball-session', fresh);
    return fresh;
  } catch {
    return undefined;
  }
})();
const conn = connect({
  sessionToken,
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  createSocket: laggySocket ? (url) => laggySocket(url, lag, jitter) : undefined,
  onStatus: (s) => {
    if (room) {
      if (s === 'closed') {
        banner.hidden = false;
        banner.textContent = 'Connection lost — reconnecting…';
      } else if (s === 'open' && banner.textContent === 'Connection lost — reconnecting…')
        banner.hidden = true;
    }
    if (s === 'open') {
      if (code) conn.send({ t: 'join', code, name: ui.name });
      else if (params.has('autoplay'))
        conn.send({
          t: 'create',
          name: ui.name,
          roomName: 'Test',
          public: false,
          settings: DEFAULT_SETTINGS,
        });
      else if (pathCode && ui.name !== 'Player') conn.send({ t: 'join', code: pathCode, name: ui.name });
    }
    if (s !== 'version_mismatch') return;
    banner.hidden = false;
    banner.textContent = 'The game was updated.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload page';
    btn.onclick = () => location.reload();
    banner.append(btn);
  },
  onServerVersion: (v) => {
    // A deploy restarts the server: everyone reconnects and lands here. Old client code must not keep
    // playing against new server code, so reload into the new release (at most twice a minute, in case
    // a stale cache keeps serving the old page).
    if (__APP_VERSION__ === 'dev' || v === 'dev' || v === 'unknown' || v === __APP_VERSION__) return;
    let tries: number[] = [];
    try {
      tries = (JSON.parse(sessionStorage.getItem('reloads') ?? '[]') as number[]).filter(
        (t) => Date.now() - t < 60_000,
      );
    } catch {
      /* storage blocked */
    }
    if (tries.length >= 2) return;
    try {
      sessionStorage.setItem('reloads', JSON.stringify([...tries, Date.now()]));
    } catch {
      /* storage blocked */
    }
    banner.hidden = false;
    banner.textContent = 'Crateball was updated — reloading…';
    setTimeout(() => location.reload(), 1500);
  },
  onMessage: (m) => {
    switch (m.t) {
      case 'joined':
        code = m.code;
        pred.setMe(m.playerId);
        history.replaceState(null, '', `/r/${m.code}${debugQuery}`);
        if (room) onRoom(room);
        break;
      case 'room':
        onRoom(m.room);
        break;
      case 'snap':
        if (room?.state === 'playing') {
          pred.snapshot(m.ack, m.g);
          queueAvg = queueAvg * 0.9 + m.q * 0.1;
        }
        break;
      case 'pong':
        rtt = performance.now() - m.id;
        break;
      case 'error':
        showError(m.message);
        if (m.code === 'room_not_found') toMenu();
        break;
    }
  },
});
setInterval(() => conn.send({ t: 'ping', id: Math.floor(performance.now()) }), 1000);

function onRoom(r: RoomInfo) {
  const wasPlaying = room?.state === 'playing';
  room = r;
  // Dev/test shortcut: ?autoplay creates a room and the host starts it right away.
  if (params.has('autoplay') && !autoStarted && r.host === pred.me && r.state === 'lobby') {
    autoStarted = true;
    conn.send({ t: 'start' });
  }
  if (r.state === 'playing') ui.hide();
  else {
    if (wasPlaying) pred.reset();
    ui.lobby(r, pred.me);
  }
}

const ui = createUi(
  $<HTMLDivElement>('#ui'),
  {
    create: (roomName, isPublic, settings) =>
      conn.send({ t: 'create', name: ui.name, roomName, public: isPublic, settings }),
    join: (c) => conn.send({ t: 'join', code: c, name: ui.name }),
    leave: () => {
      conn.send({ t: 'leave' });
      toMenu();
    },
    team: (team) => pred.me && conn.send({ t: 'move', id: pred.me, team }),
    move: (id, team) => conn.send({ t: 'move', id, team }),
    swap: (a, b) => conn.send({ t: 'swap', a, b }),
    role: (role) => conn.send({ t: 'role', role }),
    settings: (settings) => conn.send({ t: 'settings', settings }),
    start: () => conn.send({ t: 'start' }),
    mute: setMuted,
  },
  { name: params.get('name') ?? undefined, muted: mutedPref },
);
ui.menu(pathCode && CODE_RE.test(pathCode) ? pathCode : undefined);

const ROLE_KEYS: Record<string, Role> = { Digit1: 'gk', Digit2: 'def', Digit3: 'mid', Digit4: 'fwd' };
const keyboard = createKeyboard(window, (code) => {
  if (code === 'KeyM') setMuted(!sound.muted);
  if (code === 'KeyR' || code === 'F9') sendReport();
  if (room?.state !== 'playing') return;
  const me = pred.game?.players.find((p) => p.id === pred.me);
  if (code === 'KeyT' && me) conn.send({ t: 'move', id: me.id, team: me.team === 'red' ? 'blue' : 'red' });
  const role = ROLE_KEYS[code];
  if (role) conn.send({ t: 'role', role });
});
document.addEventListener('visibilitychange', () => keyboard.release());

let lastCorrections = 0;
let lastMyPx = 0;
const telemetry = createTelemetry(() => {
  const c = pred.corrections;
  const px = pred.myCorrection;
  const out = {
    rtt,
    pending: pred.pending,
    serverQueue: queueAvg,
    corrections: c - lastCorrections,
    myCorrectionPx: px - lastMyPx,
    ...(({ me, ball, others }) => ({
      myCorrectionMaxPx: me,
      ballCorrectionMaxPx: ball,
      othersCorrectionMaxPx: others,
    }))(pred.takeMaxCorrection()),
  };
  lastCorrections = c;
  lastMyPx = px;
  return out;
});
const sendReport = () => {
  if (room?.state !== 'playing') return;
  conn.send({ t: 'report', note: '', recent: telemetry.recent() });
  banner.hidden = false;
  banner.textContent = 'Report sent';
  setTimeout(() => (banner.hidden = true), 1500);
};

const TICK_MS = 1000 / TICK_HZ;
let acc = 0;
let last = performance.now();
const stats = { frame: 0, fps: 0, frameMs: 0 };
let fpsT = last;
let fpsN = 0;

function loop(now: number) {
  const dt = now - last;
  last = now;
  acc = Math.min(acc + dt, TICK_MS * 6);
  const tickMs = TICK_MS;
  // Offline: freeze the match instead of predicting goals and effects that never happen.
  const live = conn.status === 'open';
  if (!live) acc = Math.min(acc, tickMs);
  while (live && acc >= tickMs) {
    acc -= tickMs;
    const bits = room?.state === 'playing' ? keyboard.bits() : 0;
    const seq = pred.tick(bits);
    if (seq !== null) conn.send({ t: 'in', s: seq, b: bits });
  }
  const t0 = performance.now();
  for (const e of track(pred.game)) {
    sound.play(e);
    fx.emit(e);
  }
  if (pred.game) fx.ambient(pred.game, (id) => pred.pos(id, acc / TICK_MS), dt / 1000);
  fx.update(Math.min(dt, 50) / 1000);
  pred.decay(dt / 1000);
  renderer.draw(pred, Math.min(1, acc / tickMs), fx, { rtt: conn.status === 'open' ? rtt : null });
  stats.frameMs = performance.now() - t0;
  stats.frame++;
  fpsN++;
  if (now - fpsT >= 500) {
    stats.fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
  const window2s = telemetry.frame(now, dt, room?.state === 'playing' && conn.status === 'open');
  if (window2s) conn.send({ t: 'stats', s: window2s });
  afterFrame?.();
  requestAnimationFrame(loop);
}
let afterFrame: (() => void) | null = null;
requestAnimationFrame(loop);

const NET_TEXT: Record<NetStatus, string> = {
  connecting: 'connecting…',
  open: 'connected',
  closed: 'offline — retrying',
  version_mismatch: 'version mismatch',
};

function getState() {
  const g = pred.game;
  const me = g?.players.find((p) => p.id === pred.me);
  return {
    frame: stats.frame,
    screen: ui.screen,
    room,
    net: {
      status: conn.status,
      clientId: conn.clientId,
      protocolVersion: PROTOCOL_VERSION,
      rtt: Math.round(rtt),
    },
    render: { fps: stats.fps, frameMs: stats.frameMs, particles: fx.count },
    sound: sound.debug(),
    pred: {
      pending: pred.pending,
      corrections: pred.corrections,
      serverQueue: Math.round(queueAvg * 10) / 10,
      myCorrectionPx: Math.round(pred.myCorrection),
    },
    sim: g && {
      tick: g.tick,
      phase: g.phase,
      score: g.score,
      clock: g.clock,
      players: g.players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot, role: p.role })),
      me: me && { x: me.x, y: me.y, team: me.team, hp: me.hp, gun: me.gun, role: me.role },
      ball: g.ball,
      crates: g.crates.length,
    },
  };
}

// Dev araçları: prod build'de bu dal tamamen silinir (import.meta.env.DEV === false).
if (import.meta.env.DEV) {
  const dev = await import('@crateball/devtools');
  dev.installLogBridge({ endpoint: '/__log', clientId: `c-${Math.random().toString(36).slice(2, 8)}` });
  const bridge = dev.createDebugBridge(getState);
  bridge.register('netStatus', () => NET_TEXT[conn.status]);
  bridge.register('fx', (kind: unknown) => {
    const g = pred.game;
    const me = g?.players.find((p) => p.id === pred.me);
    if (me && typeof kind === 'string')
      fx.emit(
        kind === 'goal'
          ? { type: 'goal', team: me.team, x: 420, y: 0 }
          : { type: 'item', x: me.x, y: me.y, kind: kind as BlastKind },
      );
    return fx.count;
  });
  window.__game = bridge;
  const overlay = dev.createDebugOverlay(document.body);
  if (params.has('debug')) overlay.toggle(true);
  addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      overlay.toggle();
    }
  });
  afterFrame = () => {
    if (!overlay.visible || stats.frame % 10 !== 0) return;
    overlay.update(
      {
        fps: stats.fps,
        frameMs: stats.frameMs,
        calls: 0,
        triangles: 0,
        net: `${NET_TEXT[conn.status]} ${Math.round(rtt)}ms`,
      },
      {
        tick: pred.game?.tick ?? 0,
        pending: pred.pending,
        corrections: pred.corrections,
        particles: fx.count,
      },
    );
  };
  console.info('[crateball] dev tools ready: window.__game, F1 debug panel');
}
