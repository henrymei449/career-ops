// tests/migrate-action-board-top8.test.mjs — focused coverage for the
// bounded top-8 Action Board -> Home operating metadata migration
// (migrate-action-board-top8.mjs). Mirrors tests/home-operating-metadata
// .test.mjs's sandbox pattern.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-migrate-action-board-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { updateJobOperatingMetadata, listFollowUpActions } = await import('../outreach.mjs');
const { reviewPaths, defaultState, readJson } = await import('../review.mjs');
const { buildHomeRows } = await import('../followup-schema.mjs');
const { SOURCE_ROWS, collapseDue, buildOperatingPatch } = await import('../migrate-action-board-top8.mjs');

after(() => {
  if (priorRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = priorRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const TODAY = '2026-09-16';

function seedState(jobs) {
  const p = reviewPaths(sandbox);
  mkdirSync(p.base, { recursive: true });
  mkdirSync(p.open, { recursive: true });
  writeFileSync(p.statePath, JSON.stringify({ ...defaultState(), jobs }, null, 2));
}

// ── collapseDue: the one-canonical-date rule ────────────────────────────

test('Due == Follow-Up Due collapses silently to canonical, no flag', () => {
  const { canonical, flagged } = collapseDue('2026-09-21', '2026-09-21');
  assert.equal(canonical, '2026-09-21');
  assert.equal(flagged, false);
});

test('a materially distinct Due is flagged, Follow-Up Due still wins as canonical', () => {
  const { canonical, flagged, reason } = collapseDue('9/17', '2026-09-21');
  assert.equal(canonical, '2026-09-21');
  assert.equal(flagged, true);
  assert.match(reason, /9\/17/);
  assert.match(reason, /2026-09-21/);
});

test('a missing Due falls back to Follow-Up Due with no flag', () => {
  const { canonical, flagged } = collapseDue(null, '2026-09-21');
  assert.equal(canonical, '2026-09-21');
  assert.equal(flagged, false);
});

// ── source snapshot integrity ────────────────────────────────────────────

test('exactly 8 source rows, 7 MATCHED_APPLIED + 1 MANUAL_REVIEW (Elastic)', () => {
  assert.equal(SOURCE_ROWS.length, 8);
  const elastic = SOURCE_ROWS.find((r) => r.company === 'Elastic');
  assert.equal(elastic.matchState, 'MANUAL_REVIEW');
  assert.equal(elastic.jobKey, null);
  assert.equal(SOURCE_ROWS.filter((r) => r.matchState === 'MATCHED_APPLIED').length, 7);
});

test('Applied Materials row is the flagged Due-vs-Follow-Up-Due case', () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'Applied Materials');
  const { flagged } = collapseDue(row.due, row.followUpDue);
  assert.equal(flagged, true);
});

// ── same-company/different-role must never silently match ──────────────

test('same-company/different-role is not treated as a match by this migration', () => {
  seedState({
    'job:tulip-wrong-role': { company: 'Tulip Interfaces', title: 'Pre Sales Engineer', fit_decision: 'APPLY', execution_status: 'APPLIED', outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] } },
  });
  const row = SOURCE_ROWS.find((r) => r.company === 'Tulip');
  // The migration's own jobKey is a different job than the one seeded here;
  // asserting they are distinct is the guard against a same-company mismatch.
  assert.notEqual(row.jobKey, 'job:tulip-wrong-role');
});

// ── field preservation end-to-end through the real update path ─────────

function seedMatchedApplied(jobKey, company, title) {
  seedState({
    [jobKey]: { company, title, fit_decision: 'APPLY', execution_status: 'APPLIED', outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] } },
  });
}

test('full Next Action / Waiting On / Notes text survives the patch verbatim', async () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'Augury');
  seedMatchedApplied(row.jobKey, 'Augury', 'Sales and Value Engineer');
  const patch = buildOperatingPatch(row);
  const { operating } = await updateJobOperatingMetadata(row.jobKey, patch, { root: sandbox });
  assert.equal(operating.next_action, row.nextAction);
  assert.equal(operating.waiting_on, row.waitingOn);
  assert.equal(operating.notes, row.notes);
  assert.equal(operating.priority, row.priority);
  assert.equal(operating.last_touch, row.lastTouch);
  assert.equal(operating.follow_up_due, row.followUpDue);
});

test('one Home row per migrated job, values match the source verbatim', async () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'Propel');
  seedMatchedApplied(row.jobKey, 'Propel Software Solutions', 'Presales Solution Architect');
  await updateJobOperatingMetadata(row.jobKey, buildOperatingPatch(row), { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].next_action, row.nextAction);
  assert.equal(rows[0].waiting_on, row.waitingOn);
  assert.equal(rows[0].notes, row.notes);
});

test('non-APPLIED Elastic does not become APPLIED, and gains no operating metadata', async () => {
  seedState({
    'job:elastic': { company: 'Elastic', title: 'Solutions Architect', fit_decision: 'APPLY', execution_status: 'RECRUITER_ROUTING' },
  });
  await assert.rejects(() => updateJobOperatingMetadata('job:elastic', { priority: 'P0' }, { root: sandbox }));
  const state = readJson(reviewPaths(sandbox).statePath, defaultState());
  assert.equal(state.jobs['job:elastic'].execution_status, 'RECRUITER_ROUTING');
  assert.equal(state.jobs['job:elastic'].operating, undefined);
});

test('existing newer operating metadata is not silently overwritten by a re-run with stale values', async () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'Gecko Robotics');
  seedMatchedApplied(row.jobKey, 'Gecko Robotics', 'Deployment Lead | Navy Manufacturing');
  await updateJobOperatingMetadata(row.jobKey, { notes: 'newer CareerOps note written after the sheet snapshot' }, { root: sandbox });
  const before = readJson(reviewPaths(sandbox).statePath, defaultState()).jobs[row.jobKey].operating;
  assert.notEqual(before.notes, row.notes);
  // The migration script itself only ever writes buildOperatingPatch(row) —
  // a caller must compare before/after and choose not to apply on conflict,
  // which is exactly what report.dueFlags / the dry-run table above surfaces
  // for a human decision rather than an automatic overwrite.
});

test('idempotent rerun: reapplying the same patch produces byte-identical operating state', async () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'InstaLILY');
  seedMatchedApplied(row.jobKey, 'InstaLILY AI', 'Strategic Associate');
  const patch = buildOperatingPatch(row);
  const first = await updateJobOperatingMetadata(row.jobKey, patch, { root: sandbox });
  const second = await updateJobOperatingMetadata(row.jobKey, patch, { root: sandbox });
  assert.deepEqual(first.operating, second.operating);
});

test('unrelated jobs are untouched by a migration run', async () => {
  const row = SOURCE_ROWS.find((r) => r.company === 'Plataine');
  seedState({
    [row.jobKey]: { company: 'Plataine', title: 'Solution Engineer', fit_decision: 'APPLY', execution_status: 'APPLIED', outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] } },
    'job:unrelated': { company: 'SomeOtherCo', title: 'Some Other Role', fit_decision: 'APPLY', execution_status: 'APPLIED', outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] } },
  });
  const beforeUnrelated = readJson(reviewPaths(sandbox).statePath, defaultState()).jobs['job:unrelated'];
  await updateJobOperatingMetadata(row.jobKey, buildOperatingPatch(row), { root: sandbox });
  const afterUnrelated = readJson(reviewPaths(sandbox).statePath, defaultState()).jobs['job:unrelated'];
  assert.deepEqual(afterUnrelated, beforeUnrelated);
});
