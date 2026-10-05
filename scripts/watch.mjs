// Reads the game's JSON log lines on stdin and prints only what a human should look at:
// joins, match start/end, R reports, visible glitches (big corrections, low fps, hitches, high ping).
// Usage: pnpm watch   (follows the VPS logs over SSH)
import { createInterface } from 'node:readline';

const lastWarn = new Map();
const out = (s) => process.stdout.write(`${new Date().toTimeString().slice(0, 8)} ${s}\n`);
createInterface({ input: process.stdin }).on('line', (l) => {
  let j;
  try {
    j = JSON.parse(l.slice(l.indexOf('{')));
  } catch {
    return;
  }
  const who = `${j.name ?? '?'}@${j.room ?? '-'}`;
  if (j.level >= 50) return out(`HATA ${j.msg} ${JSON.stringify(j.err ?? '')}`.slice(0, 300));
  switch (j.msg) {
    case 'oyuncu odaya girdi':
      return out(`GİRDİ ${j.name} → ${j.room} (${j.team})`);
    case 'maç başladı':
      return out(`MAÇ BAŞLADI ${j.room}`);
    case 'maç bitti, lobiye dönüldü':
      return out(`MAÇ BİTTİ ${j.room} skor ${j.score}`);
    case 'oyuncu raporu (R)':
      return out(
        `RAPOR ${who}: ` +
          (j.recent ?? [])
            .map(
              (s) =>
                `[fps ${s.fps} maxKare ${s.frameMsMax}ms ping ${s.rtt} düzeltme ${s.myCorrectionPx}px (tek ${s.myCorrectionMaxPx})]`,
            )
            .join(' '),
      );
    case 'istemci istatistik': {
      const bad = [];
      if (j.myCorrectionMaxPx > 8) bad.push(`tek düzeltme ${j.myCorrectionMaxPx}px`);
      if (j.ballCorrectionMaxPx > 25) bad.push(`top zıpladı ${j.ballCorrectionMaxPx}px`);
      if (j.othersCorrectionMaxPx > 25) bad.push(`başka oyuncu zıpladı ${j.othersCorrectionMaxPx}px`);
      if (j.myCorrectionPx > 30) bad.push(`2sn düzeltme ${j.myCorrectionPx}px`);
      if (j.fps < 50 && j.frameMsMax < 1000) bad.push(`fps ${j.fps}`);
      if ((j.longFrames >= 3 || j.frameMsMax > 60) && j.frameMsMax < 1000)
        bad.push(
          `takılma ${j.longFrames} kare, en uzun ${j.frameMsMax}ms (iş: sim ${j.simMsMax ?? '?'} çizim ${j.drawMsMax ?? '?'} snap ${j.snapMsMax ?? '?'}ms)`,
        );
      const now = Date.now();
      // High ping alone is a property of that player's line: say it at most every 2 minutes.
      if (j.rtt > 150 && now - (lastWarn.get(`ping:${who}`) ?? 0) > 120000) {
        lastWarn.set(`ping:${who}`, now);
        if (!bad.length) return out(`PING ${who}: ${j.rtt} ms`);
      }
      if (!bad.length) return;
      if (now - (lastWarn.get(who) ?? 0) < 10000) return;
      lastWarn.set(who, now);
      return out(`UYARI ${who}: ${bad.join(', ')} (ping ${j.rtt})`);
    }
  }
});
