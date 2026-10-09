// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATCH, TICK_HZ, addPlayer, createGame, type Game } from '@crateball/sim';
import { createResults } from '../src/results';

/** A finished 2–0: red `a` scored twice, blue's bot keeper made a save. */
function finished(endTick = 500): Game {
  const g = createGame(1);
  const a = addPlayer(g, 'a', 'Ayşe', 'red');
  const b = addPlayer(g, 'b', '<img src=x onerror=alert(1)>', 'blue', true);
  a.goals = 2;
  a.stats.touches = 30;
  a.stats.goodCrates = 2;
  a.stats.badCrates = 1;
  b.stats.touches = 10;
  b.stats.saves = 1;
  g.score = [2, 0];
  g.phase = 'over';
  g.tick = endTick + 3;
  g.phaseT = 3;
  return g;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const rowOf = (name: string) =>
  [...document.querySelectorAll<HTMLTableRowElement>('#results tbody tr')].find(
    (tr) => tr.querySelector('.pname')?.textContent === name,
  )!;

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('maç sonu ekranı', () => {
  it('kazananı, iki takımı, MVP’yi ve benim satırımı gösterir', () => {
    const r = createResults();
    r.show(finished(), 'a');
    expect(r.visible).toBe(true);
    expect($('#results')?.className).toBe('red');
    expect($('#results h1')?.textContent).toBe('RED WINS!');
    expect($('#results .why')?.textContent).toBe('2 – 0  ·  FIRST TO 5');
    const me = rowOf('Ayşe');
    expect(me.className).toBe('me');
    expect(me.querySelector('.mvp')?.textContent).toBe('MVP');
    // Points, goals (scored / own), assists, shots, passes, defence, saves, crates (good / bad), damage,
    // deaths.
    expect([...me.querySelectorAll('td')].slice(1).map((td) => td.textContent)).toEqual([
      '6',
      '2/0',
      '0',
      '0/0',
      '0',
      '0/0',
      '0',
      '2/1',
      '0/0',
      '0',
    ]);
    // Names are text, never markup.
    const bot = rowOf('<img src=x onerror=alert(1)>');
    expect(bot.closest('.rteam')?.classList.contains('blue')).toBe(true);
    expect(bot.querySelector('img')).toBeNull();
    expect(bot.querySelector('.tag')?.textContent).toBe('BOT');
  });

  it('Back to lobby ve Esc kapatır; aynı maç geri açılmaz, yenisi açılır', () => {
    const r = createResults();
    r.show(finished(500), 'a');
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Back to lobby')!.click();
    expect(r.visible).toBe(false);
    // Snapshots of the same final whistle keep coming for a moment: they must not bring it back.
    r.show(finished(500), 'a');
    expect(r.visible).toBe(false);
    r.show(finished(900), 'a');
    expect(r.visible).toBe(true);
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(r.visible).toBe(false);
  });

  it('başka odada aynı anda biten maç da açılır; açılınca sohbet kutusu bırakılır', () => {
    const r = createResults();
    const chat = document.createElement('input');
    document.body.append(chat);
    r.show(finished(500), 'a');
    r.hide();
    r.forget(); // left the room
    chat.focus();
    r.show(finished(500), 'a');
    expect(r.visible).toBe(true);
    expect(document.activeElement).not.toBe(chat);
    expect(document.activeElement?.textContent).toBe('Back to lobby');
    // Tab cannot get back to it: everything behind the screen is inert until it closes.
    expect(chat.hasAttribute('inert')).toBe(true);
    r.hide();
    expect(chat.hasAttribute('inert')).toBe(false);
  });

  it('süresi dolunca kendiliğinden kapanır', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const r = createResults();
    r.show(finished(), null);
    const ms = (MATCH.resultsShow / TICK_HZ) * 1000;
    expect($('.countdown')?.textContent).toBe(`Closes in ${ms / 1000} s`);
    vi.advanceTimersByTime(ms - 1000);
    expect(r.visible).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(r.visible).toBe(false);
  });

  it('gol tekrarı butonu: gol sayısıyla çıkar, izlerken geri sayım durur', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const r = createResults();
    const watch = vi.fn();
    // The goals may arrive just before the screen comes up.
    r.goals(2, watch);
    r.show(finished(), 'a');
    const btn = $('.goalsbtn') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('▶ Watch the goals2');
    btn.click();
    expect(watch).toHaveBeenCalledOnce();
    r.hold(true);
    vi.advanceTimersByTime((MATCH.resultsShow / TICK_HZ) * 1000 + 5000);
    expect(r.visible).toBe(true);
    r.hold(false);
    vi.advanceTimersByTime((MATCH.resultsShow / TICK_HZ) * 1000 - 3000);
    expect(r.visible).toBe(true);
    vi.advanceTimersByTime(3500);
    expect(r.visible).toBe(false);
    // Leaving the room: the next room's results come without the last match's goals.
    r.forget();
    r.show(finished(900), 'a');
    expect(($('.goalsbtn') as HTMLButtonElement).hidden).toBe(true);
  });

  it('maç bitmeden açılmaz', () => {
    const r = createResults();
    const g = finished();
    g.phase = 'play';
    r.show(g, 'a');
    expect(r.visible).toBe(false);
  });
});
