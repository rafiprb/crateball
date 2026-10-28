/* global document */
// Makes what Steamworks needs for the achievements, from the game's own list
// (packages/client/src/achievements.ts): the definitions and English text as the bulk import CSVs, and a
// 256×256 PNG per achievement (<API name>_ACHIEVED.png; Steamworks greys out the unachieved ones itself).
// Drop all of out/achievements/ on Stats & Achievements > Achievements > Bulk import. The four stats
// (INT, client set, increment only) must exist first: they are listed in out/achievements/stats.txt.
// Usage (from the repo root): node desktop/steam/achievements.mjs   (needs network for the fonts)
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ACHIEVEMENTS, COUNTERS } from '../../packages/client/src/achievements.ts';

const OUT = path.resolve(import.meta.dirname, '../out/achievements');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const csv = (rows) =>
  rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\r\n');
writeFileSync(
  path.join(OUT, 'definitions.csv'),
  csv([
    [
      'api_name',
      'setid',
      'permission',
      'spoiler',
      'archived',
      'progress_stat_name',
      'progress_stat_min',
      'progress_stat_max',
    ],
    ...ACHIEVEMENTS.map((a) => [a.id, '', 'Client', 'false', 'false', COUNTERS[a.counter], 0, a.at]),
  ]),
);
writeFileSync(
  path.join(OUT, 'localization.csv'),
  csv([
    ['api_name', 'field', 'english'],
    ...ACHIEVEMENTS.flatMap((a) => [
      [a.id, 'name', a.name],
      [a.id, 'description', a.description],
    ]),
  ]),
);
writeFileSync(
  path.join(OUT, 'stats.txt'),
  Object.values(COUNTERS)
    .map((s) => `${s}  INT, set by Client, increment only, default 0`)
    .join('\n') + '\n',
);

/** Medal colour by tier: bronze, silver, gold, then purple for the last two. */
const medal = (at) =>
  at <= 10
    ? ['#E0A066', '#8A5426']
    : at <= 100
      ? ['#E4E9F0', '#7D8899']
      : at <= 250
        ? ['#FFD84D', '#A87A00']
        : ['#C9A2FF', '#5B2FA8'];

const GLYPH = {
  goals: `<circle cx="0" cy="0" r="34" fill="#fff" stroke="#1d2433" stroke-width="5"/>
    <polygon points="0,-13 12.4,-4 7.6,10.5 -7.6,10.5 -12.4,-4" fill="#1d2433"/>
    <path d="M0,-13 L0,-31 M12.4,-4 L29,-10 M7.6,10.5 L18,26 M-7.6,10.5 L-18,26 M-12.4,-4 L-29,-10" stroke="#1d2433" stroke-width="4"/>`,
  saves: `<path d="M-22,34 L-24,-6 Q-24,-14 -17,-14 Q-11,-14 -11,-6 L-11,-26 Q-11,-34 -4,-34 Q3,-34 3,-26 L3,-30 Q3,-38 10,-38 Q17,-38 17,-30 L17,-20 Q17,-28 24,-28 Q31,-28 31,-20 L31,14 Q31,34 12,38 Z"
    fill="#fff" stroke="#1d2433" stroke-width="5" stroke-linejoin="round"/>
    <rect x="-26" y="26" width="42" height="14" rx="4" fill="#4A7DE8" stroke="#1d2433" stroke-width="5"/>`,
  passes: `<circle cx="-26" cy="20" r="12" fill="#E8574A" stroke="#1d2433" stroke-width="5"/>
    <circle cx="26" cy="20" r="12" fill="#E8574A" stroke="#1d2433" stroke-width="5"/>
    <path d="M-20,2 Q0,-38 20,2" fill="none" stroke="#fff" stroke-width="7" stroke-dasharray="9 7" stroke-linecap="round"/>
    <path d="M10,-6 L22,6 L26,-10" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`,
  wins: `<path d="M-24,-34 L24,-34 L22,-6 Q18,14 0,16 Q-18,14 -22,-6 Z" fill="#FFD84D" stroke="#1d2433" stroke-width="5" stroke-linejoin="round"/>
    <path d="M-23,-26 Q-40,-26 -36,-10 Q-32,2 -20,0 M23,-26 Q40,-26 36,-10 Q32,2 20,0" fill="none" stroke="#1d2433" stroke-width="5"/>
    <rect x="-6" y="15" width="12" height="12" fill="#FFD84D" stroke="#1d2433" stroke-width="5"/>
    <rect x="-20" y="26" width="40" height="11" rx="3" fill="#C88A4A" stroke="#1d2433" stroke-width="5"/>`,
};

const icon = (a) => {
  const [light, dark] = medal(a.at);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs><clipPath id="c"><rect x="0" y="0" width="256" height="256"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="256" height="256" fill="#5E9A48"/>
    ${[0, 2, 4, 6].map((i) => `<rect x="${i * 32}" y="0" width="32" height="256" fill="#588F43"/>`).join('')}
    <circle cx="128" cy="128" r="150" fill="none" stroke="#ffffff22" stroke-width="4"/>
  </g>
  <rect x="10" y="10" width="236" height="236" rx="28" fill="none" stroke="${dark}" stroke-width="14"/>
  <rect x="17" y="17" width="222" height="222" rx="22" fill="none" stroke="${light}" stroke-width="6"/>
  <g transform="translate(128 98) scale(1.45)">${GLYPH[a.counter]}</g>
  <text x="128" y="222" text-anchor="middle" font-family="'Baloo 2'" font-weight="800" font-size="${a.at >= 100 ? 64 : 72}"
    fill="${light}" stroke="#1d2433" stroke-width="10" paint-order="stroke" letter-spacing="1">${a.at}</text>
</svg>`;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
await page.setContent(
  `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&display=block">
  <style>html,body{margin:0;background:#000}</style></head><body><div id="i"></div>
  <span style="font:800 10px 'Baloo 2'">0123456789</span></body></html>`,
  { waitUntil: 'networkidle' },
);
await page.evaluate(() => document.fonts.ready);
if (!(await page.evaluate(() => document.fonts.check("800 10px 'Baloo 2'"))))
  throw new Error('Baloo 2 did not load');
mkdirSync(path.join(OUT, 'icons'), { recursive: true });
for (const a of ACHIEVEMENTS) {
  await page.evaluate((svg) => (document.getElementById('i').innerHTML = svg), icon(a));
  await page.locator('#i svg').screenshot({ path: path.join(OUT, 'icons', `${a.id}_ACHIEVED.png`) });
}
await browser.close();
console.log(`${ACHIEVEMENTS.length} achievements → ${OUT}`);
