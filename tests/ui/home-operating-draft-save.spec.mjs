// tests/ui/home-operating-draft-save.spec.mjs — Home operating-edit UX
// hotfix regression. Drives a REAL browser against a REAL running
// ui-server.mjs (isolated fixture root, never production), mirroring
// tests/ui/mark-applied.spec.mjs's pattern.
//
// Root cause this fixes: every operating-field edit called
// POST /api/home/operating/update immediately and reran loadFollowup(),
// which rebuilds the whole Home table from scratch — destroying the
// expanded row's DOM on every single keystroke's blur/change and kicking
// the operator back out to the collapsed list after each field. The fix
// (ui/app.js's renderOperatingControls) moves every field to an in-memory
// draft; only Save Changes ever calls the backend, exactly once, with a
// diff-only PATCH.

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5198;
const BASE_URL = `http://localhost:${PORT}`;
const JOB_KEY = 'cr:ifs::customer success manager manufacturing@@us';
const TODAY = '2026-09-16';

let dataRoot;
let server;

const PERSISTED_OPERATING = {
  priority: 'P3',
  last_touch: '2026-09-16',
  next_action: "Wait for Dirkje's reply or Hannah B's acceptance; no additional IFS outreach before 9/21.",
  waiting_on: 'Dirkje reply / Hannah acceptance',
  follow_up_due: '2026-09-21',
  notes: 'Dirkje re-engagement email sent 2026-09-16; Hannah B LinkedIn invite remains pending.',
};

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

function seedState() {
  const state = {
    schema_version: 1,
    updated_at: null,
    ingested_batches: {},
    jobs: {
      [JOB_KEY]: {
        company: 'IFS',
        title: 'Customer Success Manager / Manufacturing',
        fit_decision: 'APPLY',
        execution_status: 'APPLIED',
        application_status: 'ACTIVE',
        operating: { ...PERSISTED_OPERATING },
        outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
      },
    },
  };
  writeFileSync(join(dataRoot, 'data', 'review-state.json'), JSON.stringify(state, null, 2) + '\n');
}

test.beforeEach(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-operating-draft-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  seedState();
  server = spawn(process.execPath, ['ui-server.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
    stdio: 'pipe',
  });
  await waitForServer(`${BASE_URL}/api/ready`);
});

test.afterEach(async () => {
  server?.kill();
  rmSync(dataRoot, { recursive: true, force: true });
});

/** Expand the (only) Home row and return its operating-section locators.
 * Priority now renders as a compact header badge next to Stage (card
 * redesign — spec section 2), so it lives outside `.fu-operating`; Follow-Up
 * Due sits in the action block and Last Touch in the context block below it,
 * so the two date inputs are scoped by block rather than by document order. */
async function expandRow(page) {
  await page.goto(BASE_URL);
  await page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`).click();
  const cell = page.locator('tr.fu-detail');
  const operating = cell.locator('.fu-operating');
  await expect(operating).toBeVisible();
  return {
    priority: cell.locator('.fu-priority-badge select'),
    lastTouch: cell.locator('.fu-context-block input[type="date"]'),
    nextAction: operating.getByPlaceholder('e.g. Follow up on outreach'),
    waitingOn: operating.getByPlaceholder('e.g. recruiter response'),
    followUpDue: cell.locator('.fu-action-block input[type="date"]'),
    notes: operating.getByPlaceholder('notes'),
    save: operating.getByRole('button', { name: 'Save Changes' }),
    cancel: operating.getByRole('button', { name: 'Cancel' }),
    tomorrow: operating.getByRole('button', { name: 'Tomorrow' }),
  };
}

function collectOperatingPatchRequests(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/home/operating/update')) {
      bodies.push(JSON.parse(req.postData() || '{}'));
    }
  });
  return bodies;
}

test('draft initializes from row.operating on expand', async ({ page }) => {
  const f = await expandRow(page);
  await expect(f.priority).toHaveValue('P3');
  await expect(f.lastTouch).toHaveValue('2026-09-16');
  await expect(f.nextAction).toHaveValue(PERSISTED_OPERATING.next_action);
  await expect(f.waitingOn).toHaveValue(PERSISTED_OPERATING.waiting_on);
  await expect(f.followUpDue).toHaveValue('2026-09-21');
  await expect(f.notes).toHaveValue(PERSISTED_OPERATING.notes);
  await expect(f.save).toBeDisabled();
});

test('a field edit does not mutate the backend and does not collapse the row', async ({ page }) => {
  const patches = collectOperatingPatchRequests(page);
  const f = await expandRow(page);
  await f.notes.fill('typing a new note — not saved yet');
  await expect(f.save).toBeEnabled();
  expect(patches.length).toBe(0);
  await expect(page.locator('.fu-operating')).toBeVisible(); // row still expanded
});

test('multi-field diff generation: Save sends only the fields that changed', async ({ page }) => {
  const patches = collectOperatingPatchRequests(page);
  const f = await expandRow(page);
  await f.lastTouch.fill('2026-09-17');
  await f.nextAction.fill('Bump Dirkje via email if silent by Friday.');
  await f.waitingOn.fill('Dirkje reply, escalate if none by Friday');
  await f.followUpDue.fill('2026-09-18');
  await f.notes.fill('Manual smoke-test edit — verifying draft/save UX');
  await f.save.click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');

  expect(patches.length).toBe(1); // exactly one PATCH request per Save
  const patch = patches[0];
  expect(patch.job_key).toBe(JOB_KEY);
  expect(patch.priority).toBeUndefined(); // unchanged field excluded
  expect(patch.last_touch).toBe('2026-09-17');
  expect(patch.next_action).toBe('Bump Dirkje via email if silent by Friday.');
  expect(patch.waiting_on).toBe('Dirkje reply, escalate if none by Friday');
  expect(patch.follow_up_due).toBe('2026-09-18');
  expect(patch.notes).toBe('Manual smoke-test edit — verifying draft/save UX');
});

test('Save Changes is disabled clean and enabled dirty', async ({ page }) => {
  const f = await expandRow(page);
  await expect(f.save).toBeDisabled();
  await f.notes.fill('now dirty');
  await expect(f.save).toBeEnabled();
});

test('Cancel restores persisted values, causes no backend mutation, and keeps the row expanded', async ({ page }) => {
  const patches = collectOperatingPatchRequests(page);
  const f = await expandRow(page);
  await f.nextAction.fill('DRAFT ONLY — should be discarded');
  await f.notes.fill('DRAFT ONLY notes — should be discarded');
  await expect(f.save).toBeEnabled();

  await f.cancel.click();

  expect(patches.length).toBe(0);
  await expect(f.nextAction).toHaveValue(PERSISTED_OPERATING.next_action);
  await expect(f.notes).toHaveValue(PERSISTED_OPERATING.notes);
  await expect(f.save).toBeDisabled();
  await expect(page.locator('.fu-operating')).toBeVisible(); // still expanded
});

test('quick date buttons (Tomorrow) modify only the draft follow_up_due', async ({ page }) => {
  const patches = collectOperatingPatchRequests(page);
  const f = await expandRow(page);
  await f.tomorrow.click();
  await expect(f.followUpDue).toHaveValue('2026-09-17');
  expect(patches.length).toBe(0);
  await expect(f.save).toBeEnabled();

  await f.save.click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');
  expect(patches.length).toBe(1);
  expect(patches[0].follow_up_due).toBe('2026-09-17');
});

test('save preserves the active Home filter', async ({ page }) => {
  await page.goto(BASE_URL);
  // The fixture's follow_up_due (2026-09-21) buckets as UPCOMING relative
  // to TODAY (2026-09-16, the fixed system date the followup module and
  // this fixture both assume).
  await page.getByRole('button', { name: /Upcoming/ }).click();
  await expect(page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`)).toBeVisible();

  await page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`).click();
  const detail = page.locator('.fu-operating');
  await detail.getByPlaceholder('notes').fill('filter-preservation check');
  await detail.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');

  await expect(page.locator('.fu-chip.upcoming')).toHaveClass(/selected/);
});

test('expanded job is restored after the Save refresh, if it still matches the filter', async ({ page }) => {
  const f = await expandRow(page);
  await f.notes.fill('re-expand check');
  await f.save.click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');

  // No re-click needed — the same job_key auto-reopens after the one
  // intentional reload Save triggers.
  await expect(page.locator('.fu-operating')).toBeVisible();
  await expect(page.locator('.fu-operating').getByPlaceholder('notes')).toHaveValue('re-expand check');
});

test('a failed save preserves the draft, keeps the row expanded, and shows an inline error', async ({ page }) => {
  await page.route('**/api/home/operating/update', (route) => route.fulfill({ status: 500, body: JSON.stringify({ error: 'simulated failure' }) }));
  const f = await expandRow(page);
  await f.nextAction.fill('Edit that will fail to save');
  await f.save.click();

  await expect(page.locator('.err')).toHaveText('simulated failure');
  await expect(f.nextAction).toHaveValue('Edit that will fail to save'); // draft intact
  await expect(f.save).toBeEnabled(); // still dirty, retryable
  await expect(page.locator('.fu-operating')).toBeVisible(); // not collapsed
});

test('a bucket change that moves the row out of the active filter correctly removes it', async ({ page }) => {
  await page.goto(BASE_URL);
  await page.getByRole('button', { name: /Upcoming/ }).click();
  await expect(page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`)).toBeVisible();

  await page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`).click();
  const detail = page.locator('.fu-operating');
  await detail.locator('.fu-action-block input[type="date"]').fill(TODAY); // -> bucket TODAY, out of Upcoming
  await detail.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');

  await expect(page.locator('.fu-chip.upcoming')).toHaveClass(/selected/); // filter untouched
  await expect(page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`)).toHaveCount(0); // correctly gone

  await page.getByRole('button', { name: /Today/ }).click();
  await expect(page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`)).toBeVisible();
});

test('exactly one Home row per job survives a save', async ({ page }) => {
  const f = await expandRow(page);
  await f.notes.fill('single-row check');
  await f.save.click();
  await expect(page.locator('.fu-save-status')).toHaveText('Saved');
  await expect(page.locator(`tr.fu-row[data-job-key="${JOB_KEY}"]`)).toHaveCount(1);
});
