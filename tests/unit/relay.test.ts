import { describe, expect, it } from 'vitest';
import { decodeServerMessage } from '../../packages/protocol/src/index';
import { RELAY_BURST, STAND_IN_TICKS, createRooms } from '../../packages/server/src/rooms';
import { createPredictor } from '../../packages/client/src/predict';
import { KICK, MATCH, RIGHT, defaultWeights, type Game, type Settings } from '../../packages/sim/src/index';

/**
 * The real server rooms and real client predictors, wired with zero latency. Observer `a` sends an
 * (empty) input every tick, so right after each snapshot it has nothing pending and its prediction of the
 * next step depends only on what it believes the others play: relays, and the snapshot's held inputs.
 */
const settings: Settings = {
  minutes: 3,
  scoreLimit: 5,
  crates: 'off',
  weights: defaultWeights(),
  bots: false,
};
const log = { info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<
  typeof createRooms
>[0];

/** What a misprediction of someone's keys changes: their input, positions, the ball. Snapshots round to
 * 1/1000 px, so positions agree to a tolerance, inputs exactly. */
function agree(p: Game, s: Game, what: string) {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.1;
  for (const o of s.players) {
    const q = p.players.find((x) => x.id === o.id);
    expect(q?.input, `${what}: ${o.id}.input`).toBe(o.input);
    expect(near(q!.x, o.x) && near(q!.y, o.y), `${what}: ${o.id} position`).toBe(true);
  }
  const b = p.ball;
  const sb = s.ball;
  expect(near(b.x, sb.x) && near(b.y, sb.y) && near(b.vx, sb.vx) && near(b.vy, sb.vy), `${what}: ball`).toBe(
    true,
  );
}

function setup() {
  const rooms = createRooms(log);
  const inbox: Record<string, string[]> = { a: [], b: [], c: [] };
  const sendTo = (id: string) => (raw: string) => inbox[id]!.push(raw);
  const room = rooms.create('a', 'A', 'R', false, settings, sendTo('a'));
  if (typeof room === 'string') throw new Error(room);
  rooms.stop();
  rooms.join(room.code, 'b', 'B', sendTo('b'));
  rooms.start('a');
  const observers = new Map<string, ReturnType<typeof createPredictor>>();
  const observe = (id: string) => {
    const p = createPredictor();
    p.setMe(id);
    observers.set(id, p);
    return p;
  };
  const deliver = () => {
    for (const [id, p] of observers)
      for (const raw of inbox[id]!.splice(0)) {
        const m = decodeServerMessage(raw);
        if (m?.t === 'snap') p.snapshot(m.ack, m.g, m.h);
        else if (m?.t === 'ri') p.remoteInput(m.id, m.k, m.b);
      }
  };
  const seqs: Record<string, number> = {};
  /** One tick: every observer that is a player sends an empty input, the server steps, messages land.
   * One tick after each snapshot, every observer must agree with the server exactly. */
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      for (const [id, p] of observers) {
        const seq = p.tick(0);
        if (seq !== null && room.game.players.some((o) => o.id === id)) rooms.input(id, (seqs[id] = seq), 0);
      }
      rooms.tickAll();
      deliver();
      if (room.game.tick % 2 === 1)
        for (const [id, p] of observers)
          if (p.game && p.game.tick === room.game.tick)
            agree(p.game, room.game, `observer ${id} at tick ${room.game.tick}`);
    }
  };
  return { rooms, room, inbox, sendTo, observe, deliver, tick };
}

describe('aktarım + tahmin, uçtan uca', () => {
  it('ilk girdisi alınmadan kopan oyuncunun duyurulmuş vuruşu iptal edilir (hayalet vuruş yok)', () => {
    const { rooms, observe, tick, deliver, room } = setup();
    observe('a');
    tick(2);
    // b's first inputs, queued with a kick ahead, announced to a…
    for (let s = 1; s <= 6; s++) rooms.input('b', s, s >= 4 ? KICK : RIGHT);
    deliver();
    rooms.disconnect('b'); // …and gone before any of them was taken
    tick(12);
    rooms.reattach('b', () => {});
    tick(12);
    expect(room.game.players.find((p) => p.id === 'b')!.input).toBe(0);
  });

  it('yeniden bağlanma aynı tick içinde olsa da (bütçe bitmişken bile) duyurular iptal edilir', () => {
    const { rooms, room, observe, tick, deliver } = setup();
    observe('a');
    tick(2);
    for (let s = 1; s <= 6; s++) rooms.input('b', s, s >= 4 ? KICK : RIGHT);
    deliver();
    room.members.get('b')!.relayTokens = 0;
    rooms.disconnect('b');
    rooms.reattach('b', () => {});
    tick(12);
  });

  it('bütçe yüzünden aktarılmayan bırakış snapshot ile düzelir (eski vuruş yeniden oynanmaz)', () => {
    const { rooms, room, observe, tick } = setup();
    observe('a');
    let s = 0;
    rooms.input('b', ++s, KICK);
    tick(3);
    // Budget gone, then b releases: nothing relayed, the snapshot must win over the relayed KICK.
    room.members.get('b')!.relayTokens = 0;
    for (let i = 0; i < 21; i++) rooms.input('b', ++s, 0);
    tick(10);
    expect(room.members.get('b')!.relayTokens).toBeLessThan(RELAY_BURST);
  });

  it('başlama vuruşunda basılı tuş tahminde sürer; maç ortasında gelen izleyici de bilir', () => {
    const { rooms, room, observe, tick, sendTo } = setup();
    observe('a');
    // b's next sequence is always the next one the server expects (it ticks in step with it).
    const holdB = () => rooms.input('b', room.members.get('b')!.ack + 1, RIGHT);
    holdB();
    tick(4);
    // A spectator arrives (fresh client: room, relays, then its first snapshot).
    rooms.join(room.code, 'c', 'C', sendTo('c'));
    observe('c');
    for (let i = 0; i < 6; i++) {
      holdB();
      tick();
    }
    // A goal pause about to end (set just before a snapshot tick, so clients see it): two steps later
    // everyone is reset for the kickoff, `input` zeroed in the state while b still holds RIGHT.
    if (room.game.tick % 2 === 0) {
      holdB();
      tick();
    }
    room.game.phase = 'goal';
    room.game.phaseT = MATCH.goalPause - 3;
    for (let i = 0; i < 10; i++) {
      holdB();
      tick();
    }
    expect(room.game.phase).toBe('kickoff');
    expect(room.game.players.find((p) => p.id === 'b')!.input).toBe(RIGHT);
  });

  it('uzun sessizlikten sonra aynı tuş: tahmin sunucuyla aynı kalır', () => {
    const { rooms, room, observe, tick } = setup();
    observe('a');
    rooms.input('b', 1, RIGHT);
    tick(STAND_IN_TICKS + 6);
    rooms.input('b', room.members.get('b')!.ack + 1, RIGHT);
    tick(6);
  });

  it('sürekli selde aktarım işi sınırlı kalır (mesaj ve süre)', () => {
    const { rooms, room, inbox } = setup();
    let s = 0;
    rooms.input('b', ++s, 0);
    rooms.tickAll();
    const t0 = performance.now();
    let relays = 0;
    // 5 s of a client sending 12 inputs per tick, every one a different key (far past the rate limit).
    for (let t = 0; t < 300; t++) {
      for (let i = 0; i < 12; i++) rooms.input('b', ++s, s % 2 ? KICK : RIGHT);
      rooms.tickAll();
      relays += inbox.a!.splice(0).filter((r) => r.startsWith('{"t":"ri"')).length;
    }
    const ms = performance.now() - t0;
    // Budget: the burst plus 20/s, and at most one forced cancel per budgeted announcement.
    expect(relays).toBeLessThanOrEqual(2 * (RELAY_BURST + 20 * 5));
    expect(ms).toBeLessThan(1000);
    expect(room.members.get('b')!.queue.length).toBeLessThanOrEqual(20);
  });
});

describe('ilk snapshot öncesi aktarım ve tick süresi', () => {
  it('ilk snapshot gelmeden gelen aktarım saklanır, zamanı gelince oynanır', () => {
    const { rooms, room, observe, tick, sendTo } = setup();
    observe('a');
    tick(2);
    rooms.input('b', room.members.get('b')!.ack + 1, 0);
    tick(1);
    // A fresh client (reload, spectator) hears about a change for a later tick before its first snapshot.
    const c = createPredictor();
    c.setMe('c');
    rooms.join(room.code, 'c', 'C', sendTo('c'));
    c.remoteInput('b', room.game.tick + 3, RIGHT);
    const snap = { ...room.game, players: room.game.players.map((p) => ({ ...p })) };
    c.snapshot(0, snap, { b: 0 });
    for (let i = 0; i < 4; i++) c.tick(0);
    expect(c.game!.players.find((p) => p.id === 'b')!.input).toBe(RIGHT);
  });

  it('aktarım denetimi ve yeniden gönderim tick süresine sayılır', () => {
    const rooms = createRooms(log);
    const slow = (raw: string) => {
      if (!raw.startsWith('{"t":"ri"')) return;
      const until = performance.now() + 8;
      while (performance.now() < until);
    };
    const room = rooms.create('a', 'A', 'R', false, settings, slow);
    if (typeof room === 'string') throw new Error(room);
    rooms.stop();
    rooms.join(room.code, 'b', 'B', () => {});
    rooms.start('a');
    room.stepMsMax = 0;
    rooms.input('b', 1, RIGHT);
    room.members.get('b')!.relayDirty = true; // a resend falls due in the next tick
    rooms.tickAll();
    expect(room.stepMsMax).toBeGreaterThanOrEqual(8);
  });
});

describe('maç yeniden başlarken', () => {
  it('ilk snapshot önceki maçtan basılı kalmış tuşları taşımaz', () => {
    const rooms = createRooms(log);
    const inbox: string[] = [];
    const room = rooms.create('a', 'A', 'R', false, settings, (r) => inbox.push(r));
    if (typeof room === 'string') throw new Error(room);
    rooms.stop();
    rooms.join(room.code, 'b', 'B', () => {});
    rooms.start('a');
    for (let s = 1; s <= 5; s++) {
      rooms.input('b', s, 56); // KICK | USE | RIGHT held
      rooms.tickAll();
    }
    expect(rooms.stopMatch('a')).toBeNull();
    inbox.length = 0;
    expect(rooms.start('a')).toBeNull();
    const first = inbox.map((r) => decodeServerMessage(r)).find((m) => m?.t === 'snap');
    expect(first?.t === 'snap' && first.h.b).toBe(0);
    expect(room.game.players.find((p) => p.id === 'b')!.input).toBe(0);
  });
});
