// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addPlayer, createGame, removePlayer, type Game } from '@crateball/sim';
import { ACHIEVEMENTS, COUNTERS, reached } from '../src/achievements';
import { matchCounts, recordMatch } from '../src/steam';

/** A finished 2–1 for red: `me` (red keeper) scored once, saved twice and passed three times. */
function finished(blueHuman = true): Game {
  const g = createGame(1);
  const me = addPlayer(g, 'me', 'Ayşe', 'red');
  addPlayer(g, 'bot', 'Bot', 'red', true);
  addPlayer(g, 'op', 'Can', 'blue', !blueHuman);
  me.goals = 1;
  me.stats.saves = 2;
  me.stats.passes = 3;
  g.score = [2, 1];
  g.phase = 'over';
  g.tick = 900;
  g.phaseT = 2;
  return g;
}

describe('başarım listesi', () => {
  it('her sayaçta 5…350 basamakları, golde ve galibiyette bir de ilki var', () => {
    expect(ACHIEVEMENTS).toHaveLength(38);
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(38);
    expect(ACHIEVEMENTS.filter((a) => a.counter === 'saves').map((a) => a.at)).toEqual([
      5, 10, 50, 100, 150, 200, 250, 300, 350,
    ]);
    expect(ACHIEVEMENTS.filter((a) => a.counter === 'goals').map((a) => a.at)[0]).toBe(1);
    expect(ACHIEVEMENTS.find((a) => a.id === 'FIRST_WIN')?.name).toBe('First Win');
    for (const a of ACHIEVEMENTS) {
      expect(a.id).toMatch(/^[A-Z0-9_]+$/);
      expect(a.name.length).toBeGreaterThan(0);
    }
  });

  it('toplamın ulaştığı her başarım açılır', () => {
    expect(reached({ goals: 0 })).toEqual([]);
    expect(reached({ goals: 1 })).toEqual(['FIRST_GOAL']);
    expect(reached({ goals: 12, wins: 5 })).toEqual([
      'FIRST_GOAL',
      'GOALS_5',
      'GOALS_10',
      'FIRST_WIN',
      'WINS_5',
    ]);
    expect(reached({ passes: 4 })).toEqual([]);
  });
});

describe('maçın sayılması', () => {
  it('rakipte insan varken benim sayılarım ve galibiyet', () => {
    expect(matchCounts(finished(), 'me')).toEqual({ goals: 1, saves: 2, passes: 3, wins: 1 });
  });

  it('rakipte yalnızca bot varsa, maç bitmediyse ya da sahada değilsem sayılmaz', () => {
    expect(matchCounts(finished(false), 'me')).toBeNull();
    const g = finished();
    g.phase = 'play';
    expect(matchCounts(g, 'me')).toBeNull();
    expect(matchCounts(finished(), 'someone-watching')).toBeNull();
  });

  it('maç içinde ayrılan insan rakip de sayılır; kaybedene galibiyet yazılmaz', () => {
    const g = finished();
    removePlayer(g, 'op');
    expect(matchCounts(g, 'me')?.wins).toBe(1);
    g.score = [1, 2];
    expect(matchCounts(g, 'me')?.wins).toBe(0);
  });
});

describe('Steam’e yazma', () => {
  beforeEach(() => localStorage.clear());

  const steam = (totals: Record<string, number>) =>
    vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'steam_add_stats') return totals;
      return (args!.names as string[]).filter((n) => n !== 'FIRST_GOAL');
    });

  it('maçın sayılarını ekler, toplamların ulaştığı başarımları açar', async () => {
    const invoke = steam({
      [COUNTERS.goals]: 5,
      [COUNTERS.saves]: 2,
      [COUNTERS.passes]: 3,
      [COUNTERS.wins]: 1,
    });
    expect(await recordMatch(finished(), 'me', 'ABCD', invoke)).toEqual(['GOALS_5', 'FIRST_WIN']);
    expect(invoke).toHaveBeenNthCalledWith(1, 'steam_add_stats', {
      add: { GOALS: 1, KEEPER_SAVES: 2, PASSES: 3, WINS: 1 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'steam_unlock', {
      names: ['FIRST_GOAL', 'GOALS_5', 'FIRST_WIN'],
    });
  });

  it('aynı maç iki kez yazılmaz (yeniden yükleme, tekrar gelen son snapshot)', async () => {
    const invoke = steam({ GOALS: 1 });
    await recordMatch(finished(), 'me', 'ABCD', invoke);
    await recordMatch(finished(), 'me', 'ABCD', invoke);
    expect(invoke).toHaveBeenCalledTimes(2);
    const next = finished();
    next.matches++;
    await recordMatch(next, 'me', 'ABCD', invoke);
    expect(invoke).toHaveBeenCalledTimes(4);
    // The same whistle again while the first one is still on its way to Steam.
    const again = finished();
    again.matches += 2;
    await Promise.all([recordMatch(again, 'me', 'ABCD', invoke), recordMatch(again, 'me', 'ABCD', invoke)]);
    expect(invoke).toHaveBeenCalledTimes(6);
  });

  it('Steam yoksa ya da hata verirse sessizce geçer; sayılmayan maç Steam’e gitmez', async () => {
    expect(await recordMatch(finished(), 'me', 'ABCD', undefined)).toEqual([]);
    const failing = vi.fn(async () => {
      throw new Error('no steam');
    });
    expect(await recordMatch(finished(), 'me', 'ABCD', failing)).toEqual([]);
    // Nothing was added, so the same match may be sent again (a reload once Steam is back).
    const back = steam({ GOALS: 1 });
    expect(await recordMatch(finished(), 'me', 'ABCD', back)).toEqual([]);
    expect(back).toHaveBeenCalledTimes(2);
    const invoke = steam({});
    expect(await recordMatch(finished(false), 'me', 'WXYZ', invoke)).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
