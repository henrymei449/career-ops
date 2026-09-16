// tests/application-status-update.test.mjs — Pass 5 "Applications -> Update
// Status": outreach.mjs's updateApplicationStatus() and
// application-schema.mjs's mapUiApplicationStatus(). Exercises the exact
// acceptance fixtures from the Pass 5 spec (section 11): ACTIVE -> REJECTED
// / ROLE_CLOSED / WITHDRAWN, exact-record identity, idempotency, and
// closure -> Follow-up (Home) suppression.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-app-status-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { updateApplicationStatus, listFollowUpActions } = await import('../outreach.mjs');
const { mapUiApplicationStatus, APPLICATION_UI_STATUSES } = await import('../application-schema.mjs');
const { reviewPaths, defaultState, readJson } = await import('../review.mjs');
const { listApplications } = await import('../ui-server.mjs');

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

function readState() {
  return readJson(reviewPaths(sandbox).statePath, defaultState());
}

// ── mapUiApplicationStatus (pure) ───────────────────────────────────────

test('mapUiApplicationStatus: canonical field mapping for every UI choice', () => {
  assert.deepEqual(mapUiApplicationStatus('ACTIVE'), { application_status: 'ACTIVE', application_outcome: null, application_stage: null });
  assert.deepEqual(mapUiApplicationStatus('REJECTED'), { application_status: 'REJECTED', application_outcome: 'REJECTED', application_stage: 'Rejected' });
  assert.deepEqual(mapUiApplicationStatus('ROLE_CLOSED'), { application_status: 'CLOSED', application_outcome: 'ROLE_CLOSED', application_stage: 'Role Closed' });
  assert.deepEqual(mapUiApplicationStatus('WITHDRAWN'), { application_status: 'WITHDRAWN', application_outcome: 'WITHDRAWN', application_stage: 'Withdrawn' });
});

test('mapUiApplicationStatus rejects an unknown choice', () => {
  assert.throws(() => mapUiApplicationStatus('HIRED'));
});

test('APPLICATION_UI_STATUSES is exactly the four spec choices', () => {
  assert.deepEqual(APPLICATION_UI_STATUSES, ['ACTIVE', 'REJECTED', 'ROLE_CLOSED', 'WITHDRAWN']);
});

// ── updateApplicationStatus (durable mutation) ──────────────────────────

function seedApplied(jobKey, company) {
  seedState({
    [jobKey]: {
      company, title: 'Vision Sales Engineer (U.S. – Expansion)', fit_decision: 'APPLY', execution_status: 'APPLIED',
      applied_at: '2026-09-01T00:00:00.000Z',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
}

test('ACTIVE -> REJECTED: canonical fields set, application_last_update stamped, note preserved', async () => {
  seedApplied('url:https://example.com/overview-us', 'Overview');
  const job = await updateApplicationStatus('url:https://example.com/overview-us', 'REJECTED', { updateDate: '2026-09-16', note: 'Recruiter said no.', root: sandbox });
  assert.equal(job.application_status, 'REJECTED');
  assert.equal(job.application_outcome, 'REJECTED');
  assert.equal(job.application_stage, 'Rejected');
  assert.equal(job.application_last_update, '2026-09-16');
  assert.equal(job.application_history.length, 1);
  assert.equal(job.application_history[0].note, 'Recruiter said no.');
  assert.equal(job.application_history[0].ui_status, 'REJECTED');
});

test('ACTIVE -> ROLE_CLOSED: the exact Overview scenario from the spec (section 7)', async () => {
  const jobKey = 'url:https://example.com/overview-us-expansion';
  seedApplied(jobKey, 'Overview');
  const note = 'Recruiter confirmed original U.S. Expansion requisition is no longer open. Only separate SF-based Vision Sales Engineer role remains.';
  const job = await updateApplicationStatus(jobKey, 'ROLE_CLOSED', { updateDate: '2026-09-16', note, root: sandbox });
  assert.equal(job.application_status, 'CLOSED');
  assert.equal(job.application_outcome, 'ROLE_CLOSED');
  assert.equal(job.application_stage, 'Role Closed');
  assert.equal(job.application_history[0].note, note);

  // exact-record identity: no sibling job was created or touched
  const state = readState();
  assert.equal(Object.keys(state.jobs).length, 1);
  assert.equal(state.jobs[jobKey].company, 'Overview');
  assert.equal(state.jobs[jobKey].title, 'Vision Sales Engineer (U.S. – Expansion)');
});

test('ACTIVE -> WITHDRAWN', async () => {
  const jobKey = 'url:https://example.com/withdraw-me';
  seedApplied(jobKey, 'WithdrawCo');
  const job = await updateApplicationStatus(jobKey, 'WITHDRAWN', { updateDate: '2026-09-16', root: sandbox });
  assert.equal(job.application_status, 'WITHDRAWN');
  assert.equal(job.application_outcome, 'WITHDRAWN');
  assert.equal(job.application_stage, 'Withdrawn');
});

test('rejects a job that has not reached execution_status=APPLIED', async () => {
  seedState({
    'url:https://example.com/not-applied-yet': {
      company: 'TooSoonCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'READY_TO_APPLY',
    },
  });
  await assert.rejects(
    () => updateApplicationStatus('url:https://example.com/not-applied-yet', 'REJECTED', { root: sandbox }),
    /not APPLIED/,
  );
});

test('rejects a future update date', async () => {
  const jobKey = 'url:https://example.com/future-date';
  seedApplied(jobKey, 'FutureCo');
  await assert.rejects(
    () => updateApplicationStatus(jobKey, 'REJECTED', { updateDate: '2099-01-01', root: sandbox }),
    /future/,
  );
});

test('rejects an unknown job_key rather than silently creating one', async () => {
  await assert.rejects(() => updateApplicationStatus('url:https://example.com/does-not-exist', 'REJECTED', { root: sandbox }));
});

test('idempotent resubmission: identical (status, date, note) does not append a duplicate history entry', async () => {
  const jobKey = 'url:https://example.com/idempotent-check';
  seedApplied(jobKey, 'IdemCo');
  await updateApplicationStatus(jobKey, 'REJECTED', { updateDate: '2026-09-16', note: 'same note', root: sandbox });
  const job2 = await updateApplicationStatus(jobKey, 'REJECTED', { updateDate: '2026-09-16', note: 'same note', root: sandbox });
  assert.equal(job2.application_history.length, 1, 'resubmitting the identical mutation must not duplicate the history entry');
  assert.equal(job2.application_status, 'REJECTED'); // flat fields still correctly reflect the (unchanged) state
});

test('a genuinely new mutation on the same job appends a second history entry without erasing the first', async () => {
  const jobKey = 'url:https://example.com/history-preserved';
  seedApplied(jobKey, 'HistoryCo');
  await updateApplicationStatus(jobKey, 'REJECTED', { updateDate: '2026-09-10', note: 'first pass', root: sandbox });
  const job2 = await updateApplicationStatus(jobKey, 'WITHDRAWN', { updateDate: '2026-09-16', note: 'actually withdrawing', root: sandbox });
  assert.equal(job2.application_history.length, 2);
  assert.equal(job2.application_history[0].note, 'first pass');
  assert.equal(job2.application_history[1].note, 'actually withdrawing');
  assert.equal(job2.application_status, 'WITHDRAWN');
});

test('updating one job never touches an unrelated job (a same-company sibling requisition)', async () => {
  seedState({
    'url:https://example.com/overview-us': {
      company: 'Overview', title: 'Vision Sales Engineer (U.S. – Expansion)', fit_decision: 'APPLY', execution_status: 'APPLIED',
      applied_at: '2026-09-01T00:00:00.000Z',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
    'url:https://example.com/overview-sf': {
      company: 'Overview', title: 'Vision Sales Engineer (SF)', fit_decision: 'APPLY', execution_status: 'APPLIED',
      applied_at: '2026-09-05T00:00:00.000Z',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  await updateApplicationStatus('url:https://example.com/overview-us', 'ROLE_CLOSED', { updateDate: '2026-09-16', root: sandbox });
  const state = readState();
  assert.equal(state.jobs['url:https://example.com/overview-us'].application_status, 'CLOSED');
  assert.equal(state.jobs['url:https://example.com/overview-sf'].application_status, undefined, 'the sibling SF requisition must be completely untouched');
});

// ── closure -> Applications/Home suppression ────────────────────────────

test('closing an application removes it from Applications > Alive, adds it to Closed, and suppresses its Home row', async () => {
  const jobKey = 'url:https://example.com/closure-flow';
  seedState({
    [jobKey]: {
      company: 'ClosureCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      applied_at: '2026-09-01T00:00:00.000Z',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Pending Contact', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
  });

  const aliveBefore = listApplications('alive', sandbox);
  assert.ok(aliveBefore.some((a) => a.company === 'ClosureCo'));
  const homeBefore = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(homeBefore.length, 1);
  assert.equal(homeBefore[0].action, 'SEND_EMAIL');

  await updateApplicationStatus(jobKey, 'REJECTED', { updateDate: TODAY, root: sandbox });

  const aliveAfter = listApplications('alive', sandbox);
  assert.ok(!aliveAfter.some((a) => a.company === 'ClosureCo'), 'closed application must leave Alive');
  const closedAfter = listApplications('closed', sandbox);
  assert.ok(closedAfter.some((a) => a.company === 'ClosureCo'), 'closed application must appear in Closed');
  const homeAfter = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(homeAfter.length, 0, 'no unresolved Home/Follow-up action for a closed application');

  // historical evidence preserved: the contact record itself is untouched,
  // never silently flipped to SKIPPED.
  const state = readState();
  const contact = state.jobs[jobKey].outreach.selected_contacts[0];
  assert.equal(contact.status, 'CONTACT_SELECTED');
  assert.equal(contact.next_action, 'SEND_EMAIL');
});
