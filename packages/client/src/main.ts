import './style.css';
import { CODE_RE, PROTOCOL_VERSION, type ClientMessage, type RoomInfo } from '@crateball/protocol';
import { DEFAULT_SETTINGS, TICK_HZ, type BlastKind } from '@crateball/sim';
import { createChat } from './chat';
import { createTickClock } from './clock';
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
const clock = createTickClock();
const fx = createParticles();
const sound = createSound();
const track = createEventTracker(() => pred.me);
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

/** A join is on its way: a refusal (full, gone, kicked) means we are not in that room. */
let joinPending = false;
/** The server said this room is in another of its processes: reconnecting there to join it. */
let moveTo: string | null = null;
/** A room we are on our way into, if any: sent elsewhere, or a join refused for now and to be retried.
 * It stays the target until `joined`, a refusal for good or Back (whatever room a reconnect shows). */
const pendingJoin = (): string | null => moveTo ?? (lastAttempt?.t === 'join' ? lastAttempt.code : null);

/** Server under maintenance: a full screen over everything except a match still being played. */
let maintenance = false;
const maintenanceEl = $<HTMLDivElement>('#maintenance');
const showMaintenance = () => {
  maintenanceEl.hidden = !(maintenance && room?.state !== 'playing');
};
const setMaintenance = (on: boolean) => {
  maintenance = on;
  showMaintenance();
};

/** Servers full: a screen that retries what was refused (create or join) every FULL_RETRY_S seconds. */
const FULL_RETRY_S = 15;
/** A join refused as too fast (a room's arrival budget) is tried again after this long. */
const JOIN_RETRY_MS = 3000;
const fullEl = $<HTMLDivElement>('#full');
const fullWait = $<HTMLSpanElement>('#full-wait');
/** The last create or join sent from the menu: what a retry repeats. */
let lastAttempt: ClientMessage | null = null;
let fullTimer: ReturnType<typeof setInterval> | null = null;
const hideFull = () => {
  if (fullTimer) clearInterval(fullTimer);
  fullTimer = null;
  fullEl.hidden = true;
};
const retryFull = () => {
  hideFull();
  if (!lastAttempt) return;
  if (lastAttempt.t === 'join') joinPending = true;
  conn.send(lastAttempt);
};
const showFull = () => {
  hideFull();
  let left = FULL_RETRY_S;
  fullWait.textContent = String(left);
  fullEl.hidden = false;
  fullTimer = setInterval(() => {
    left--;
    fullWait.textContent = String(left);
    if (left <= 0) retryFull();
  }, 1000);
};
$<HTMLButtonElement>('#full-retry').onclick = retryFull;
$<HTMLButtonElement>('#full-back').onclick = () => {
  hideFull();
  lastAttempt = null;
  moveTo = null;
  toMenu();
};
/** A create or join from the menu (remembered for a retry when the servers are full). */
const attempt = (m: ClientMessage) => {
  lastAttempt = m;
  if (m.t === 'join') joinPending = true;
  conn.send(m);
};

const showError = (text: string) => {
  banner.hidden = false;
  banner.textContent = text;
  setTimeout(() => (banner.hidden = true), 3500);
};

const toMenu = () => {
  joinPending = false;
  moveTo = null;
  chat.mode('off');
  chat.mount(null);
  stopBtn.hidden = true;
  leaveBtn.hidden = true;
  room = null;
  code = null;
  rememberRoom(null);
  pred.reset();
  history.replaceState(null, '', `/${params.has('debug') ? '?debug' : ''}`);
  ui.menu();
  showMaintenance();
};

const lag = import.meta.env.DEV ? Number(params.get('lag') ?? 0) : 0;
const jitter = import.meta.env.DEV ? Number(params.get('jitter') ?? 0) : 0;
const { laggySocket } =
  import.meta.env.DEV && (lag > 0 || jitter > 0) ? await import('./lag') : { laggySocket: null };
/** The room this tab was last in (sessionStorage): a reload of /r/CODE goes straight back in, while a
 * shared link opened fresh first shows the invite screen (name + Join). */
const lastRoom = (() => {
  try {
    return sessionStorage.getItem('crateball-room');
  } catch {
    return null;
  }
})();
const rejoin = pathCode !== undefined && pathCode === lastRoom;
const rememberRoom = (c: string | null) => {
  try {
    if (c) sessionStorage.setItem('crateball-room', c);
    else sessionStorage.removeItem('crateball-room');
  } catch {
    /* storage blocked */
  }
};
/** Per tab (sessionStorage): a reload or a dropped connection gets the same player back. The server
 * issues the token (welcome); one it did not issue is ignored. */
const sessionToken = (() => {
  try {
    return sessionStorage.getItem('crateball-session') ?? undefined;
  } catch {
    return undefined;
  }
})();
const keepToken = (token: string) => {
  try {
    sessionStorage.setItem('crateball-session', token);
  } catch {
    /* storage blocked: a reload starts as a new player */
  }
};
// The splash in index.html stays until the fonts are in and the server has answered (or refused), so the
// menu never shows in fallback fonts or before it knows whether we are online. 5 s at most.
let connAnswered!: () => void;
const answered = new Promise<void>((done) => (connAnswered = done));
const splash = document.querySelector<HTMLElement>('#splash');
if (splash) {
  const hide = () => {
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 400);
  };
  void Promise.race([
    Promise.all([document.fonts.ready, answered]),
    new Promise((done) => setTimeout(done, 5000)),
  ]).then(hide);
}
const conn = connect({
  sessionToken,
  onToken: keepToken,
  url: () => {
    const target = pendingJoin() ?? code ?? (pathCode && CODE_RE.test(pathCode) ? pathCode : null);
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${target ? `?room=${target}` : ''}`;
  },
  createSocket: laggySocket ? (url) => laggySocket(url, lag, jitter) : undefined,
  onStatus: (s) => {
    if (s !== 'connecting') connAnswered();
    if (s === 'taken') {
      // The same tab connected again elsewhere (a duplicated tab took the seat): this one steps aside.
      toMenu();
      banner.hidden = false;
      banner.textContent = 'Crateball is open in another tab — this one is disconnected.';
      return;
    }
    if (room && !moveTo) {
      if (s === 'closed') {
        banner.hidden = false;
        banner.textContent = 'Connection lost — reconnecting…';
      } else if (s === 'open' && banner.textContent === 'Connection lost — reconnecting…')
        banner.hidden = true;
    }
    if (s === 'open') {
      // Joins go through `attempt`: a refusal because the servers are full then retries them. A join on
      // its way (sent elsewhere, refused for now, waiting for a retry) comes first: it is where we go.
      const target = pendingJoin();
      if (target) attempt({ t: 'join', code: target, name: ui.name });
      else if (code) attempt({ t: 'join', code, name: ui.name });
      else if (params.has('autoplay'))
        conn.send({
          t: 'create',
          name: ui.name,
          roomName: 'Test',
          public: false,
          settings: DEFAULT_SETTINGS,
        });
      else if (pathCode && rejoin && ui.name !== 'Player')
        attempt({ t: 'join', code: pathCode, name: ui.name });
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
  onMaintenance: setMaintenance,
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
        joinPending = false;
        lastAttempt = null;
        moveTo = null;
        hideFull();
        code = m.code;
        rememberRoom(m.code);
        pred.setMe(m.playerId);
        history.replaceState(null, '', `/r/${m.code}${debugQuery}`);
        if (room) onRoom(room);
        break;
      case 'room':
        onRoom(m.room);
        showMaintenance();
        break;
      case 'maintenance':
        setMaintenance(m.on);
        break;
      case 'moved':
        // That room lives in another server process: connect there (the URL now names it) and join. Out
        // of the current room first, as joining a room here would have done (no slot held for us there).
        if (room) {
          conn.send({ t: 'leave' });
          toMenu();
        }
        moveTo = m.code;
        conn.reconnect();
        break;
      case 'chat':
        // In a match a new line also pops up above the speaker (replays after a reconnect don't).
        if (chat.add(m, m.id === pred.me) && room?.state === 'playing' && m.team !== 'spec')
          renderer.say(m.id, m.text);
        break;
      case 'snap':
        if (room?.state === 'playing') {
          const ts = performance.now();
          pred.snapshot(m.ack, m.g, m.h);
          clock.feedback(m.lead);
          work.snap = Math.max(work.snap, performance.now() - ts);
          queueAvg = queueAvg * 0.9 + m.q * 0.1;
        }
        break;
      case 'ri':
        if (room?.state === 'playing') pred.remoteInput(m.id, m.k, m.b);
        break;
      case 'pong':
        rtt = performance.now() - m.id;
        break;
      case 'error':
        if (m.code === 'maintenance') {
          setMaintenance(true);
          if (joinPending) toMenu();
          break;
        }
        if (m.code === 'server_full' && lastAttempt) {
          // Also a rejoin after a long drop, its slot taken meanwhile: leave the stale match, keep trying.
          joinPending = false;
          moveTo = null;
          if (room) toMenu();
          showFull();
          break;
        }
        if (m.code === 'rate_limited' && joinPending && lastAttempt) {
          // A join refused for now (the room is taking many arrivals): leave a stale match and try again.
          const again = lastAttempt;
          joinPending = false;
          if (room) toMenu();
          showError('Busy right now, trying again…');
          setTimeout(() => {
            if (!room && lastAttempt === again) attempt(again);
          }, JOIN_RETRY_MS);
          break;
        }
        showError(m.message);
        // A refused rejoin after a long drop also lands here: drop the stale match instead of playing alone.
        if (m.code === 'room_not_found' || m.code === 'kicked' || (joinPending && m.code === 'room_full')) {
          lastAttempt = null; // for good: nothing to retry
          toMenu();
        }
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
  const typing = chat.focus();
  chat.mode(r.state === 'playing' ? 'game' : 'lobby');
  if (r.state === 'playing') chat.mount(null);
  // Until `joined` names us (a reloaded page gets the room first), the welcome's id is ours too.
  const meId = pred.me ?? conn.clientId;
  stopBtn.hidden = !(r.state === 'playing' && r.host === meId);
  leaveBtn.hidden = r.state !== 'playing';
  // Unrelated room updates (someone joins, a role change) must not disarm a half-done stop.
  if (stopBtn.hidden) {
    stopBtn.classList.remove('armed');
    stopBtn.textContent = 'Stop match';
  }
  if (r.state === 'playing') ui.hide();
  else {
    if (wasPlaying) pred.reset();
    ui.lobby(r, pred.me);
    chat.mount(document.getElementById('chat-slot'), typing);
  }
}

const ui = createUi(
  $<HTMLDivElement>('#ui'),
  {
    create: (roomName, isPublic) =>
      attempt({ t: 'create', name: ui.name, roomName, public: isPublic, settings: DEFAULT_SETTINGS }),
    meta: (roomName, isPublic) => conn.send({ t: 'meta', name: roomName, public: isPublic }),
    join: (c) => attempt({ t: 'join', code: c, name: ui.name }),
    leave: () => {
      lastAttempt = null; // the player's own choice: no join is on its way any more
      conn.send({ t: 'leave' });
      toMenu();
    },
    team: (team) => pred.me && conn.send({ t: 'move', id: pred.me, team }),
    move: (id, team) => conn.send({ t: 'move', id, team }),
    swap: (a, b) => conn.send({ t: 'swap', a, b }),
    kick: (id) => conn.send({ t: 'kick', id }),
    role: (role) => conn.send({ t: 'role', role }),
    settings: (settings) => conn.send({ t: 'settings', settings }),
    start: () => conn.send({ t: 'start' }),
    mute: setMuted,
  },
  { name: params.get('name') ?? undefined, muted: mutedPref },
);
if (pathCode && CODE_RE.test(pathCode) && !rejoin) ui.invite(pathCode);
else ui.menu(pathCode && CODE_RE.test(pathCode) ? pathCode : undefined);

const chat = createChat(
  (text) => conn.send({ t: 'chat', text }),
  () => keyboard.release(),
);
/** In a match, top left: Leave (everyone) and Stop match (host). Both take two clicks: the first arms. */
const matchBar = document.createElement('div');
matchBar.id = 'match-bar';
const twoClick = (btn: HTMLButtonElement, label: string, armed: string, go: () => void) => {
  let disarmAt: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener('click', () => {
    btn.blur();
    if (btn.classList.contains('armed')) {
      go();
      return;
    }
    btn.classList.add('armed');
    btn.textContent = armed;
    clearTimeout(disarmAt);
    disarmAt = setTimeout(() => {
      btn.classList.remove('armed');
      btn.textContent = label;
    }, 3000);
  });
};
const leaveBtn = document.createElement('button');
leaveBtn.id = 'leave-match';
leaveBtn.type = 'button';
leaveBtn.hidden = true;
leaveBtn.textContent = 'Leave';
twoClick(leaveBtn, 'Leave', 'Click again to leave', () => {
  leaveBtn.classList.remove('armed');
  leaveBtn.textContent = 'Leave';
  conn.send({ t: 'leave' });
  toMenu();
});
/** Host only, in a match: two clicks (the first arms it) end the match for everyone. */
const stopBtn = document.createElement('button');
stopBtn.id = 'stop-match';
stopBtn.type = 'button';
stopBtn.hidden = true;
stopBtn.textContent = 'Stop match';
let disarm: ReturnType<typeof setTimeout> | undefined;
stopBtn.addEventListener('click', () => {
  stopBtn.blur();
  if (stopBtn.classList.contains('armed')) {
    conn.send({ t: 'stop' });
    return;
  }
  stopBtn.classList.add('armed');
  stopBtn.textContent = 'Click again to stop';
  clearTimeout(disarm);
  disarm = setTimeout(() => {
    stopBtn.classList.remove('armed');
    stopBtn.textContent = 'Stop match';
  }, 3000);
});
matchBar.append(leaveBtn, stopBtn);
document.body.append(matchBar);

const keyboard = createKeyboard(window, (code) => {
  if (code === 'KeyM') setMuted(!sound.muted);
  if (code === 'KeyR' || code === 'F9') sendReport();
  if (code === 'Enter' && room) chat.open();
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
    simMsMax: work.sim,
    drawMsMax: work.draw,
    snapMsMax: work.snap,
  };
  lastCorrections = c;
  lastMyPx = px;
  work.sim = work.draw = work.snap = 0;
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
/** Worst work per frame since the last telemetry window, to tell a slow frame's cause apart. */
const work = { sim: 0, draw: 0, snap: 0 };
let fpsT = last;
let fpsN = 0;

function loop(now: number) {
  const dt = now - last;
  last = now;
  acc = Math.min(acc + dt, TICK_MS * 6);
  // Clock sync: ticks a few percent longer while the server says we run further ahead than needed.
  const tickMs = room?.state === 'playing' ? clock.tickMs() : TICK_MS;
  // Offline: freeze the match instead of predicting goals and effects that never happen.
  const live = conn.status === 'open';
  if (!live) acc = Math.min(acc, tickMs);
  const tSim = performance.now();
  while (live && acc >= tickMs) {
    acc -= tickMs;
    const bits = room?.state === 'playing' ? keyboard.bits() : 0;
    const seq = pred.tick(bits);
    if (seq !== null) conn.send({ t: 'in', s: seq, b: bits });
  }
  const t0 = performance.now();
  work.sim = Math.max(work.sim, t0 - tSim);
  sound.setAmbient(room?.state === 'playing' ? (pred.game?.arena.kind ?? null) : null);
  for (const e of track(pred.game)) {
    sound.play(e);
    fx.emit(e);
  }
  if (pred.game) fx.ambient(pred.game, (id) => pred.pos(id, acc / TICK_MS), dt / 1000);
  fx.update(Math.min(dt, 50) / 1000);
  pred.decay(dt / 1000);
  renderer.draw(pred, Math.min(1, acc / tickMs), fx, { rtt: conn.status === 'open' ? rtt : null });
  stats.frameMs = performance.now() - t0;
  work.draw = Math.max(work.draw, stats.frameMs);
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
  taken: 'open in another tab',
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
      me: me && {
        x: me.x,
        y: me.y,
        team: me.team,
        hp: me.hp,
        gun: me.gun,
        bazooka: me.bazooka,
        teleport: me.teleport,
        power: me.power,
        shield: me.shield,
        boost: me.boost,
        frozen: me.frozen,
        dizzy: me.dizzy,
        role: me.role,
      },
      ball: g.ball,
      crates: g.crates.map((c) => ({ x: c.x, y: c.y })),
      arena: g.arena.kind,
      bullets: g.bullets.length,
      blasts: g.blasts.map((b) => b.kind),
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
