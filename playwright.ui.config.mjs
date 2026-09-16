import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: 'test-results/ui-results',
  use: {
    browserName: 'chromium',
    viewport: { width: 1000, height: 900 },
  },
});
