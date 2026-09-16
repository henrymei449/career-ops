// tests/ui/mark-applied.spec.mjs — regression test for the "Mark Applied
// click showed no visible response" report. Root cause: the button's
// onclick gated the real transition behind window.confirm(), and confirm()
// resolving false took the SILENT `return;` branch — nothing in the DOM
// changed, no error, no success, indistinguishable from a broken button.
// Durable production state confirmed the backend transition never fired
// (READY_TO_APPLY unchanged, no applied_at, no outreach field), so the
// failure boundary was entirely client-side, before any API call.
//
// The fix replaces window.confirm() with an inline two-step confirm that
// always produces a visible DOM change on every click. This spec drives a
// REAL browser against a REAL running ui-server.mjs (an isolated fixture
// root, never production) to prove the actual click path, not just the
// underlying API function — a plain node:test of markApplied() would not
// have caught this bug, since the backend was never at fault.

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}`;
const JOB_KEY = 'url:https://example.com/jobs/mark-applied-fixture';

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
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-mark-applied-'));
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
        company: 'FixtureCo',
        title: 'Mark-Applied Regression Fixture Role',
        url: 'https://example.com/jobs/mark-applied-fixture',
        batch_id: 'batch-fixture-0001',
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

test('clicking Mark Applied once shows an inline confirm state WITHOUT calling the API', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  const markBtn = page.getByRole('button', { name: 'Mark Applied' });
  await expect(markBtn).toBeVisible();

  await markBtn.click();

  // Visible DOM change on the FIRST click — this is the actual regression:
  // the old window.confirm() gate produced no visible change at all on its
  // cancel path, which is indistinguishable from nothing having happened.
  await expect(page.getByRole('button', { name: /Confirm: mark FixtureCo applied\?/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

  // The API must NOT have been called yet — job is still READY_TO_APPLY.
  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(true);
});

test('clicking Cancel reverts to Mark Applied WITHOUT calling the API', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('button', { name: 'Mark Applied' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden();

  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(true);
});

test('clicking Confirm the second time actually marks the job applied', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Ready to Apply' }).click();
  await page.getByRole('button', { name: 'Mark Applied' }).click();
  await page.getByRole('button', { name: /Confirm: mark FixtureCo applied\?/ }).click();

  // Card disappears from Ready to Apply once the reload completes.
  await expect(page.getByText('FixtureCo — Mark-Applied Regression Fixture Role')).toBeHidden();

  const res = await fetch(`${BASE_URL}/api/ready`);
  const body = await res.json();
  expect(body.jobs.some((j) => j.job_key === JOB_KEY)).toBe(false);

  // Durable state actually transitioned — the real backend call fired.
  const outreachRes = await fetch(`${BASE_URL}/api/outreach`);
  const outreachBody = await outreachRes.json();
  const job = outreachBody.jobs.find((j) => j.job_key === JOB_KEY);
  expect(job).toBeTruthy();
  expect(job.decision).toBe('PENDING');
  expect(job.status).toBe('NOT_STARTED');
});
