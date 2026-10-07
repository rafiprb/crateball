/* global window */
// Renders the trailer (packages/client/trailer.html) to an MP4: every frame drawn in a headless browser,
// piped to ffmpeg, then the soundtrack (rendered offline in the page) muxed in.
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

const ffmpeg = (args) => {
  const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  return { proc, done };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(URL);
await page.waitForFunction(() => window.trailer);
await page.evaluate(() => window.trailer.ready());
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
await ffmpeg([
  '-i',
  videoOnly,
  '-i',
  wav,
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
