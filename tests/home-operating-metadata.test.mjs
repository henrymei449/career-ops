// tests/home-operating-metadata.test.mjs — Home operating-metadata MVP
// (Priority/Last Touch/Next Action/Waiting On/Follow-Up Due/Notes), the
// job-level operator loop that works even when a job has no contact.
// Mirrors tests/home-inline-edit.test.mjs's seeding pattern against an
// isolated sandbox data root.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-home-operating-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { listFollowUpActions, updateJobOperatingMetadata } = await import('../outreach.mjs');
const { reviewPaths, defaultState, readJson } = await import('../review.mjs');
const { buildHomeRows } = await import('../followup-schema.mjs');

after(() => {
  if (priorRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = priorRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const TODAY = '2026-09-16';
const TOMORROW = '2026-09-17';

function seedState(jobs) {
  const p = reviewPaths(sandbox);
  mkdirSync(p.base, { recursive: true });
  mkdirSync(p.open, { recursive: true });
  writeFileSync(p.statePath, JSON.stringify({ ...defaultState(), jobs }, null, 2));
}

function seedNoContact() {
  seedState({
    'job:uptimeai': {
      company: 'UptimeAI', title: 'Technical Consultant (US)', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
}

function seedWithContact() {
  seedState({
    'job:elastic': {
      company: 'Elastic', title: 'Solutions Architect', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-russell', name: 'Russell', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', channel: null, next_action: 'CHECK_CONNECTION', next_action_due: TODAY },
      ] },
    },
  });
}

test('a job with no contact can receive a job-level next_action', async () => {
  seedNoContact();
  const { operating } = await updateJobOperatingMetadata('job:uptimeai', { next_action: 'Follow up on outreach' }, { root: sandbox });
  assert.equal(operating.next_action, 'Follow up on outreach');
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].next_action, 'Follow up on outreach');
});

test('a job with no contact can receive a job-level follow_up_due, and Status recomputes from it', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { follow_up_due: TODAY }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].due_at, TODAY);
  assert.equal(rows[0].bucket, 'TODAY');
  assert.equal(rows[0].status, 'ACTION DUE');
});

test('priority update persists and surfaces on the Home row', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { priority: 'P1' }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].priority, 'P1');
});

test('last_touch update persists', async () => {
  seedNoContact();
  const { operating } = await updateJobOperatingMetadata('job:uptimeai', { last_touch: TODAY }, { root: sandbox });
  assert.equal(operating.last_touch, TODAY);
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].last_touch, TODAY);
});

test('waiting_on update persists', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { waiting_on: 'recruiter response' }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].waiting_on, 'recruiter response');
});

test('notes update persists', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { notes: 'prior contact already made' }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].notes, 'prior contact already made');
});

test('quick Tomorrow/+3/+7-style follow_up_due updates move the bucket accordingly', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { follow_up_due: TOMORROW }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].due_at, TOMORROW);
  assert.equal(rows[0].bucket, 'UPCOMING');
  assert.equal(rows[0].status, 'WAITING');
});

test('job-level operating next_action/follow_up_due override the contact-derived display', async () => {
  seedWithContact();
  const before = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(before[0].next_action, 'CHECK_CONNECTION'); // contact-derived, no job-level override yet
  await updateJobOperatingMetadata('job:elastic', { next_action: 'casually bump Russell', follow_up_due: TOMORROW }, { root: sandbox });
  const after1 = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(after1[0].next_action, 'casually bump Russell');
  assert.equal(after1[0].due_at, TOMORROW);
  assert.equal(after1[0].bucket, 'UPCOMING');
  // The underlying contact action itself is untouched — the override is read-time only.
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  const contactAction = actions.find((a) => a.contact_id === 'c-russell');
  assert.equal(contactAction.action, 'CHECK_CONNECTION');
  assert.equal(contactAction.due_at, TODAY);
});

test('contact-level action still used when no job-level override exists', async () => {
  seedWithContact();
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows[0].next_action, 'CHECK_CONNECTION');
  assert.equal(rows[0].due_at, TODAY);
  assert.equal(rows[0].contact_next_action, 'CHECK_CONNECTION');
  assert.equal(rows[0].contact_due_at, TODAY);
});

test('one Home row per job remains true after setting operating metadata', async () => {
  seedWithContact();
  await updateJobOperatingMetadata('job:elastic', { priority: 'P0', notes: 'resume sent' }, { root: sandbox });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows.length, 1);
});

test('terminal jobs remain absent from Home even with operating metadata set before closure', async () => {
  seedState({
    'job:closed': {
      company: 'ClosedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      application_status: 'REJECTED',
      operating: { priority: 'P0', last_touch: TODAY, next_action: 'ignored', waiting_on: null, follow_up_due: TODAY, notes: null },
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  const rows = buildHomeRows(listFollowUpActions({ root: sandbox, today: TODAY }), TODAY);
  assert.equal(rows.length, 0);
});

test('repeated identical operating updates are idempotent', async () => {
  seedNoContact();
  const first = await updateJobOperatingMetadata('job:uptimeai', { priority: 'P2', waiting_on: 'response' }, { root: sandbox });
  const second = await updateJobOperatingMetadata('job:uptimeai', { priority: 'P2', waiting_on: 'response' }, { root: sandbox });
  assert.deepEqual(first.operating, second.operating);
});

test('unrelated job state is unchanged by an operating update', async () => {
  seedWithContact();
  const before = readJson(reviewPaths(sandbox).statePath, defaultState());
  await updateJobOperatingMetadata('job:elastic', { priority: 'P3' }, { root: sandbox });
  const after1 = readJson(reviewPaths(sandbox).statePath, defaultState());
  assert.equal(after1.jobs['job:elastic'].fit_decision, before.jobs['job:elastic'].fit_decision);
  assert.equal(after1.jobs['job:elastic'].execution_status, before.jobs['job:elastic'].execution_status);
  assert.deepEqual(after1.jobs['job:elastic'].outreach, before.jobs['job:elastic'].outreach);
});

test('a patch omitting a field leaves that field untouched (true PATCH semantics)', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { priority: 'P1', notes: 'keep me' }, { root: sandbox });
  const { operating } = await updateJobOperatingMetadata('job:uptimeai', { priority: 'P2' }, { root: sandbox });
  assert.equal(operating.priority, 'P2');
  assert.equal(operating.notes, 'keep me');
});

test('an explicit null clears a field', async () => {
  seedNoContact();
  await updateJobOperatingMetadata('job:uptimeai', { waiting_on: 'something' }, { root: sandbox });
  const { operating } = await updateJobOperatingMetadata('job:uptimeai', { waiting_on: null }, { root: sandbox });
  assert.equal(operating.waiting_on, null);
});

test('an invalid priority is refused loudly, before any write', async () => {
  seedNoContact();
  await assert.rejects(() => updateJobOperatingMetadata('job:uptimeai', { priority: 'P9' }, { root: sandbox }));
  const state = readJson(reviewPaths(sandbox).statePath, defaultState());
  assert.equal(state.jobs['job:uptimeai'].operating, undefined);
});

test('an invalid date is refused loudly', async () => {
  seedNoContact();
  await assert.rejects(() => updateJobOperatingMetadata('job:uptimeai', { follow_up_due: 'not-a-date' }, { root: sandbox }));
  await assert.rejects(() => updateJobOperatingMetadata('job:uptimeai', { last_touch: '2026-13-40' }, { root: sandbox }));
});

test('an unbounded-length text field is refused', async () => {
  seedNoContact();
  await assert.rejects(() => updateJobOperatingMetadata('job:uptimeai', { notes: 'x'.repeat(501) }, { root: sandbox }));
});

test('an unknown patch field is refused', async () => {
  seedNoContact();
  await assert.rejects(() => updateJobOperatingMetadata('job:uptimeai', { fit_decision: 'PASS' }, { root: sandbox }));
});

test('operating metadata is refused on a non-APPLIED job', async () => {
  seedState({
    'job:notapplied': { company: 'NotAppliedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'READY_TO_APPLY' },
  });
  await assert.rejects(() => updateJobOperatingMetadata('job:notapplied', { priority: 'P0' }, { root: sandbox }));
});
