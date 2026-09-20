// tests/ui/resume-gate.spec.mjs — Review-card rendering of stored Resume Gate
// results: compact collapsed card, "Show Full Resume Gate" expansion showing
// the complete stored output, blocked/error states, and survival across a page
// reload. Real browser + real ui-server.mjs on an isolated fixture root; the
// gate results are pre-seeded on the batch, so no LLM is ever invoked.

import { test, expect } from 'playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBatchFromJobs, reviewPaths } from '../../review.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5203;
const BASE_URL = `http://localhost:${PORT}`;

const LONG_WHY = 'This is a direct fab operations role, so it routes to the manufacturing resume. '.repeat(6).trim();
const LONG_WARN = 'MAJOR TAILOR is a fit warning. The posting makes hands-on inspection-system experience a minimum qualification, and the background is on the fab-user side, not the tool-vendor service side. Re-run first-pass-fit and reconsider the value of applying, or consider skipping unless there is a specific reason to override. WARN-END';
const GAPS = Array.from({ length: 5 }, (_, i) => `Gap ${i + 1}: ${'unsupported requirement detail '.repeat(8).trim()} END${i + 1}`);
const RAW = `RESUME ROUTE:\nMANUFACTURING / SEMICONDUCTOR OPERATIONS\n\nWHY:\n${LONG_WHY}\n\nRESUME GATE:\nMAJOR TAILOR\n\nROLE FIT:\nMODERATE\n\nSTRONGEST EVIDENCE:\n- fab lead\n\nMATERIAL GAPS:\n${GAPS.map((g) => `- ${g}`).join('\n')}\n\nATS / TERMINOLOGY:\n- FULLVIEW-ATS-MARKER\n\nPROPOSED EDITS:\n1. FULLVIEW-EDIT-MARKER\n\nDO NOT CHANGE:\n- rest\n\nESTIMATED EFFORT:\n20+ min\n\nFIT WARNING:\n${LONG_WARN}`;

let dataRoot;
let server;
let batchId;

async function waitForServer(url, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url); if (res.ok || res.status === 404) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`ui-server.mjs did not start on ${url}`);
}

test.beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'co-ui-resume-gate-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const jobs = ['Gated Major', 'Gated Blocked', 'Gated Error', 'Never Run'].map((title, i) => ({
    url: `https://boards.greenhouse.io/co/jobs/${i + 1}`, company: 'FixtureCo', title, location: 'Remote - United States', description: `${title} job description text. `.repeat(10),
  }));
  ({ batchId } = createBatchFromJobs(jobs, { root: dataRoot, source: 'fixture' }));
  const file = join(reviewPaths(dataRoot).open, `${batchId}.json`);
  const batch = JSON.parse(readFileSync(file, 'utf-8'));
  const base = { sop_version: '2', jd_hash: 'abcdef0123456789', gated_at: new Date().toISOString() };
  batch.jobs[0].resume_gate = {
    gate_status: 'OK', gate_error: null, ...base,
    resume_route: 'MANUFACTURING', resume_route_label: 'MANUFACTURING / SEMICONDUCTOR OPERATIONS', role_fit: 'MODERATE', resume_gate: 'MAJOR TAILOR',
    why: LONG_WHY, strongest_evidence: ['fab lead'], material_gaps: GAPS, ats_terminology: ['FULLVIEW-ATS-MARKER'], proposed_edits: ['FULLVIEW-EDIT-MARKER'],
    do_not_change: ['rest'], estimated_effort: '20+ min', fit_warning: LONG_WARN, raw_output: RAW,
  };
  batch.jobs[1].resume_gate = { gate_status: 'BLOCKED_MISSING_JD', gate_error: 'no stored JD text for this job', ...base };
  batch.jobs[2].resume_gate = { gate_status: 'ERROR', gate_error: 'simulated gate failure', ...base };
  writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');

  server = spawn(process.execPath, ['ui-server.mjs', '--port', String(PORT)], {
    cwd: ROOT, env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' }, stdio: 'pipe',
  });
  await waitForServer(`${BASE_URL}/api/review/batches`);
});

test.afterAll(async () => {
  server?.kill();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function openReview(page) {
  await page.goto(BASE_URL);
  await page.click('nav button[data-view="review"]');
  await expect(page.locator('#review-list .card')).toHaveCount(4);
}
const cardFor = (page, title) => page.locator('#review-list .card', { hasText: title });

test('collapsed card is compact and readable; every gate state renders', async ({ page }) => {
  await openReview(page);
  const major = cardFor(page, 'Gated Major');
  await expect(major).toContainText('Resume Gate: MAJOR TAILOR');
  await expect(major).toContainText('Route: MANUFACTURING');
  await expect(major).toContainText('Role Fit: MODERATE');
  await expect(major.locator('.gate-block', { hasText: 'FIT WARNING' })).toContainText(LONG_WARN); // never clipped on the collapsed card
  await expect(major).toContainText('ESTIMATED EFFORT');
  const whyLine = await major.locator('.gate-block', { hasText: 'WHY' }).innerText();
  expect(whyLine.length).toBeLessThan(LONG_WHY.length); // display-only clip
  expect(whyLine).toContain('…');
  await expect(major.locator('.gate-block', { hasText: 'MATERIAL GAPS' })).toContainText('(+2 more)');
  await expect(major.locator('pre.gate-full')).toBeHidden(); // full view collapsed by default
  await expect(major.getByRole('button', { name: 'APPLY' })).toBeVisible(); // decision buttons untouched

  await expect(cardFor(page, 'Gated Blocked')).toContainText('GATE BLOCKED / MISSING JD');
  await expect(cardFor(page, 'Gated Error')).toContainText('simulated gate failure');
  await expect(cardFor(page, 'Never Run')).toContainText('Resume Gate: not run');
});

test('Show Full Resume Gate exposes the complete stored output, and it survives a reload', async ({ page }) => {
  await openReview(page);
  const major = cardFor(page, 'Gated Major');
  await major.locator('summary', { hasText: 'Show Full Resume Gate' }).click();
  const full = major.locator('pre.gate-full');
  await expect(full).toBeVisible();
  const text = await full.innerText();
  expect(text).toBe(RAW.replace(/\r/g, '')); // verbatim, untruncated
  for (const marker of [LONG_WHY, 'END5', 'FULLVIEW-ATS-MARKER', 'FULLVIEW-EDIT-MARKER', 'DO NOT CHANGE:', 'STRONGEST EVIDENCE:']) expect(text).toContain(marker);

  await page.reload();
  await page.click('nav button[data-view="review"]');
  await expect(page.locator('#review-list .card')).toHaveCount(4);
  const again = cardFor(page, 'Gated Major');
  await expect(again).toContainText('Resume Gate: MAJOR TAILOR');
  await again.locator('summary', { hasText: 'Show Full Resume Gate' }).click();
  expect(await again.locator('pre.gate-full').innerText()).toBe(RAW);
});
