import { expect, test, type Page } from '@playwright/test';

type State = {
  room: {
    code: string;
    name: string;
    settings: { loot: string[] };
    state: string;
    host: string;
    players: Array<{ id: string; name: string; team: string; bot: boolean }>;
  } | null;
  screen: string;
  net: { clientId: string | null; rtt: number };
  pred: { pending: number; corrections: number };
  sim: {
    tick: number;
    players: Array<{ id: string; team: string; bot: boolean }>;
    me: { x: number; y: number; team: string } | null;
    ball: { x: number; y: number; vx: number; vy: number };
  } | null;
};
const state = (p: Page) => p.evaluate(() => window.__game?.getState() as State);

/** Adds `ms` one-way delay in both directions to the game socket. */
async function withLatency(page: Page, ms: number) {
  await page.routeWebSocket('**/ws', (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => void setTimeout(() => server.send(m), ms));
    server.onMessage((m) => void setTimeout(() => ws.send(m), ms));
  });
}

test('iki oyuncu aynı odada; gecikmeli istemcide kendi hareketi RTT beklemeden görünür', async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await withLatency(b, 60); // ~120 ms RTT
  await a.goto(`/?name=A&autoplay`);
  await expect.poll(async () => (await state(a))?.room?.state, { timeout: 15_000 }).toBe('playing');
  const code = (await state(a)).room!.code;
  await b.goto(`/r/${code}?name=B`);
  await expect
    .poll(async () => (await state(b))?.sim?.players.filter((p) => !p.bot).length ?? 0, { timeout: 15_000 })
    .toBe(2);
  const sa = await state(a);
  expect(
    sa.sim?.players
      .filter((p) => !p.bot)
      .map((p) => p.team)
      .sort(),
  ).toEqual(['blue', 'red']);

  // Local response: the lagged client sees its own movement within a couple of frames, not after RTT.
  await b.bringToFront();
  // A page that was in the background has its frames paused; let it run a moment before timing.
  await b.waitForTimeout(500);
  const before = (await state(b)).sim!.me!;
  const dir = before.team === 'red' ? 'ArrowRight' : 'ArrowLeft';
  await b.keyboard.down(dir);
  // Well under the ~120 ms round trip. The first kickoff may be on ice or rain (slow acceleration),
  // so ask only for a clear start of movement, which the server could not have confirmed yet.
  await b.waitForTimeout(90);
  const moved = (await state(b)).sim!.me!;
  await b.keyboard.up(dir);
  expect(Math.abs(moved.x - before.x)).toBeGreaterThan(0.2);
  // Prediction stays in agreement with the server: corrections stay rare while idle.
  const c0 = (await state(b)).pred.corrections;
  await b.waitForTimeout(1500);
  const s = await state(b);
  // The latency really applies (~120 ms round trip). Pending inputs are no longer a measure of it:
  // a starved server counts stand-in ticks against the client's sequence numbers.
  expect(s.net.rtt).toBeGreaterThan(100);
  expect(s.pred.corrections - c0).toBeLessThan(40);
});

test('lobi: oda kur, Find Room ile bul, host sürükleyerek yer değiştirir, mevki seçilir, maç başlar', async ({
  browser,
}) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await a.goto('/?name=Host');
  await a.getByRole('button', { name: 'Create Room' }).click();
  // Straight into the lobby; the host renames the room there and picks crate contents.
  await expect(a.locator('#room-code')).toHaveText(/^[A-Z]{4}$/);
  await a.locator('#room-name').fill('E2E lobby');
  await a.locator('#room-name').press('Enter');
  await expect.poll(async () => (await state(a)).room?.name).toBe('E2E lobby');
  await a.locator('input[data-loot=gun]').uncheck();
  await expect.poll(async () => (await state(a)).room?.settings.loot.includes('gun')).toBe(false);
  const code = await a.locator('#room-code').innerText();

  await b.goto('/?name=Guest');
  await b.getByRole('button', { name: 'Find Room' }).click();
  const row = b.locator('ul.rooms li', { hasText: code });
  await row.getByRole('button', { name: 'Join' }).click();
  await expect(b.locator('#screen-lobby')).toBeVisible();
  await expect(a.locator('.team li')).toHaveCount(2);
  await expect(b.getByRole('button', { name: 'Start Game' })).toHaveCount(0);

  // Everyone picks their own position.
  await b.locator('.roles button[data-role=gk]').click();
  await expect(a.locator('.team li', { hasText: 'Guest' })).toContainText('Goalkeeper');

  // Host drags Guest onto Host → they swap teams.
  const guestTeam = async () => (await state(a)).room!.players.find((p) => p.name === 'Guest')!.team;
  const before = await guestTeam();
  await a.locator('.team li', { hasText: 'Guest' }).dragTo(a.locator('.team li', { hasText: 'Host' }));
  await expect.poll(guestTeam).not.toBe(before);

  await a.getByRole('button', { name: 'Start Game' }).click();
  await expect.poll(async () => (await state(b)).screen).toBe('none');
  await expect.poll(async () => (await state(b)).sim?.tick ?? 0).toBeGreaterThan(10);
});
