import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  decodeClientMessage,
  decodeReplays,
  encodeReplays,
  isReplay,
  type GoalClip,
  type ReplayBundle,
} from '../../packages/protocol/src/index';
import { defaultWeights, type Settings } from '../../packages/sim/src/index';
import { createLogger, loadConfig } from '../../packages/server/src/app';
import { createRooms } from '../../packages/server/src/rooms';
import { playClip, verifyClip } from '../../packages/client/src/replay';

const silent = new Writable({ write: (_c, _e, cb) => cb() });

/** A real room (server code) with people pressing keys at random, crates on, someone leaving and someone
 * dropping mid-match: the match's goals as the server hands them out at the final whistle. */
function playMatch(seed: number, host = 'Deniz'): { bundle: ReplayBundle; bytes: Uint8Array; ticks: number } {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000;
  const rooms = createRooms(createLogger(loadConfig({ NODE_ENV: 'test' }), { stdout: silent }), {
    seed: () => seed,
    secret: () => Math.floor(rnd() * 0x100000000),
  });
  let got: Uint8Array | null = null;
  const send = (raw: string | Uint8Array) => {
    if (typeof raw !== 'string' && isReplay(raw)) got = raw;
    return true;
  };
  const settings: Settings = {
    minutes: 2,
    scoreLimit: 3,
    crates: 'chaos',
    weights: defaultWeights(),
    bots: true,
  };
  const room = rooms.create('h1', host, 'Test', false, settings, send);
  if (typeof room === 'string') throw new Error(room);
  rooms.join(room.code, 'h2', 'Ece', send);
  rooms.join(room.code, 'h3', 'Kaan', send);
  rooms.move('h1', 'h2', 'red');
  rooms.move('h1', 'h3', 'blue');
  // Red: Deniz and Ece; blue: Kaan and a bot. Kaan leaves (two bots), Ece drops (keys let go).
  expect(room.game.players.map((p) => `${p.id}:${p.team}`).sort()).toEqual([
    'bot-2:blue',
    'h1:red',
    'h2:red',
    'h3:blue',
  ]);
  expect(rooms.start('h1')).toBeNull();
  const seq = new Map<string, number>();
  const bits = new Map<string, number>();
  let ticks = 0;
  let kickoff = -1;
  for (; ticks < 20_000 && !got; ticks++) {
    for (const id of ['h1', 'h2', 'h3']) {
      if (!rooms.isMember(id) || rooms.isAway(id)) continue;
      if (rnd() < 0.08) bits.set(id, Math.floor(rnd() * 64));
      const n = (seq.get(id) ?? 0) + 1;
      seq.set(id, n);
      // Now and then an input goes missing (a stand-in plays its tick) or two arrive at once.
      if (rnd() < 0.03) continue;
      rooms.input(id, n, bits.get(id) ?? 0);
    }
    // Shortly after the 1st and 2nd goals' kickoffs, inside the next goal's clip as a rule.
    const g = room.game;
    if (g.phase === 'kickoff' && g.phaseT === 0) kickoff = ticks;
    const goals = g.score[0] + g.score[1];
    if (ticks === kickoff + 120 && goals === 1) rooms.leave('h3'); // bots take the side
    if (ticks === kickoff + 60 && goals === 2) rooms.disconnect('h2'); // keys let go, slot kept
    rooms.tickAll();
  }
  rooms.stop();
  expect(got).not.toBeNull();
  const decoded = decodeReplays(got!);
  if (!decoded.ok) throw new Error(decoded.why);
  return { bundle: decoded.bundle, bytes: got!, ticks };
}

describe('gol tekrarları', () => {
  it('sunucunun kestiği her gol istemcide aynen oynar (hash kontrolleri tutar, gol aynı tickte)', async () => {
    const { bundle, bytes, ticks } = playMatch(7);
    if (process.env.REPLAY_INFO)
      (await import('node:fs')).writeFileSync(
        process.env.REPLAY_INFO,
        JSON.stringify([
          ticks,
          bytes.length,
          bundle.score,
          bundle.goals.map((c) => ({
            by: c.by,
            a: c.assist,
            og: c.ownGoal,
            s: c.second,
            len: c.end - c.start,
            goalAt: c.tick - c.start,
            in: c.inputs.length / 3,
            loot: c.loot.length / 2,
            jumps: c.jumps.length,
            h: c.hashes.length / 2,
          })),
        ]),
      );
    expect(bundle.goals.length).toBeGreaterThan(0);
    expect(bundle.goals.length).toBe(bundle.score[0] + bundle.score[1]);
    // Someone left or dropped during a clip: it jumps to the state the server had then.
    expect(bundle.goals.some((c) => c.jumps.length > 0)).toBe(true);
    expect(bundle.goals.some((c) => c.loot.length > 0)).toBe(true);
    for (const clip of bundle.goals) {
      const run = playClip(clip);
      expect(run).not.toBeNull();
      // From 10 s before (or the kickoff) to the next kickoff.
      expect(run!.goalAt).toBeLessThanOrEqual(10 * 60 + 60);
      expect(run!.length - run!.goalAt).toBeGreaterThan(0);
      const score = () => run!.game.score[0] + run!.game.score[1];
      const before = score();
      while (run!.at < run!.goalAt) run!.advance();
      expect(score()).toBe(before + 1);
      while (run!.advance());
      expect(run!.at).toBe(run!.length);
      // Seeking lands on the same state as playing there.
      run!.seek(run!.goalAt - 30);
      const x = run!.game.ball.x;
      run!.seek(0);
      while (run!.at < run!.goalAt - 30) run!.advance();
      expect(run!.game.ball.x).toBe(x);
    }
    // Small enough to keep ten matches in the browser and to send everyone at the whistle.
    expect(bytes.length / bundle.goals.length).toBeLessThan(12_000);
  }, 60_000);

  it('her arenada ve birçok maçta tekrarlar sunucuyla aynı oynar', () => {
    const arenas = new Set<string>();
    for (let seed = 1; seed <= 12; seed++)
      for (const clip of playMatch(seed * 101).bundle.goals) {
        arenas.add(clip.arena);
        expect(verifyClip(clip), `seed ${seed * 101}, ${clip.arena}, tick ${clip.tick}`).toBe(true);
      }
    expect(arenas.size).toBeGreaterThanOrEqual(5);
  }, 120_000);

  it('emojili takma ad (sınırda yarım kalan emoji) tekrarları bozmaz', () => {
    // As the server gets it: cleaned by the protocol (16 UTF-16 units: the emoji would be cut in half).
    const msg = decodeClientMessage(JSON.stringify({ t: 'join', code: 'ABCD', name: 'abcdefghijklmno😀' }));
    const name = msg?.t === 'join' ? msg.name : '';
    expect(name).toBe('abcdefghijklmno');
    for (const clip of playMatch(7, name).bundle.goals) expect(verifyClip(clip)).toBe(true);
  }, 60_000);

  it('oyunu kilitleyecek ya da boş klipli dosyayı reddeder', () => {
    const { bundle } = playMatch(7);
    const tweak = (f: (c: GoalClip & { state: Record<string, unknown> }) => void) => {
      const b = structuredClone(bundle);
      f(b.goals[0] as GoalClip & { state: Record<string, unknown> });
      return decodeReplays(encodeReplays(b));
    };
    expect(tweak(() => {}).ok).toBe(true);
    // A score limit no room can have would make the arena plan endless.
    expect(tweak((c) => ((c.state.settings as { scoreLimit: number }).scoreLimit = 1e9))).toEqual({
      ok: false,
      why: 'broken',
    });
    expect(tweak((c) => (c.state.arenaPlan = []))).toEqual({ ok: false, why: 'broken' });
    // Too much in it to step cheaply, wherever it sits (here: puddle parts).
    expect(
      tweak((c) => {
        const arena = c.state.arena as { puddles: unknown[] };
        arena.puddles = [{ x: 0, y: 0, born: 0, life: 9e5, parts: Array(5000).fill({ dx: 0, dy: 0, r: 9 }) }];
      }),
    ).toEqual({ ok: false, why: 'broken' });
    expect(tweak((c) => (c.state.crates = Array(5000).fill({ id: 1, x: 0, y: 0 })))).toEqual({
      ok: false,
      why: 'broken',
    });
    expect(tweak((c) => (c.end = c.tick))).toEqual({ ok: false, why: 'broken' });
  }, 60_000);

  it('tekrarda bir tuş bile değişirse oynatılmaz', () => {
    const { bundle } = playMatch(11);
    // A clip with keys pressed well before the goal; those presses changed (direction keys swapped).
    const early = (c: (typeof bundle.goals)[number]) =>
      [...Array(c.inputs.length / 3).keys()].filter(
        (i) => c.inputs[i * 3]! < c.tick - c.start - 60 && c.inputs[i * 3 + 2]! > 0,
      );
    const clip = bundle.goals.find((c) => early(c).length >= 3)!;
    expect(verifyClip(clip)).toBe(true);
    const bad = structuredClone(clip);
    for (const i of early(clip)) bad.inputs[i * 3 + 2] = bad.inputs[i * 3 + 2]! ^ 0b1111;
    expect(verifyClip(bad)).toBe(false);
  }, 60_000);

  it('dosya: başka sürümde yapılmışsa "sürüm", bozuksa "bozuk"', () => {
    const { bundle } = playMatch(7);
    const bytes = encodeReplays(bundle);
    expect(decodeReplays(bytes).ok).toBe(true);
    const old = bytes.slice();
    old[4] = old[4]! - 1; // the version right after the magic
    expect(decodeReplays(old)).toEqual({ ok: false, why: 'version' });
    expect(decodeReplays(bytes.slice(0, bytes.length - 10))).toEqual({ ok: false, why: 'broken' });
    expect(decodeReplays(new TextEncoder().encode('hello'))).toEqual({ ok: false, why: 'broken' });
  }, 60_000);
});
