// tests/applications-view.test.mjs — Pass 2 "What Is Alive?" Applications
// board. Exercises ui-server.mjs's listApplications() read helper: the
// smallest usable view answering "what have I actually applied to, and is it
// still alive?" Read-only by construction — this suite never calls a mutating
// review.mjs/outreach.mjs function outside its own isolated fixture root.

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { listApplications } from '../ui-server.mjs';

function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-applications-view-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

function writeState(root, jobs) {
  const state = { schema_version: 1, updated_at: new Date().toISOString(), ingested_batches: {}, jobs };
  writeFileSync(join(root, 'data', 'review-state.json'), JSON.stringify(state, null, 2) + '\n');
}

async function main() {
  const root = scratchRoot();
  writeState(root, {
    'url:https://example.com/jobs/ready-not-applied': {
      fit_decision: 'APPLY',
      execution_status: 'READY_TO_APPLY',
      company: 'NotYetCo',
      title: 'Ready Role',
      url: 'https://example.com/jobs/ready-not-applied',
    },
    'url:https://example.com/jobs/not-applying': {
      fit_decision: 'APPLY',
      execution_status: 'NOT_APPLYING',
      company: 'PassedCo',
      title: 'Passed Role',
      url: 'https://example.com/jobs/not-applying',
      closed_at: '2026-09-10T00:00:00.000Z',
      closed_reason: 'USER_PASS',
    },
    'url:https://example.com/jobs/live-active': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'LiveCo',
      title: 'Live Workflow Role',
      url: 'https://example.com/jobs/live-active',
      applied_at: '2026-09-16T20:36:00.000Z',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [] },
      // No application_status/stage/last_update — this is the live-workflow
      // shape (markApplied() never sets those; only the historical migration
      // does). Must still surface as ACTIVE/alive.
    },
    'url:https://example.com/jobs/legacy-active': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'LegacyActiveCo',
      title: 'Legacy Active Role',
      url: 'https://example.com/jobs/legacy-active',
      applied_at: '2026-09-03T00:00:00.000Z',
      application_status: 'ACTIVE',
      application_stage: 'Applied',
      application_last_update: '2026-09-03',
      outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    },
    'url:https://example.com/jobs/legacy-stale': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'LegacyStaleCo',
      title: 'Legacy Stale Role',
      url: 'https://example.com/jobs/legacy-stale',
      applied_at: '2026-09-01T00:00:00.000Z',
      application_status: 'STALE',
      application_stage: 'Applied — orphaned req',
      application_last_update: '2026-09-01',
      outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    },
    'url:https://example.com/jobs/legacy-rejected': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'RejectedCo',
      title: 'Rejected Role',
      url: 'https://example.com/jobs/legacy-rejected',
      applied_at: '2026-08-26T00:00:00.000Z',
      application_status: 'REJECTED',
      application_stage: 'Rejected',
      application_last_update: '2026-08-31',
      legacy_sheet: { outreach_status_raw: 'Sent - no reply', source: 'sheet' },
    },
    'url:https://example.com/jobs/legacy-closed': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'ClosedCo',
      title: 'Closed Role',
      url: 'https://example.com/jobs/legacy-closed',
      applied_at: '2026-09-13T00:00:00.000Z',
      application_status: 'CLOSED',
      application_stage: 'Skipped',
      application_last_update: '2026-09-13',
    },
    'url:https://example.com/jobs/legacy-withdrawn': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'WithdrawnCo',
      title: 'Withdrawn Role',
      url: 'https://example.com/jobs/legacy-withdrawn',
      applied_at: '2026-09-05T00:00:00.000Z',
      application_status: 'WITHDRAWN',
      application_stage: 'Withdrawn',
      application_last_update: '2026-09-05',
    },
    'url:https://example.com/jobs/legacy-unknown': {
      fit_decision: 'APPLY',
      execution_status: 'APPLIED',
      company: 'UnknownCo',
      title: 'Unknown Status Role',
      url: 'https://example.com/jobs/legacy-unknown',
      applied_at: '2026-09-02T00:00:00.000Z',
      application_status: 'UNKNOWN',
      application_stage: 'Applied',
      application_last_update: '2026-09-02',
    },
  });

  // ── membership ────────────────────────────────────────────────────────
  const all = listApplications('all', root);
  const allCompanies = all.map((a) => a.company).sort();
  if (!allCompanies.includes('NotYetCo')) pass('READY_TO_APPLY job does not appear in Applications');
  else fail('READY_TO_APPLY job leaked into Applications');
  if (!allCompanies.includes('PassedCo')) pass('NOT_APPLYING job does not appear in Applications');
  else fail('NOT_APPLYING job leaked into Applications');
  if (allCompanies.includes('LiveCo')) pass('APPLIED (live workflow) job appears in Applications');
  else fail('live-workflow APPLIED job missing from Applications');
  if (all.length === 7) pass(`All returns every submitted application (7): ${allCompanies}`);
  else fail(`expected 7 submitted applications, got ${all.length}: ${allCompanies}`);

  // ── alive / closed filtering ─────────────────────────────────────────
  const alive = listApplications('alive', root);
  const aliveCompanies = alive.map((a) => a.company).sort();
  const expectedAlive = ['LegacyActiveCo', 'LegacyStaleCo', 'LiveCo'].sort();
  if (JSON.stringify(aliveCompanies) === JSON.stringify(expectedAlive)) {
    pass('Alive filter returns exactly ACTIVE + STALE (including the live-workflow job with no application_status)');
  } else fail(`Alive filter wrong: ${JSON.stringify(aliveCompanies)}, expected ${JSON.stringify(expectedAlive)}`);

  const closed = listApplications('closed', root);
  const closedCompanies = closed.map((a) => a.company).sort();
  const expectedClosed = ['ClosedCo', 'RejectedCo', 'WithdrawnCo'].sort();
  if (JSON.stringify(closedCompanies) === JSON.stringify(expectedClosed)) {
    pass('Closed filter returns exactly REJECTED + CLOSED + WITHDRAWN, and excludes UNKNOWN');
  } else fail(`Closed filter wrong: ${JSON.stringify(closedCompanies)}, expected ${JSON.stringify(expectedClosed)}`);

  if (allCompanies.includes('UnknownCo')) pass('UNKNOWN status appears in All');
  else fail('UNKNOWN status missing from All');
  if (!aliveCompanies.includes('UnknownCo') && !closedCompanies.includes('UnknownCo')) {
    pass('UNKNOWN status is excluded from both Alive and Closed');
  } else fail('UNKNOWN status leaked into Alive or Closed');

  // ── default filter defaults to alive ─────────────────────────────────
  const defaultFiltered = listApplications(undefined, root);
  if (JSON.stringify(defaultFiltered.map((a) => a.company).sort()) === JSON.stringify(expectedAlive)) {
    pass('omitting filter defaults to Alive');
  } else fail('default filter did not default to Alive');

  // ── historical rejected record appears Closed; current active appears Alive
  const rejectedRow = closed.find((a) => a.company === 'RejectedCo');
  if (rejectedRow && rejectedRow.application_status === 'REJECTED') pass('historical rejected record surfaces its true REJECTED status');
  else fail('rejected historical record did not surface REJECTED');
  const liveRow = alive.find((a) => a.company === 'LiveCo');
  if (liveRow && liveRow.application_status === 'ACTIVE') pass('current live-workflow application surfaces as ACTIVE');
  else fail('current live-workflow application did not surface as ACTIVE');

  // ── sorting: most recent activity first, deterministic ───────────────
  const aliveOrder = alive.map((a) => a.company);
  // LiveCo (applied_at 2026-09-16, no last_update) should sort ahead of
  // LegacyActiveCo (last_update 2026-09-03) and LegacyStaleCo (2026-09-01).
  if (aliveOrder[0] === 'LiveCo' && aliveOrder[1] === 'LegacyActiveCo' && aliveOrder[2] === 'LegacyStaleCo') {
    pass('sorting is most-recent-activity-first, applied_at falling back correctly against application_last_update');
  } else fail(`sort order wrong: ${JSON.stringify(aliveOrder)}`);

  // Re-running with the same fixture must produce the same order (determinism).
  const aliveAgain = listApplications('alive', root).map((a) => a.company);
  if (JSON.stringify(aliveAgain) === JSON.stringify(aliveOrder)) pass('sort order is deterministic across repeated calls');
  else fail('sort order changed between identical calls');

  // ── outreach rendering: current vs historical-legacy text ────────────
  if (liveRow.outreach === 'Contacts Selected') pass('current outreach state renders humanized (Contacts Selected)');
  else fail(`current outreach rendering wrong: ${JSON.stringify(liveRow.outreach)}`);

  const closedRejected = closed.find((a) => a.company === 'RejectedCo');
  if (closedRejected.outreach === 'Sent - no reply') {
    pass('historical legacy outreach text renders without becoming a current workflow status');
  } else fail(`legacy outreach rendering wrong: ${JSON.stringify(closedRejected.outreach)}`);

  // ── production safety: this is a pure read, never mutates state ──────
  const beforeRead = listApplications('all', root);
  const afterRead = listApplications('all', root);
  if (JSON.stringify(beforeRead) === JSON.stringify(afterRead)) pass('repeated reads are idempotent (no mutation as a side effect)');
  else fail('reading Applications appears to mutate state between calls');
}

try {
  await main();
} catch (err) {
  fail(`applications-view.test.mjs crashed: ${err.stack || err.message}`);
}
