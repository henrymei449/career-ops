// tests/home-application-coverage.test.mjs — Pass 5 scope amendment:
// Follow-up becomes Home, the operator's single live-application board.
// Every non-terminal APPLIED job must be represented, not just jobs with a
// pending contact action. Exercises outreach.mjs's listFollowUpActions()
// against isolated fixture state, per the amendment's section 9 acceptance
// list.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-home-coverage-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { listFollowUpActions } = await import('../outreach.mjs');
const { reviewPaths, defaultState } = await import('../review.mjs');
const { applicationPendingActionId } = await import('../followup-schema.mjs');

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

test('a live APPLIED job with no selected contacts at all gets a synthetic WAITING/APPLICATION_PENDING row (the Datch shape: WAIVED/COMPLETE, no contacts)', () => {
  seedState({
    'job:datch': {
      company: 'Datch', title: 'Sales Engineer', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].job_key, 'job:datch');
  assert.equal(actions[0].action, 'APPLICATION_PENDING');
  assert.equal(actions[0].bucket, 'WAITING');
  assert.equal(actions[0].action_id, applicationPendingActionId('job:datch'));
  assert.equal(actions[0].contact_id, null);
});

test('a live APPLIED job whose selected contacts are ALL resolved (executed, no pending next_action) still gets the fallback row, not silence', () => {
  seedState({
    'job:oden': {
      company: 'Oden', title: 'Solutions Engineer', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Rep', lane: 'RECRUITING', score: 90, status: 'COMPLETE', next_action: null, next_action_due: null },
      ] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'APPLICATION_PENDING');
  assert.equal(actions[0].bucket, 'WAITING');
});

test('a live APPLIED job with an explicit pending contact action shows the real action, not the fallback', () => {
  seedState({
    'job:ifs': {
      company: 'IFS', title: 'Customer Success Manager', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-dirkje', name: 'Dirkje', lane: 'RECRUITING', score: 0, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'SEND_EMAIL');
  assert.equal(actions[0].bucket, 'TODAY');
  assert.equal(actions[0].contact_name, 'Dirkje');
});

test('a job with BOTH a real pending action and other resolved contacts contributes only the real row(s) — no duplicate fallback for the same job', () => {
  seedState({
    'job:mixed': {
      company: 'MixedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Active', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: null },
        { candidate_id: 'c2', name: 'Done', lane: 'FUNCTIONAL', score: 50, status: 'COMPLETE', next_action: null, next_action_due: null },
      ] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].contact_name, 'Active');
  assert.equal(actions[0].bucket, 'WAITING');
});

test('non-APPLIED jobs (READY_TO_APPLY, NONE, NOT_APPLYING) never appear on Home, even non-terminal application_status', () => {
  seedState({
    'job:ready': { company: 'ReadyCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'READY_TO_APPLY' },
    'job:none': { company: 'NoneCo', title: 'Role', fit_decision: 'PASS', execution_status: 'NONE' },
    'job:passed': { company: 'PassedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'NOT_APPLYING' },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 0);
});

test('a terminal application (REJECTED/CLOSED/WITHDRAWN) never appears on Home, even with no explicit action', () => {
  seedState({
    'job:rejected': {
      company: 'RejectedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      application_status: 'REJECTED',
      outreach: { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    },
    'job:closed': {
      company: 'ClosedCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      application_status: 'CLOSED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Ghost', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
    'job:withdrawn': {
      company: 'WithdrawnCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      application_status: 'WITHDRAWN',
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 0);
});

test('production shape: IFS (explicit action), Samsara (explicit waiting action), Oden + Protiviti (fallback rows) all appear — Alive count matches Home job coverage', () => {
  seedState({
    'job:ifs': {
      company: 'IFS', title: 'Customer Success Manager', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-hannah', name: 'Hannah B', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: null },
        { candidate_id: 'c-dirkje', name: 'Dirkje', lane: 'RECRUITING', score: 0, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
    'job:samsara': {
      company: 'Samsara', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c-james', name: 'James Jackson', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: null },
      ] },
    },
    'job:oden': {
      company: 'Oden', title: 'Solutions Engineer', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
    'job:protiviti': {
      company: 'Protiviti', title: 'Manufacturing AI Manager', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  const jobKeys = new Set(actions.map((a) => a.job_key));
  assert.equal(jobKeys.size, 4, `expected all 4 live applications represented, got ${JSON.stringify([...jobKeys])}`);
  const oden = actions.find((a) => a.job_key === 'job:oden');
  const protiviti = actions.find((a) => a.job_key === 'job:protiviti');
  assert.equal(oden.action, 'APPLICATION_PENDING');
  assert.equal(protiviti.action, 'APPLICATION_PENDING');
  const ifsRows = actions.filter((a) => a.job_key === 'job:ifs');
  assert.ok(ifsRows.some((a) => a.action === 'SEND_EMAIL' && a.bucket === 'TODAY'), 'IFS shows its explicit TODAY/SEND_EMAIL row');
});

test('repeated calls (refresh) produce the same rows — no duplicate fallback rows accumulate', () => {
  seedState({
    'job:once': {
      company: 'OnceCo', title: 'Role', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] },
    },
  });
  const first = listFollowUpActions({ root: sandbox, today: TODAY });
  const second = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(first.length, 1);
  assert.deepEqual(first, second);
});
