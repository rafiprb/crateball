// Which crate mixes do people play with? Reads the server's 'maç başladı' log lines on stdin (one per
// match start, with the room settings) and prints, per item, the average share and how often it was
// switched off, plus the most picked mixes and how often positions were off.
// Usage: pnpm crate-stats   (last 90 days of the VPS logs over SSH)
import { createInterface } from 'node:readline';

const ITEMS = ['gun', 'boost', 'shield', 'power', 'teleport', 'bazooka', 'mine', 'ice', 'dizzy'];
const matches = [];
createInterface({ input: process.stdin })
  .on('line', (l) => {
    try {
      const j = JSON.parse(l.slice(l.indexOf('{')));
      if (j.msg === 'maç başladı' && j.settings) matches.push(j);
    } catch {
      // not a JSON line
    }
  })
  .on('close', () => {
    // Only matches with real weights (older ones logged a loot list) and crates on.
    const withW = matches.filter((m) => m.settings.weights && m.settings.crates !== 'off');
    console.log(`Maç: ${matches.length} (kutulu ve paylı: ${withW.length})`);
    if (!withW.length) return;
    const mixes = new Map();
    console.log('\nEşya      ort. pay   kapalı   (insan sayısıyla ağırlıklı ort.)');
    for (const k of ITEMS) {
      let sum = 0;
      let off = 0;
      let wsum = 0;
      let hsum = 0;
      for (const m of withW) {
        const w = m.settings.weights;
        const t = ITEMS.reduce((a, i) => a + (w[i] ?? 0), 0) || 1;
        const share = (100 * (w[k] ?? 0)) / t;
        sum += share;
        if (!w[k]) off++;
        const h = m.humans ?? 1;
        wsum += share * h;
        hsum += h;
      }
      console.log(
        `${k.padEnd(9)} ${(sum / withW.length).toFixed(1).padStart(6)}%   ${String(off).padStart(5)}   ${(wsum / hsum).toFixed(1).padStart(6)}%`,
      );
    }
    for (const m of withW) {
      const key = ITEMS.map((k) => m.settings.weights[k] ?? 0).join('/');
      mixes.set(key, (mixes.get(key) ?? 0) + 1);
    }
    console.log(`\nEn çok seçilen karışımlar (${ITEMS.join('/')}):`);
    for (const [key, n] of [...mixes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n}×  ${key}`);
    const rolesOff = matches.filter((m) => m.settings.roles === false).length;
    console.log(`\nMevkiler kapalı: ${rolesOff}/${matches.length} maç`);
  });
