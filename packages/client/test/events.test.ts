import { describe, expect, it } from 'vitest';
import { addPlayer, cloneGame, createGame } from '@crateball/sim';
import { createEventTracker } from '../src/events';

describe('olaylar', () => {
  it('başka oyuncunun ping kadar geç gelen vuruşu bir kez ses/efekt üretir', () => {
    const track = createEventTracker();
    const g = createGame(1);
    g.phase = 'play';
    const other = addPlayer(g, 'o', 'O', 'blue');
    g.tick = 100;
    track(g);
    const later = cloneGame(g);
    later.tick = 102;
    later.players[0]!.kickTick = 88; // 14 tick önce vurmuş, bize şimdi ulaştı
    expect(track(later).filter((e) => e.type === 'kick')).toHaveLength(1);
    const again = cloneGame(later);
    again.tick = 104;
    expect(track(again).filter((e) => e.type === 'kick')).toHaveLength(0);
    expect(other.id).toBe('o');
  });
  it('öldüren isabet de vurulma olayı üretir (son görülen konumda)', () => {
    const track = createEventTracker();
    const g = createGame(1);
    const p = addPlayer(g, 'v', 'V', 'red');
    p.x = 50;
    track(g);
    const dead = cloneGame(g);
    dead.tick++;
    Object.assign(dead.players[0]!, { hp: 0, dead: 180, x: 9999, y: 9999 });
    expect(track(dead)).toContainEqual({ type: 'hit', x: 50, y: p.y, team: 'red', killed: true });
  });
});

describe('olaylar (inceleme düzeltmeleri)', () => {
  const withBlast = (g: ReturnType<typeof createGame>, x: number) => {
    const c = cloneGame(g);
    c.blasts.push({ x, y: 0, kind: 'mine', t: 30 });
    return c;
  };
  it('geri sarmayla kaybolup geri gelen patlama iki kez çalmaz (#10)', () => {
    const track = createEventTracker();
    const g = createGame(1);
    g.tick = 100;
    track(g);
    const shown = withBlast(g, 50);
    shown.tick = 101;
    expect(track(shown).filter((e) => e.type === 'item')).toHaveLength(1);
    const corrected = cloneGame(g);
    corrected.tick = 102; // snapshot says: not yet
    track(corrected);
    const replayed = withBlast(g, 51);
    replayed.tick = 101 + 1;
    replayed.blasts[0]!.t = 29;
    expect(track(replayed).filter((e) => e.type === 'item')).toHaveLength(0);
  });
  it('aynı tick’te iki farklı yerde açılan aynı kutu iki efekt verir (#10)', () => {
    const track = createEventTracker();
    const g = createGame(1);
    g.tick = 100;
    track(g);
    const two = withBlast(withBlast(g, -200), 200);
    two.tick = 101;
    expect(track(two).filter((e) => e.type === 'item')).toHaveLength(2);
  });
});

describe('kilitlenme uyarısı', () => {
  it('silahlı bir rakip (bot dahil) beni hedef alınca bir kez uyarır', () => {
    let meId = 'me';
    const track = createEventTracker(() => meId);
    const g = createGame(1);
    g.phase = 'play';
    const me = addPlayer(g, 'me', 'Me', 'red');
    const bot = addPlayer(g, 'bot', 'Bot', 'blue', true);
    Object.assign(me, { x: 0, y: 0 });
    Object.assign(bot, { x: 200, y: 0, gun: 0 });
    g.ball = { x: 0, y: 150, vx: 0, vy: 0 };
    g.tick = 10;
    track(g);
    const armed = cloneGame(g);
    armed.tick = 11;
    armed.players[1]!.gun = 6;
    expect(track(armed).filter((e) => e.type === 'locked')).toHaveLength(1);
    const still = cloneGame(armed);
    still.tick = 12;
    expect(track(still).filter((e) => e.type === 'locked')).toHaveLength(0);
    meId = 'nobody';
  });
});
