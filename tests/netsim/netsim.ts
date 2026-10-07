/**
 * Netcode measurement harness: the real server rooms (`packages/server/src/rooms.ts`) and four real
 * client predictors (`packages/client/src/predict.ts`) play one match on a virtual clock, over modelled
 * links (delay, jitter, clumped uplinks, Wi-Fi stalls, clock drift). Every "human" is the sim's bot brain
 * reading its own client's predicted world, so kicks are frequent and the run is fully deterministic for
 * a given seed. Nothing here touches a real socket or timer.
 *
 * What it reports per client:
 * - ball corrections before smoothing (what `takeMaxCorrection` reports), per snapshot and per 2 s window
 *   (the window max is what prod telemetry logs as `ballCorrectionMaxPx`);
 * - the rendered ball against the server's true ball at the same moment: visual error, "jump" (how far a
 *   frame's rendered motion differs from the true motion) and "back slide" (rendered motion against the
 *   direction the ball really moves);
 * - pending inputs, server queue and starved ticks, like the prod stats.
 *
 * Run: `pnpm netsim [seconds] [seeds]` (tests/netsim/run.ts).
 */
import { decodeServerMessage, encode } from '../../packages/protocol/src/index';
import { createRooms } from '../../packages/server/src/rooms';
import { DEFAULT_SETTINGS, TICK_HZ, botInput, type Game, type Team } from '../../packages/sim/src/index';
import { createPredictor, type Predictor } from '../../packages/client/src/predict';
import { createTickClock } from '../../packages/client/src/clock';

const TICK_MS = 1000 / TICK_HZ;
const FRAME_MS = 1000 / 60;

export interface LinkSpec {
  /** Base one-way delay (ms), both directions. */
  oneWayMs: number;
  /** Uniform random extra per message (ms). */
  jitterMs: number;
  /** Uplink delivers in clumps: messages wait for the next flush, flush gaps uniform in [min, max] ms. */
  clumpMs?: [number, number];
  /** Wi-Fi stalls: on average every `everyMs` both directions hold everything for `ms` (uniform range). */
  stall?: { everyMs: number; ms: [number, number] };
  /** Fixed stalls [start, length] (ms). A silence over ~300 ms freezes the server's count for that client,
   * which leaves its queue that much deeper for good: how prod queues reached 4-6 over a long session. */
  stallAt?: Array<[number, number]>;
}

export interface ClientSpec {
  name: string;
  team: Team;
  link: LinkSpec;
  /** Client clock rate error in parts per million (positive: its ticks come faster than the server's). */
  driftPpm: number;
}

export interface SimOptions {
  seed: number;
  seconds: number;
  clients: ClientSpec[];
  /** Ignore the first part of the run (match start, queues settling). */
  warmupSeconds?: number;
}

export const DEFAULT_CLIENTS: ClientSpec[] = [
  // ~20 ms, steady link, but now and then a long Wi-Fi stall (the kind that left prod queues at 4-6).
  {
    name: 'steady20',
    team: 'red',
    link: { oneWayMs: 10, jitterMs: 3, stall: { everyMs: 25_000, ms: [250, 450] }, stallAt: [[3000, 420]] },
    driftPpm: 60,
  },
  // ~20 ms with frequent shorter stalls (prod p95 RTT 174 ms).
  {
    name: 'spiky20',
    team: 'blue',
    link: { oneWayMs: 11, jitterMs: 4, stall: { everyMs: 3_000, ms: [60, 180] }, stallAt: [[4000, 380]] },
    driftPpm: -40,
  },
  // ~100 ms.
  { name: 'far100', team: 'red', link: { oneWayMs: 47, jitterMs: 10, stallAt: [[2000, 340]] }, driftPpm: 30 },
  // Inputs arrive in clumps (prod: a third of ticks starved).
  { name: 'bursty', team: 'blue', link: { oneWayMs: 6, jitterMs: 2, clumpMs: [16, 70] }, driftPpm: -20 },
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Min-heap of timed events; ties run in insertion order. */
function createQueue() {
  type Ev = { at: number; n: number; fn: () => void };
  const h: Ev[] = [];
  let n = 0;
  const less = (a: Ev, b: Ev) => a.at < b.at || (a.at === b.at && a.n < b.n);
  return {
    push(at: number, fn: () => void) {
      h.push({ at, n: n++, fn });
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(h[i]!, h[p]!)) break;
        [h[i], h[p]] = [h[p]!, h[i]!];
        i = p;
      }
    },
    pop(): Ev | undefined {
      const top = h[0];
      const last = h.pop();
      if (h.length > 0 && last) {
        h[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < h.length && less(h[l]!, h[m]!)) m = l;
          if (r < h.length && less(h[r]!, h[m]!)) m = r;
          if (m === i) break;
          [h[i], h[m]] = [h[m]!, h[i]!];
          i = m;
        }
      }
      return top;
    },
    get size() {
      return h.length;
    },
  };
}

/** One direction of a TCP-like link: in order, delayed, maybe clumped or stalled. */
function createLink(spec: LinkSpec, rand: () => number, stalls: Array<[number, number]>, clumped: boolean) {
  let last = 0;
  let flushAt = 0;
  return (now: number): number => {
    let at = now + spec.oneWayMs + rand() * spec.jitterMs;
    for (const [from, to] of stalls) if (at >= from && at < to) at = to + spec.oneWayMs * 0.2;
    if (clumped && spec.clumpMs) {
      const [lo, hi] = spec.clumpMs;
      while (flushAt < at) flushAt += lo + rand() * (hi - lo);
      at = flushAt;
    }
    last = Math.max(last, at);
    return last;
  };
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export interface ClientReport {
  name: string;
  rttMs: number;
  pending: [number, number];
  serverQueue: [number, number];
  starvedPer300: number;
  /** Ball correction per snapshot: p50 / p95 / p99 / max (px), over snapshots with any correction. */
  ballCorr: [number, number, number, number];
  /** Prod-style: max ball correction per 2 s window, median / p95. */
  ballCorrWindow: [number, number];
  /** Own player correction per snapshot p95 / max. */
  meCorr: [number, number];
  /** Rendered ball vs the true ball at the same moment: mean / p95 / p99 (px). */
  ballErr: [number, number, number];
  /** Same, only while the ball is within touching distance of our own player (own-touch crispness). */
  ballErrNear: [number, number];
  /** Per-frame deviation of rendered from true motion: p99 / max (px), frames above 4 px per minute. */
  jump: [number, number, number];
  /** Rendered motion against the true motion: total px per minute, frames above 0.5 px per minute, max.
   * Includes plain latency (the real ball turned and we do not know yet). */
  backSlide: [number, number, number];
  /** Rendered motion against the motion the client itself simulates: the smoothing artefact alone
   * (an offset closing faster than the ball moves drags it backwards). Px per minute, frames above
   * 0.5 px per minute, max. */
  slideVsOwn: [number, number, number];
  /** Server → client bytes per second, and the share of it that is input relay. */
  downKBps: number;
  relayKBps: number;
}

export function runSim(o: SimOptions): ClientReport[] {
  const rand = rng(o.seed);
  const q = createQueue();
  let now = 0;
  const end = o.seconds * 1000;
  const warm = (o.warmupSeconds ?? 8) * 1000;
  const log = { info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<
    typeof createRooms
  >[0];
  const rooms = createRooms(log, { seed: () => o.seed, random: rand, now: () => now });

  // Server truth per tick: ball and every player.
  const truth = new Map<number, Map<string, [number, number]>>();
  const recordTruth = (g: Game) => {
    const m = new Map<string, [number, number]>([['ball', [g.ball.x, g.ball.y]]]);
    for (const p of g.players) m.set(p.id, [p.x, p.y]);
    truth.set(g.tick, m);
  };

  interface Sample {
    t: number;
    tick: number;
    alpha: number;
    ball: [number, number];
    /** The client's own simulated ball velocity (px/tick) at that frame. */
    v: [number, number];
  }
  interface Client {
    spec: ClientSpec;
    id: string;
    pred: Predictor;
    up: (now: number) => number;
    down: (now: number) => number;
    acc: number;
    clock: ReturnType<typeof createTickClock>;
    samples: Sample[];
    ballCorr: number[];
    meCorr: number[];
    windows: number[];
    windowMax: number;
    windowStart: number;
    pending: number[];
    queue: number[];
    starved: number;
    bytes: number;
    relayBytes: number;
  }

  const clients: Client[] = o.clients.map((spec, i) => {
    // Stalls are shared by both directions of one client (it is that client's Wi-Fi).
    const stalls: Array<[number, number]> = (spec.link.stallAt ?? []).map(([t, ms]) => [t, t + ms]);
    if (spec.link.stall) {
      const { everyMs, ms } = spec.link.stall;
      for (let t = -Math.log(1 - rand()) * everyMs; t < end; t += -Math.log(1 - rand()) * everyMs)
        stalls.push([t, t + ms[0] + rand() * (ms[1] - ms[0])]);
    }
    return {
      spec,
      id: `c${i}`,
      pred: createPredictor(),
      up: createLink(spec.link, rand, stalls, true),
      down: createLink(spec.link, rand, stalls, false),
      acc: 0,
      clock: createTickClock(),
      samples: [],
      ballCorr: [],
      meCorr: [],
      windows: [],
      windowMax: 0,
      windowStart: 0,
      pending: [],
      queue: [],
      starved: 0,
      bytes: 0,
      relayBytes: 0,
    };
  });

  const receive = (c: Client, raw: string) => {
    if (now >= warm) c.bytes += raw.length;
    if (now >= warm && raw.startsWith('{"t":"ri"')) c.relayBytes += raw.length;
    const m = decodeServerMessage(raw);
    if (!m) return;
    if (m.t === 'snap') {
      c.pred.snapshot(m.ack, m.g);
      c.clock.feedback(m.lead);
      const corr = c.pred.takeMaxCorrection();
      if (now < warm) return;
      if (corr.ball > 0.5) c.ballCorr.push(corr.ball);
      c.meCorr.push(corr.me);
      c.windowMax = Math.max(c.windowMax, corr.ball);
      c.pending.push(c.pred.pending);
      c.queue.push(m.q);
    } else if (m.t === 'ri') {
      c.pred.remoteInput(m.id, m.k, m.b);
      const corr = c.pred.takeMaxCorrection();
      if (now < warm) return;
      if (corr.ball > 0.5) c.ballCorr.push(corr.ball);
      c.windowMax = Math.max(c.windowMax, corr.ball);
    }
  };

  const settings = { ...DEFAULT_SETTINGS, minutes: 0, scoreLimit: 99 };
  const sendFor = (c: Client) => (raw: string) => {
    const at = c.down(now);
    q.push(at, () => receive(c, raw));
  };
  const host = clients[0]!;
  const room = rooms.create(host.id, host.spec.name, 'netsim', false, settings, sendFor(host));
  rooms.stop(); // the virtual clock drives ticks
  if (typeof room === 'string') throw new Error(room);
  for (const c of clients.slice(1)) rooms.join(room.code, c.id, c.spec.name, sendFor(c));
  for (const c of clients) {
    rooms.move(host.id, c.id, c.spec.team);
    c.pred.setMe(c.id);
  }
  rooms.start(host.id);
  recordTruth(room.game);

  // Server: 60 Hz on the reference clock.
  const prevStarved = new Map<string, number>();
  const serverTick = () => {
    rooms.tickAll();
    recordTruth(room.game);
    for (const c of clients) {
      const s = room.members.get(c.id)?.starved ?? 0;
      const before = prevStarved.get(c.id) ?? 0;
      if (now >= warm) c.starved += s >= before ? s - before : s;
      prevStarved.set(c.id, s);
    }
    q.push(now + TICK_MS, serverTick);
  };
  q.push(TICK_MS, serverTick);

  // Clients: one frame per display refresh of their own clock; same loop as main.ts.
  for (const c of clients) {
    const frameReal = FRAME_MS / (1 + c.spec.driftPpm / 1e6);
    const frame = () => {
      const dt = FRAME_MS;
      c.acc = Math.min(c.acc + dt, TICK_MS * 6);
      const tickMs = c.clock.tickMs();
      while (c.acc >= tickMs) {
        c.acc -= tickMs;
        const g = c.pred.game;
        const me = g?.players.find((p) => p.id === c.id);
        const bits = g && me ? botInput(g, me) : 0;
        const seq = c.pred.tick(bits);
        if (seq !== null) {
          const raw = encode({ t: 'in', s: seq, b: bits });
          const at = c.up(now);
          q.push(at, () => {
            const m = JSON.parse(raw) as { s: number; b: number };
            rooms.input(c.id, m.s, m.b);
          });
        }
      }
      c.pred.decay(dt / 1000);
      const g = c.pred.game;
      const alpha = Math.min(1, c.acc / tickMs);
      const b = c.pred.pos('ball', alpha);
      if (g && b && now >= warm)
        c.samples.push({ t: now, tick: g.tick, alpha, ball: [b.x, b.y], v: [g.ball.vx, g.ball.vy] });
      if (now >= warm) {
        if (c.windowStart === 0) c.windowStart = now;
        if (now - c.windowStart >= 2000) {
          c.windows.push(c.windowMax);
          c.windowMax = 0;
          c.windowStart = now;
        }
      }
      q.push(now + frameReal, frame);
    };
    q.push(rand() * FRAME_MS, frame);
  }

  while (q.size > 0) {
    const ev = q.pop()!;
    if (ev.at > end) break;
    now = ev.at;
    ev.fn();
  }

  const at = (tick: number, alpha: number, id: string): [number, number] | null => {
    const a = truth.get(tick - 1)?.get(id);
    const b = truth.get(tick)?.get(id);
    if (!a || !b) return null;
    return [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha];
  };
  const minutes = (end - warm) / 60_000;
  const r1 = (x: number) => Math.round(x * 10) / 10;

  return clients.map((c) => {
    const err: number[] = [];
    const errNear: number[] = [];
    const jump: number[] = [];
    let back = 0;
    let backFrames = 0;
    let backMax = 0;
    let bigJumps = 0;
    let own = 0;
    let ownFrames = 0;
    let ownMax = 0;
    let prev: { r: [number, number]; t: [number, number] } | null = null;
    for (const s of c.samples) {
      const t = at(s.tick, s.alpha, 'ball');
      if (!t) {
        prev = null;
        continue;
      }
      const e = Math.hypot(s.ball[0] - t[0], s.ball[1] - t[1]);
      err.push(e);
      const me = at(s.tick, s.alpha, c.id);
      if (me && Math.hypot(me[0] - t[0], me[1] - t[1]) < 45) errNear.push(e);
      if (prev) {
        const dr = [s.ball[0] - prev.r[0], s.ball[1] - prev.r[1]];
        const dt = [t[0] - prev.t[0], t[1] - prev.t[1]];
        const lenT = Math.hypot(dt[0]!, dt[1]!);
        // A goal reset or kickoff teleport is not a netcode artefact.
        if (lenT < 60 && Math.hypot(dr[0]!, dr[1]!) < 60) {
          const j = Math.hypot(dr[0]! - dt[0]!, dr[1]! - dt[1]!);
          jump.push(j);
          if (j > 4) bigJumps++;
          const lenV = Math.hypot(s.v[0], s.v[1]);
          if (lenV > 0.3) {
            const against = -(dr[0]! * s.v[0] + dr[1]! * s.v[1]) / lenV;
            if (against > 0) {
              own += against;
              ownMax = Math.max(ownMax, against);
              if (against > 0.5) ownFrames++;
            }
          }
          if (lenT > 0.3) {
            const against = -(dr[0]! * dt[0]! + dr[1]! * dt[1]!) / lenT;
            if (against > 0) {
              back += against;
              backMax = Math.max(backMax, against);
              if (against > 0.5) backFrames++;
            }
          }
        }
      }
      prev = { r: s.ball, t };
    }
    const mean = err.reduce((a, b) => a + b, 0) / Math.max(1, err.length);
    const serverTicks = ((end - warm) / 1000) * TICK_HZ;
    return {
      name: c.spec.name,
      rttMs: Math.round(c.spec.link.oneWayMs * 2 + c.spec.link.jitterMs),
      pending: [percentile(c.pending, 50), percentile(c.pending, 95)],
      serverQueue: [percentile(c.queue, 50), percentile(c.queue, 95)],
      starvedPer300: r1((c.starved / serverTicks) * 300),
      ballCorr: [
        r1(percentile(c.ballCorr, 50)),
        r1(percentile(c.ballCorr, 95)),
        r1(percentile(c.ballCorr, 99)),
        r1(Math.max(0, ...c.ballCorr)),
      ],
      ballCorrWindow: [r1(percentile(c.windows, 50)), r1(percentile(c.windows, 95))],
      meCorr: [r1(percentile(c.meCorr, 95)), r1(Math.max(0, ...c.meCorr))],
      ballErr: [r1(mean), r1(percentile(err, 95)), r1(percentile(err, 99))],
      ballErrNear: [r1(percentile(errNear, 50)), r1(percentile(errNear, 95))],
      jump: [r1(percentile(jump, 99)), r1(Math.max(0, ...jump)), r1(bigJumps / minutes)],
      backSlide: [r1(back / minutes), r1(backFrames / minutes), r1(backMax)],
      slideVsOwn: [r1(own / minutes), r1(ownFrames / minutes), r1(ownMax)],
      downKBps: r1(c.bytes / 1024 / ((end - warm) / 1000)),
      relayKBps: Math.round((c.relayBytes / 1024 / ((end - warm) / 1000)) * 100) / 100,
    };
  });
}
