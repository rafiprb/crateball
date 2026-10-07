/* global window */
// Renders the trailer (packages/client/trailer.html) to an MP4: every frame drawn in a headless browser,
// piped to ffmpeg, then the soundtrack (rendered offline in the page) loudness-normalised (-14 LUFS,
// -1 dBTP: what YouTube and Steam play at) and muxed in. Refuses to render if a shot fails check().
// Needs the client dev server (pnpm dev) and ffmpeg (on PATH, or FFMPEG=/path/to/ffmpeg).
// Usage: node scripts/trailer.mjs [out.mp4]
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const URL = process.env.TRAILER_URL || 'http://localhost:5173/trailer.html';
const outFile = path.resolve(process.argv[2] || 'marketing/out/crateball-trailer.mp4');
mkdirSync(path.dirname(outFile), { recursive: true });
const videoOnly = outFile.replace(/\.mp4$/, '.video.mp4');
const wav = outFile.replace(/\.mp4$/, '.wav');

const ffmpeg = (args, level = 'error') => {
  const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', level, '-y', ...args], {
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => (log += d));
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0 ? resolve(log) : reject(new Error(`ffmpeg exited with ${code}: ${log}`)),
    );
  });
  return { proc, done };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(URL, { waitUntil: 'networkidle' }); // Vite may reload once after a code change
await page.waitForFunction(() => window.trailer);
await page.evaluate(() => window.trailer.ready());
const problems = await page.evaluate(() => window.trailer.check());
if (problems.length) {
  console.error('shots that do not show what their label says:\n  ' + problems.join('\n  '));
  process.exit(1);
}
const { frames, fps } = await page.evaluate(() => ({
  frames: window.trailer.frames,
  fps: window.trailer.fps,
}));

const enc = ffmpeg([
  '-f',
  'image2pipe',
  '-framerate',
  String(fps),
  '-c:v',
  'mjpeg',
  '-i',
  '-',
  '-vf',
  'scale=out_color_matrix=bt709:out_range=tv',
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '17',
  '-pix_fmt',
  'yuv420p',
  '-r',
  String(fps),
  videoOnly,
]);
const ff = enc.proc;
const started = Date.now();
for (let i = 0; i < frames; i++) {
  const url = await page.evaluate((n) => window.trailer.frame(n), i);
  const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 120 === 0) console.log(`frame ${i}/${frames} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
ff.stdin.end();
await enc.done;

writeFileSync(wav, Buffer.from(await page.evaluate(() => window.trailer.audio()), 'base64'));
await browser.close();
// Two-pass loudness normalisation: measure, then apply linearly.
// -13.5 in, -14 out: the limiter after it takes about half a LU.
const target = 'I=-13.5:TP=-1:LRA=11';
const measured = await ffmpeg(
  ['-i', wav, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
  'info',
).done;
const m = JSON.parse(measured.slice(measured.lastIndexOf('{'), measured.lastIndexOf('}') + 1));
const norm =
  `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
  `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` +
  // and a brick-wall ceiling at -2.9 dBFS so the AAC file stays below -1.5 dBTP (encoding overshoots)
  ',alimiter=limit=0.72:attack=5:release=50:level=false';
console.log(`audio: ${m.input_i} LUFS, peak ${m.input_tp} dBTP -> ${target}`);
await ffmpeg([
  '-i',
  videoOnly,
  '-i',
  wav,
  '-af',
  norm,
  '-ar',
  '48000',
  '-c:v',
  'copy',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  '-shortest',
  '-movflags',
  '+faststart',
  outFile,
]).done;
console.log(`done: ${outFile}`);
