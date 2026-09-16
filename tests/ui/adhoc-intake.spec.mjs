// tests/ui/adhoc-intake.spec.mjs — regression test for the "Add Job" ad-hoc
// intake control on the Review tab (#pass3), mirroring pass-application.spec.mjs's
// real-browser coverage: drives a REAL browser against a REAL running
// ui-server.mjs (an isolated fixture root, never production).
//
// Network-free: the "unsupported" case uses a loopback URL (rejected by the
// SSRF guard before any real request), and the "duplicate" case pre-seeds
// durable state so no capture is attempted at all.

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;
const DUPLICATE_URL = 'https://example.com/jobs/adhoc-intake-duplicate-fixture';

let dataRoot;
let server;

async function waitForServer(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`ui-server.mjs did not start listening on ${url} within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-adhoc-intake-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const state = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    ingested_batches: {},
    jobs: {
      [`url:${DUPLICATE_URL}`]: {
        fit_decision: 'PASS',
        execution_status: 'NONE',
        reason: 'fixture: previously passed',
        company: 'DuplicateFixtureCo',
        title: 'Duplicate Fixture Role',
        url: DUPLICATE_URL,
        batch_id: 'batch-fixture-0003',
        decided_at: new Date().toISOString(),
      },
    },
  };
  writeFileSync(join(dataRoot, 'data', 'review-state.json'), JSON.stringify(state, null, 2) + '\n');

  server = spawn(process.execPath, ['ui-server.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
    stdio: 'pipe',
  });
  await waitForServer(`${BASE_URL}/api/review/batches`);
});

test.afterAll(async () => {
  server?.kill();
  rmSync(dataRoot, { recursive: true, force: true });
});

test('Add Job button reveals the URL field and Intake button', async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.locator('#add-job-url')).toBeHidden();
  await page.getByRole('button', { name: 'Add Job' }).click();
  await expect(page.locator('#add-job-url')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Intake' })).toBeVisible();
});

test('an unresolvable (loopback) URL gives clear unsupported feedback', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Add Job' }).click();
  await page.locator('#add-job-url').fill('https://127.0.0.1:9/definitely-not-a-real-job');
  await page.getByRole('button', { name: 'Intake' }).click();
  await expect(page.locator('#add-job-status')).toContainText('Could not capture this posting');
});

test('re-submitting a previously-PASSed URL reports existing state, not a new batch', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Add Job' }).click();
  await page.locator('#add-job-url').fill(DUPLICATE_URL);
  await page.getByRole('button', { name: 'Intake' }).click();
  await expect(page.locator('#add-job-status')).toContainText('Already known — PASS');
  await expect(page.locator('#add-job-status')).toContainText('DuplicateFixtureCo');

  // No new batch was created for a duplicate.
  const res = await fetch(`${BASE_URL}/api/review/batches`);
  const body = await res.json();
  expect(body.batches.length).toBe(0);
});

test('an invalid URL is rejected client-side round-trip without crashing the UI', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Add Job' }).click();
  await page.locator('#add-job-url').fill('not a url');
  await page.getByRole('button', { name: 'Intake' }).click();
  await expect(page.locator('#add-job-status')).toContainText('invalid URL');
});
