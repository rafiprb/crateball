import { statSync } from 'node:fs';

/** Load test mode lasts at most this long after the flag file was made (a forgotten one stops counting). */
export const LOADTEST_MAX_MS = 30 * 60_000;

/**
 * Load test mode (scripts/loadtest-mode.sh on|off): while the file exists and is younger than
 * LOADTEST_MAX_MS, the server-wide caps and the per-address limits are lifted, so one machine can play
 * past them. Checked once a second; `on()` is cheap.
 */
export function watchLoadTest(file: string | undefined, now: () => number = Date.now) {
  const check = () => {
    if (!file) return false;
    try {
      return now() - statSync(file).mtimeMs < LOADTEST_MAX_MS;
    } catch {
      return false;
    }
  };
  let on = check();
  const timer = setInterval(() => (on = check()), 1000);
  timer.unref();
  return { on: () => on, stop: () => clearInterval(timer) };
}
