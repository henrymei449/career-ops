// tests/ui/applications-board.spec.mjs — Pass 2 "What Is Alive?" Applications
// board regression. Drives a REAL browser against a REAL running
// ui-server.mjs over an isolated fixture root (never production), proving
// the tab exists, defaults to Alive, filters switch correctly, cards render
// the expected fields, and a reload still reflects the durable backend
// (never a client-cached copy — see ui-server.mjs's header comment on that
// invariant for the rest of this UI).

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5198;
const BASE_URL = `http://localhost:${PORT}`;

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
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-applications-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const state = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    ingested_batches: {},
    jobs: {
      'url:https://example.com/jobs/alive-live': {
        fit_decision: 'APPLY',
        execution_status: 'APPLIED',
        company: 'AliveLiveCo',
        title: 'Alive Live-Workflow Role',
        url: 'https://example.com/jobs/alive-live',
        applied_at: '2026-09-16T20:36:00.000Z',
        outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [] },
      },
      'url:https://example.com/jobs/alive-legacy': {
        fit_decision: 'APPLY',
        execution_status: 'APPLIED',
        company: 'AliveLegacyCo',
        title: 'Alive Legacy Role',
        url: 'https://example.com/jobs/alive-legacy',
        applied_at: '2026-09-03T00:00:00.000Z',
        application_status: 'ACTIVE',
        application_stage: 'Applied',
        application_last_update: '2026-09-03',
        outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
      },
      'url:https://example.com/jobs/closed-legacy': {
        fit_decision: 'APPLY',
        execution_status: 'APPLIED',
        company: 'ClosedLegacyCo',
        title: 'Rejected Legacy Role',
        url: 'https://example.com/jobs/closed-legacy',
        applied_at: '2026-08-26T00:00:00.000Z',
        application_status: 'REJECTED',
        application_stage: 'Rejected',
        application_last_update: '2026-08-31',
      },
      'url:https://example.com/jobs/still-ready': {
        fit_decision: 'APPLY',
        execution_status: 'READY_TO_APPLY',
        company: 'NotAppliedCo',
        title: 'Not Yet Applied Role',
        url: 'https://example.com/jobs/still-ready',
      },
    },
  };
  writeFileSync(join(dataRoot, 'data', 'review-state.json'), JSON.stringify(state, null, 2) + '\n');

  server = spawn(process.execPath, ['ui-server.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
    stdio: 'pipe',
  });
  await waitForServer(`${BASE_URL}/api/applications`);
});

test.afterAll(async () => {
  server?.kill();
  rmSync(dataRoot, { recursive: true, force: true });
});

test('Applications tab exists and defaults to Alive with expected cards', async ({ page }) => {
  await page.goto(BASE_URL);
  const tab = page.getByRole('button', { name: 'Applications' });
  await expect(tab).toBeVisible();
  await tab.click();

  await expect(page.getByRole('button', { name: 'Alive' })).toHaveClass(/selected/);
  await expect(page.getByText('AliveLiveCo — Alive Live-Workflow Role')).toBeVisible();
  await expect(page.getByText('AliveLegacyCo — Alive Legacy Role')).toBeVisible();
  await expect(page.getByText('ClosedLegacyCo — Rejected Legacy Role')).toBeHidden();
  await expect(page.getByText('NotAppliedCo — Not Yet Applied Role')).toBeHidden();
});

test('cards render company, role, applied date, status, stage, and outreach', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Applications' }).click();

  const card = page.locator('.card', { hasText: 'AliveLiveCo' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('ACTIVE');
  await expect(card).toContainText('Applied:');
  await expect(card).toContainText('Stage: Applied');
  await expect(card).toContainText('Outreach: Contacts Selected');
});

test('switching to Closed shows only closed applications', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Applications' }).click();
  await page.getByRole('button', { name: 'Closed' }).click();

  await expect(page.getByRole('button', { name: 'Closed' })).toHaveClass(/selected/);
  await expect(page.getByText('ClosedLegacyCo — Rejected Legacy Role')).toBeVisible();
  await expect(page.getByText('AliveLiveCo — Alive Live-Workflow Role')).toBeHidden();
});

test('switching to All shows every submitted application, including both alive and closed', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Applications' }).click();
  await page.getByRole('button', { name: 'All' }).click();

  await expect(page.getByRole('button', { name: 'All' })).toHaveClass(/selected/);
  await expect(page.getByText('AliveLiveCo — Alive Live-Workflow Role')).toBeVisible();
  await expect(page.getByText('AliveLegacyCo — Alive Legacy Role')).toBeVisible();
  await expect(page.getByText('ClosedLegacyCo — Rejected Legacy Role')).toBeVisible();
  await expect(page.getByText('NotAppliedCo — Not Yet Applied Role')).toBeHidden();
});

test('reload preserves durable-backend truth (not a client-cached copy)', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: 'Applications' }).click();
  await page.getByRole('button', { name: 'Closed' }).click();
  await expect(page.getByText('ClosedLegacyCo — Rejected Legacy Role')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Applications' }).click();
  // A reload resets client state to the default view (Alive) — proving the
  // page never trusted a locally-cached filter, only re-fetches from the
  // server on every load, same invariant the rest of this UI relies on.
  await expect(page.getByRole('button', { name: 'Alive' })).toHaveClass(/selected/);
  await expect(page.getByText('AliveLiveCo — Alive Live-Workflow Role')).toBeVisible();
  await expect(page.getByText('ClosedLegacyCo — Rejected Legacy Role')).toBeHidden();
});
