import { describe, expect, it } from 'vitest';
import { decodeServerMessage } from '../../packages/protocol/src/index';
import { createRooms } from '../../packages/server/src/rooms';
import { createPredictor } from '../../packages/client/src/predict';
import { createEventTracker, type GameEvent } from '../../packages/client/src/events';
import { ITEM_KINDS, RIGHT, type Game, type ItemKind, type Settings } from '../../packages/sim/src/index';

const log = { info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<
  typeof createRooms
>[0];

/**
 * Hidden loot, end to end: the real server and the real predictor of player `a`, who runs into a crate.
 * The prediction opens it without knowing what is inside (neutral `crate` blast); the server draws the
 * item from its secret stream, and the next snapshot brings the effect. After that the prediction must
 * agree with the server exactly, and the events (sounds, particles) must fire once each.
 */
function run(kind: ItemKind, before?: (g: Game) => void) {
  const weights = Object.fromEntries(ITEM_KINDS.map((k) => [k, k === kind ? 100 : 0])) as Settings['weights'];
  const settings: Settings = { minutes: 3, scoreLimit: 5, crates: 'normal', weights, bots: false };
  const rooms = createRooms(log, { secret: () => 0x12345678 });
  const inbox: string[] = [];
  const room = rooms.create('a', 'A', 'R', false, settings, (r) => inbox.push(r));
  if (typeof room === 'string') throw new Error(room);
  rooms.stop();
  rooms.join(room.code, 'b', 'B', () => {});
  rooms.start('a');
  const g = room.game;
  g.nextCrate = 1e9; // only our crate
  const me = () => g.players.find((p) => p.id === 'a')!;
  before?.(g);
  // A crate in a's path, far enough that it is in a snapshot before a reaches it.
  g.crates.push({ id: 9999, x: me().x + 45, y: me().y });
  const pred = createPredictor();
  pred.setMe('a');
  const track = createEventTracker(() => 'a');
  const events: GameEvent[] = [];
  // A 3-tick (50 ms) link each way, so the prediction runs ahead of the server like in a real match.
  const LAG = 3;
  const down: Array<[number, string]> = [];
  const up: Array<[number, number, number]> = [];
  const fields = [
    'frozen',
    'boost',
    'gun',
    'teleport',
    'bazooka',
    'power',
    'slow',
    'hp',
    'shield',
    'x',
    'y',
  ] as const;
  const truth = new Map<number, Record<string, unknown>>();
  const record = () => truth.set(g.tick, Object.fromEntries(fields.map((k) => [k, me()[k]])));
  let predictedOpen = false;
  for (let t = 0; t < 120; t++) {
    const seq = pred.tick(RIGHT);
    if (seq !== null) up.push([t + LAG, seq, RIGHT]);
    if (pred.game?.blasts.some((b) => b.kind === 'crate')) predictedOpen = true;
    while (up.length > 0 && up[0]![0] <= t) {
      const [, s, b] = up.shift()!;
      rooms.input('a', s, b);
    }
    rooms.tickAll();
    record();
    for (const raw of inbox.splice(0)) down.push([t + LAG, raw]);
    while (down.length > 0 && down[0]![0] <= t) {
      const m = decodeServerMessage(down.shift()![1]);
      if (m?.t === 'snap') pred.snapshot(m.ack, m.g, m.h);
      else if (m?.t === 'ri') pred.remoteInput(m.id, m.k, m.b);
    }
    if (pred.game) events.push(...track(pred.game));
  }
  // Long after the opening, the prediction (resting on the revealed state) equals the server at that tick:
  // let the server catch up with our last inputs, then compare.
  const p = pred.game!.players.find((o) => o.id === 'a')!;
  const at = pred.game!.tick;
  for (const [, s, b] of up.splice(0)) rooms.input('a', s, b);
  while (g.tick < at) {
    rooms.tickAll();
    record();
  }
  const s = truth.get(at)!;
  for (const k of fields) {
    if (k === 'x' || k === 'y')
      expect(Math.abs(p[k] - (s[k] as number)), `${kind}: a.${k}`).toBeLessThan(0.1);
    else expect(p[k], `${kind}: a.${k}`).toBe(s[k]);
  }
  const items = events.filter((e) => e.type === 'item').map((e) => (e as { kind: string }).kind);
  return { predictedOpen, items, me: me(), opened: g.crates.length === 0 };
}

describe('gizli ganimet: gecikmeli uzlaşma', () => {
  it('mayın: itme, yavaşlama ve hasar sonraki snapshot ile gelir; olaylar birer kez', () => {
    const r = run('mine');
    expect(r.opened && r.predictedOpen).toBe(true);
    expect(r.me.hp).toBeLessThan(3);
    expect(r.items.filter((k) => k === 'crate')).toHaveLength(1);
    expect(r.items.filter((k) => k === 'mine')).toHaveLength(1);
  });

  it('buz: donma sonraki snapshot ile gelir', () => {
    const r = run('ice');
    expect(r.items.filter((k) => k === 'ice')).toHaveLength(1);
    expect(r.items.filter((k) => k === 'crate')).toHaveLength(1);
  });

  it('hız: güçlenme sonraki snapshot ile gelir', () => {
    const r = run('boost');
    expect(r.me.boost).toBeGreaterThan(0);
    expect(r.items.filter((k) => k === 'boost')).toHaveLength(1);
  });

  it('silah, eldeki ışınlanmanın yerini alır (sunucunun kararıyla)', () => {
    const r = run('gun', (g) => {
      g.players.find((p) => p.id === 'a')!.teleport = true;
    });
    expect(r.me.gun).toBeGreaterThan(0);
    expect(r.me.teleport).toBe(false);
    expect(r.items.filter((k) => k === 'gun')).toHaveLength(1);
    expect(r.items.filter((k) => k === 'crate')).toHaveLength(1);
  });
});
