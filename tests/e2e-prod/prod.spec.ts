import { expect, test } from '@playwright/test';
import { PROTOCOL_VERSION } from '../../packages/protocol/src/index';

test('prod imajı: sahne yüklenir, dev araçları yok, WebSocket el sıkışır', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // CSP violations (a blocked font, style or socket) show up as console errors.
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const res = await page.goto('/');
  // Behind Caddy (the hardened stack smoke), the security headers must be there.
  if (res?.url().startsWith('https:')) {
    const h = res.headers();
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(h['x-content-type-options']).toBe('nosniff');
  }
  await expect(page).toHaveTitle('Crateball');
  await expect(page.locator('canvas#game')).toBeVisible();
  await page.keyboard.press('F1');
  await expect(page.locator('#debug-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).__game)).toBe(
    'undefined',
  );
  const reply = await page.evaluate(
    (version) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocolVersion: version }));
        ws.onmessage = (e) => {
          resolve((JSON.parse(String(e.data)) as { t: string }).t);
          ws.close();
        };
        ws.onerror = () => reject(new Error('ws hatası'));
      }),
    PROTOCOL_VERSION,
  );
  expect(reply).toBe('welcome');
  // The fonts came through the CSP (Google Fonts) and the page's own scripts ran.
  expect(await page.evaluate(async () => (await document.fonts.load('16px "Baloo 2"')).length > 0)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
