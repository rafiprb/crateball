/* global window, document */
// Store screenshots (packages/client/shots.html) as 1920x1080 PNGs: the results screen of a real bot match
// and its goals popup paused on a goal. Needs the client dev server (pnpm dev).
// Usage: node scripts/shots.mjs [out dir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const URL = process.env.SHOTS_URL || 'http://localhost:5173/shots.html';
const out = path.resolve(process.argv[2] || 'marketing/out/store');
mkdirSync(out, { recursive: true });

// A 5-4 match over every arena (9 goals); Lukas's results screen.
const MATCH = {
  seed: 13,
  arenas: ['classic', 'rain', 'volcano', 'ice', 'wind', 'beach'],
  scoreLimit: 5,
  minutes: 5,
};
// Goals popup shots: [goal in the list, where in the clip (0-1)], on the "GOAL!" moment.
const GOALS = [
  [7, 0.84], // Chloe on the volcano
  [2, 0.84], // Lukas on the beach
];

const browser = await chromium.launch();
const shoot = async (name, view, goal) => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  p.on('pageerror', (e) => console.error('page error:', e.message));
  await p.goto(URL);
  await p.waitForFunction(() => window.shots);
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(([m, v]) => window.shots.show(m, v, 'red-0'), [MATCH, view]);
  await p.evaluate(() => document.activeElement?.blur());
  if (goal) {
    const [i, at] = goal;
    await (await p.$$('#goals .glist > *'))[i].click();
    await p.click('#goals .gplay'); // pause
    const box = await (await p.$('#goals .bar')).boundingBox();
    await p.mouse.click(box.x + box.width * at, box.y + box.height / 2);
    await p.mouse.move(2, 2);
  }
  await p.waitForTimeout(800);
  const file = path.join(out, `${name}.png`);
  await p.screenshot({ path: file });
  console.log(file);
  await p.close();
};
await shoot('results', 'results');
for (const g of GOALS) await shoot(`goals-${g[0]}`, 'goals', g);
await browser.close();
