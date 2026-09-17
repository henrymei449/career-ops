// tests/home-inline-edit.test.mjs — Home inline action/date/stage editing
// (Pass 6). Exercises outreach.mjs's updateFollowUpAction/
// updateApplicationStage against an isolated sandbox data root, mirroring
// tests/followup-actions.test.mjs's seeding pattern. Home's job-level
// aggregation itself (buildHomeRows) is unmodified by this pass — those
// tests (tests/home-job-level-rows.test.mjs, tests/home-application-coverage
// .test.mjs) stay as the regression guard that this pass adds no drift to.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-home-inline-edit-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { listFollowUpActions, updateFollowUpAction, updateApplicationStage } = await import('../outreach.mjs');
const { reviewPaths, defaultState } = await import('../review.mjs');
const { buildHomeRows } = await import('../followup-schema.mjs');

after(() => {
  if (priorRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = priorRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const TODAY = '2026-09-16';
const TOMORROW = '2026-09-17';
const PLUS3 = '2026-09-19';
const PLUS7 = '2026-09-23';

function seedState(jobs) {
  const p = reviewPaths(sandbox);
  mkdirSync(p.base, { recursive: true });
  mkdirSync(p.open, { recursive: true });
  writeFileSync(p.statePath, JSON.stringify({ ...defaultState(), jobs }, null, 2));
}

function seedUptimeAI() {
  seedState({
    'job:uptimeai': {
      company: 'UptimeAI', title: 'Technical Consultant (US)', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-original', name: 'Original contact', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', channel: null, next_action: 'FOLLOW_UP', next_action_due: TODAY },
      ] },
    },
  });
}

test('updating the due date (Tomorrow quick action) moves the row from ACTION DUE (TODAY) to WAITING/UPCOMING', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(before.length, 1);
  assert.equal(before[0].bucket, 'TODAY');
  const { contact } = await updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox });
  assert.equal(contact.next_action, 'FOLLOW_UP');
  assert.equal(contact.next_action_due, TOMORROW);
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1.length, 1);
  assert.equal(after1[0].bucket, 'UPCOMING');
  const rows = buildHomeRows(after1);
  assert.equal(rows[0].status, 'WAITING'); // UPCOMING maps to WAITING per deriveHomeStatus
  assert.equal(rows[0].due_at, TOMORROW);
});

test('+3 days and +7 days quick actions set the exact computed date', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  await updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: PLUS3 }, { root: sandbox });
  let after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1[0].due_at, PLUS3);

  await updateFollowUpAction(after1[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: PLUS7 }, { root: sandbox });
  after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1[0].due_at, PLUS7);
});

test('Clear (nextAction=null) wipes both next_action and next_action_due together', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  const { contact } = await updateFollowUpAction(before[0].action_id, { nextAction: null }, { root: sandbox });
  assert.equal(contact.next_action, null);
  assert.equal(contact.next_action_due, null);
  // OUTREACH_SENT + no next_action still falls back to WAITING (deriveBucket) — the
  // application itself stays represented on Home, not silently dropped.
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1.length, 1);
  assert.equal(after1[0].bucket, 'WAITING');
  assert.equal(after1[0].contact_id, 'c-original');
});

test('changing the action value alone (same due date) is accepted', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  const { contact } = await updateFollowUpAction(before[0].action_id, { nextAction: 'CHECK_CONNECTION', nextActionDue: TODAY }, { root: sandbox });
  assert.equal(contact.next_action, 'CHECK_CONNECTION');
  assert.equal(contact.next_action_due, TODAY);
});

test('an invalid next_action value is refused loudly, before any write', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  await assert.rejects(() => updateFollowUpAction(before[0].action_id, { nextAction: 'DO_A_BACKFLIP' }, { root: sandbox }));
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.deepEqual(after1, before); // untouched
});

test('an invalid due date is refused loudly', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  await assert.rejects(() => updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: 'not-a-date' }, { root: sandbox }));
  await assert.rejects(() => updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: '2026-13-40' }, { root: sandbox }));
});

test('an unknown action_id (including a synthetic ap- fallback id) is refused — never manufactures a contact', async () => {
  seedState({
    'job:fallback': {
      company: 'FallbackCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(before[0].action, 'APPLICATION_PENDING');
  assert.match(before[0].action_id, /^ap-/);
  await assert.rejects(() => updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox }));
  // state genuinely untouched — still exactly the fallback row, no contact invented
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.deepEqual(after1, before);
});

test('editing the primary Home action on a job with a folded secondary contact leaves the secondary untouched (the Tulip case)', async () => {
  seedState({
    'job:tulip': {
      company: 'Tulip Interfaces', title: 'Continuous Improvement Project Manager', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-holly', name: 'Holly Coode', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', channel: 'EMAIL', next_action: 'FOLLOW_UP', next_action_due: PLUS7 },
        { candidate_id: 'c-marshall', name: 'Marshall Riccardi', lane: 'FUNCTIONAL', score: 60, status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', next_action: 'CHECK_CONNECTION', next_action_due: null },
      ] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  const rows = buildHomeRows(actions);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.contact_id, 'c-holly'); // Holly's dated UPCOMING beats Marshall's undated WAITING
  assert.equal(row.extra_count, 1);

  await updateFollowUpAction(row.action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox });

  const afterActions = listFollowUpActions({ root: sandbox, today: TODAY });
  const holly = afterActions.find((a) => a.contact_name === 'Holly Coode');
  const marshall = afterActions.find((a) => a.contact_name === 'Marshall Riccardi');
  assert.equal(holly.due_at, TOMORROW);
  // Marshall (the folded secondary) is byte-for-byte unchanged
  assert.equal(marshall.action, 'CHECK_CONNECTION');
  assert.equal(marshall.due_at, null);
  assert.equal(marshall.bucket, 'WAITING');
});

test('stage change: a known HIRING_STAGES value is accepted and persists', async () => {
  seedState({
    'job:stagetest': {
      company: 'StageCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      application_stage: 'Applied',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  const result = await updateApplicationStage('job:stagetest', 'Interview', { root: sandbox });
  assert.equal(result.application_stage, 'Interview');
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions[0].application_stage, 'Interview');
});

test('stage change works on a plain WAITING job with no contact action at all (the Salsify case) — no contact is invented', async () => {
  seedState({
    'job:salsify': {
      company: 'Salsify', title: 'Solutions Consultant II', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    },
  });
  const result = await updateApplicationStage('job:salsify', 'Recruiter Screen', { root: sandbox });
  assert.equal(result.application_stage, 'Recruiter Screen');
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].contact_id, null); // still the synthetic fallback — no contact was invented
  assert.equal(actions[0].application_stage, 'Recruiter Screen');
});

test('an unknown stage value is refused loudly', async () => {
  seedState({
    'job:badstage': {
      company: 'BadStageCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  await assert.rejects(() => updateApplicationStage('job:badstage', 'Freeform Text Not In Vocab', { root: sandbox }));
});

test('a stage change on a non-APPLIED job is refused', async () => {
  seedState({
    'job:notapplied': { company: 'NotAppliedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'READY_TO_APPLY' },
  });
  await assert.rejects(() => updateApplicationStage('job:notapplied', 'Interview', { root: sandbox }));
});

test('repeated identical saves are idempotent — same result, no drift, no duplicate history', async () => {
  seedUptimeAI();
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  const first = await updateFollowUpAction(before[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox });
  const afterActions = listFollowUpActions({ root: sandbox, today: TODAY });
  const second = await updateFollowUpAction(afterActions[0].action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox });
  assert.equal(first.contact.next_action, second.contact.next_action);
  assert.equal(first.contact.next_action_due, second.contact.next_action_due);
  const finalActions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(finalActions.length, 1); // no duplicate rows accumulated
});

test('Home row recomputes immediately from durable state — no cache, no stale bucket', async () => {
  seedUptimeAI();
  const before = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }));
  assert.equal(before[0].status, 'ACTION DUE'); // TODAY
  const action = listFollowUpActions({ root: sandbox, today: TODAY })[0];
  await updateFollowUpAction(action.action_id, { nextAction: 'FOLLOW_UP', nextActionDue: TOMORROW }, { root: sandbox });
  const after1 = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }));
  assert.equal(after1[0].status, 'WAITING'); // recomputed to UPCOMING/WAITING with no separate step
  assert.equal(after1.length, 1); // still exactly one row for the job
});
