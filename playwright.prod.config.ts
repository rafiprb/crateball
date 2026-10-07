import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e-prod',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  // The hardened stack smoke runs Caddy on localhost with its own internal certificate.
  use: { baseURL: process.env.PROD_URL ?? 'http://localhost:8080', ignoreHTTPSErrors: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
