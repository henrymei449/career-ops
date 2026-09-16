// tests/ui/pass-application.spec.mjs — regression test for the "Pass"
// button in Ready to Apply, mirroring mark-applied.spec.mjs's real-browser
// coverage of the inline two-step confirm pattern (never window.confirm()).
//
// Drives a REAL browser against a REAL running ui-server.mjs (an isolated
// fixture root, never production) to prove the actual click path: first
// click must not mutate state, the inline confirmation must be visible,
// Cancel must not mutate state, and only Confirm Pass may mutate — after
// which the card disappears from Ready to Apply and a page reload keeps it
// gone (durable backend state, not a client-side hide).

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5198;
const BASE_URL = `http://localhost:${PORT}`;
const JOB_KEY = 'url:https://example.com/jobs/pass-application-fixture';

let dataRoot;
let server;

async function waitForServer(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // server is up and routing
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`ui-server.mjs did not start listening on ${url} within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-pass-application-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const state = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    ingested_batches: {},
    jobs: {
      [JOB_KEY]: {
        fit_decision: 'APPLY',
        execution_status: 'READY_TO_APPLY',
        reason: 'fixture',
        company: 'PassFixtureCo',
        title: 'Pass-Application Regression Fixture Role',
        url: 'https://example.com/jobs/pass-application-fixture',
        batch_id: 'batch-fixture-0002',
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
  await waitForServer(`${BASE_URL}/api/ready`);
});

test.afterAll(async () => {
  server?.kill();
  rmSync(dataRoot, { recursive: true, force: true });
});

test('Ready to Apply card shows a Pass button', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await expect(page.getByRole('button', { name: 'Pass', exact: true })).toBeVisible();
});

test('clicking Pass once shows an inline confirm state WITHOUT calling the API', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  const passBtn = page.getByRole('button', { name: 'Pass', exact: true });
  await expect(passBtn).toBeVisible();

  await passBtn.click();

  // Visible DOM change on the FIRST click — proves the button is not a no-op
  // before the human confirms.
  await expect(page.getByRole('button', { name: /Pass on this job\? This removes it from Ready to Apply\./ })).toBeVisible();

  // The API must NOT have been called yet — job is still READY_TO_APPLY.
  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(true);
});

test('clicking Cancel on the Pass confirm reverts WITHOUT calling the API', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await page.getByRole('button', { name: 'Pass', exact: true }).click();
  const confirmPassBtn = page.getByRole('button', { name: /Pass on this job\? This removes it from Ready to Apply\./ });
  await expect(confirmPassBtn).toBeVisible();

  // Only one Cancel button is visible at a time (Mark Applied's own Cancel
  // stays hidden since it was never engaged) — the :visible pseudo-class
  // disambiguates from the other, hidden Cancel button in the same row.
  await page.locator('button:visible', { hasText: 'Cancel' }).click();

  await expect(page.getByRole('button', { name: 'Pass', exact: true })).toBeVisible();
  await expect(confirmPassBtn).toBeHidden();

  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(true);
});

test('confirming Pass actually mutates state and the card disappears, surviving a reload', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await page.getByRole('button', { name: 'Pass', exact: true }).click();
  await page.getByRole('button', { name: /Pass on this job\? This removes it from Ready to Apply\./ }).click();

  // Card disappears from Ready to Apply once the reload completes.
  await expect(page.getByText('PassFixtureCo — Pass-Application Regression Fixture Role')).toBeHidden();

  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(false);

  // A fresh page load (not just the in-memory list) keeps it gone — durable
  // backend state, not a client-side hide.
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await expect(page.getByText('PassFixtureCo — Pass-Application Regression Fixture Role')).toBeHidden();

  // fit_decision was preserved as APPLY; only execution_status moved.
  const outreachRes = await fetch(`${BASE_URL}/api/outreach`);
  const outreachBody = await outreachRes.json();
  expect(outreachBody.jobs.some((j) => j.job_key === JOB_KEY)).toBe(false); // NOT_APPLYING never gets an outreach record
});
