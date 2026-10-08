import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type GameState = {
  frame: number;
  net: { status: string; clientId: string | null };
  sim: { tick: number; phase: string; players: Array<{ name: string; bot: boolean }> } | null;
};
const LOG_FILE = 'logs/dev.log';

test('sahne açılır, odaya girer ve botla maç başlar', async ({ page }) => {
  await page.goto('/?name=Şule&autoplay');
  await expect(page).toHaveTitle('Crateball');
  await expect(page.locator('canvas#game')).toBeVisible();
  await page.waitForFunction(
    () => (window.__game?.getState() as GameState | undefined)?.net.status === 'open',
    null,
    {
      timeout: 15_000,
    },
  );
  const state = await page.evaluate(() => window.__game?.getState() as GameState);
  expect(state.frame).toBeGreaterThan(0);
  await page.waitForFunction(
    () => ((window.__game?.getState() as GameState | undefined)?.sim?.tick ?? 0) > 5,
  );
  const sim = (await page.evaluate(() => window.__game?.getState() as GameState)).sim;
  expect(sim?.players).toEqual([
    expect.objectContaining({ name: 'Şule', bot: false }),
    expect.objectContaining({ bot: true }),
  ]);
  expect(state.net.clientId).toHaveLength(12);
});

test('F1 debug panelini açar/kapatır, ?debug açık başlatır', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__game);
  const overlay = page.locator('#debug-overlay');
  await expect(overlay).toBeHidden();
  await page.keyboard.press('F1');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('[data-key=fps]')).not.toHaveText('–');
  await page.keyboard.press('F1');
  await expect(overlay).toBeHidden();
  await page.goto('/?debug');
  await expect(page.locator('#debug-overlay')).toBeVisible();
});

test('debug köprüsü komut çalıştırır ve bilinmeyeni reddeder', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__game);
  expect(await page.evaluate(() => window.__game?.cmd('ping'))).toBe('pong');
  const error = await page.evaluate(() => {
    try {
      window.__game?.cmd('yok');
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(error).toContain('Unknown command: yok');
});

test('sunucuya ulaşılamazsa yeniden dener, ulaşınca bağlanır', async ({ page }) => {
  let refused = 0;
  let passed = 0;
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    if (refused < 2) {
      refused++;
      void ws.close();
      return;
    }
    passed++;
    ws.connectToServer();
  });
  await page.goto('/');
  await page.waitForFunction(
    () => (window.__game?.getState() as GameState | undefined)?.net.status === 'open',
    null,
    {
      timeout: 15_000,
    },
  );
  expect(refused).toBe(2);
  expect(passed).toBe(1);
});

test('sürüm uyuşmazlığında yenile uyarısı gösterir ve tekrar denemez', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    connections++;
    ws.onMessage(() => {
      ws.send(
        JSON.stringify({
          t: 'error',
          code: 'version_mismatch',
          message: 'The game was updated — reload the page',
        }),
      );
      void ws.close({ code: 4001 });
    });
  });
  await page.goto('/');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner button')).toHaveText('Reload page');
  await page.waitForTimeout(1500);
  expect(connections).toBe(1);
});

test('tarayıcı konsolu logs/dev.log dosyasına Türkçe bozulmadan akar', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__game);
  const marker = `e2e-${Date.now()} Şafak söktü ğüşıöç İ`;
  await page.evaluate((m) => console.warn(m), marker);
  await expect
    .poll(() => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : ''), { timeout: 5000 })
    .toContain(marker);
});

test('ana menüde sohbet kutusu yok; lobide var, çıkınca gider', async ({ page }) => {
  await page.goto('/?name=Test');
  await page.waitForSelector('#ui .panel');
  await expect(page.locator('#chat')).toBeHidden();
  await page
    .getByRole('button', { name: /create/i })
    .first()
    .click();
  await page.waitForSelector('.team li');
  await expect(page.locator('#chat')).toBeVisible();
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.locator('#chat')).toBeHidden();
});
