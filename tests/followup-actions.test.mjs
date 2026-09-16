// tests/followup-actions.test.mjs — Pass 4 Follow-up dashboard: bucket
// derivation (followup-schema.mjs, pure) and the read/mutation layer
// (outreach.mjs's listFollowUpActions/completeFollowUpAction/
// skipFollowUpAction) against an isolated sandbox data root. Mirrors the
// acceptance-test fixture list in the Pass 4 spec (section 12) line for
// line so each spec line maps to one assertion here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'career-ops-followup-'));
const priorRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = sandbox;

const { deriveBucket, withContactActionDefaults, actionId, applicationPendingActionId } = await import('../followup-schema.mjs');
const { listFollowUpActions, completeFollowUpAction, skipFollowUpAction } = await import('../outreach.mjs');
const { reviewPaths, defaultState } = await import('../review.mjs');

after(() => {
  if (priorRoot === undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT = priorRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

const TODAY = '2026-09-16';
const YESTERDAY = '2026-09-15';
const TOMORROW = '2026-09-17';

// ── Pure bucket derivation ───────────────────────────────────────────────

test('CONTACT_SELECTED + SEND_EMAIL + due today -> TODAY', () => {
  const c = withContactActionDefaults({ status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY });
  assert.equal(deriveBucket(c, TODAY), 'TODAY');
});

test('OUTREACH_SENT + CHECK_CONNECTION + future due -> UPCOMING', () => {
  const c = withContactActionDefaults({ status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: TOMORROW });
  assert.equal(deriveBucket(c, TODAY), 'UPCOMING');
});

test('due date before today -> OVERDUE', () => {
  const c = withContactActionDefaults({ status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: YESTERDAY });
  assert.equal(deriveBucket(c, TODAY), 'OVERDUE');
});

test('OUTREACH_SENT + no current action -> WAITING', () => {
  const c = withContactActionDefaults({ status: 'OUTREACH_SENT' });
  assert.equal(deriveBucket(c, TODAY), 'WAITING');
});

test('OUTREACH_SENT + an action with no due date still surfaces as WAITING (no fabricated due date)', () => {
  const c = withContactActionDefaults({ status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: null });
  assert.equal(deriveBucket(c, TODAY), 'WAITING');
});

test('COMPLETE -> absent from actionable queue', () => {
  const c = withContactActionDefaults({ status: 'COMPLETE', next_action: 'SEND_EMAIL', next_action_due: TODAY });
  assert.equal(deriveBucket(c, TODAY), null);
});

test('SKIPPED -> absent from actionable queue', () => {
  const c = withContactActionDefaults({ status: 'SKIPPED', next_action: 'SEND_EMAIL', next_action_due: TODAY });
  assert.equal(deriveBucket(c, TODAY), null);
});

// ── listFollowUpActions / completeFollowUpAction / skipFollowUpAction ────

function seedState(jobs) {
  const p = reviewPaths(sandbox);
  mkdirSync(p.base, { recursive: true });
  mkdirSync(p.open, { recursive: true });
  writeFileSync(p.statePath, JSON.stringify({ ...defaultState(), jobs }, null, 2));
}

test('listFollowUpActions derives TODAY/UPCOMING/OVERDUE/WAITING rows and skips COMPLETE/SKIPPED contacts', () => {
  seedState({
    'job:a': {
      company: 'Acme', title: 'Role A', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Alice', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
        { candidate_id: 'c2', name: 'Bob', lane: 'RECRUITING', score: 80, status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: TOMORROW },
        { candidate_id: 'c3', name: 'Carol', lane: 'FUNCTIONAL', score: 70, status: 'CONTACT_SELECTED', next_action: 'FOLLOW_UP', next_action_due: YESTERDAY },
        { candidate_id: 'c4', name: 'Dana', lane: 'FUNCTIONAL', score: 60, status: 'OUTREACH_SENT' },
        { candidate_id: 'c5', name: 'Erin', lane: 'FUNCTIONAL', score: 50, status: 'COMPLETE', next_action: null, next_action_due: null },
        { candidate_id: 'c6', name: 'Finn', lane: 'FUNCTIONAL', score: 40, status: 'SKIPPED', next_action: null, next_action_due: null },
      ] },
    },
  });
  const actions = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(actions.length, 4);
  assert.deepEqual(actions.map((a) => [a.contact_name, a.bucket]), [
    ['Carol', 'OVERDUE'],
    ['Alice', 'TODAY'],
    ['Bob', 'UPCOMING'],
    ['Dana', 'WAITING'],
  ]);
});

test('Mark Done resolves the current action, and CONTACT_SELECTED transitions to OUTREACH_SENT', async () => {
  seedState({
    'job:b': {
      company: 'Beta', title: 'Role B', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Grace', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', channel: 'EMAIL', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
  });
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(before.length, 1);
  const { contact } = await completeFollowUpAction(before[0].action_id, { root: sandbox });
  assert.equal(contact.status, 'OUTREACH_SENT');
  assert.ok(contact.sent_at);
  assert.equal(contact.next_action, null);
  assert.equal(contact.next_action_due, null);
  // current action disappears (OUTREACH_SENT + next_action null -> WAITING, not the queue this action was in)
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1.length, 1);
  assert.equal(after1[0].bucket, 'WAITING');
  assert.equal(after1[0].action_id, before[0].action_id); // same contact, same id, new bucket
});

test('Mark Done on an already-OUTREACH_SENT contact resolves the action without re-touching status/sent_at', async () => {
  seedState({
    'job:c': {
      company: 'Gamma', title: 'Role C', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Henry', lane: 'RECRUITING', score: 90, status: 'OUTREACH_SENT', sent_at: '2026-09-10T00:00:00.000Z', channel: 'LINKEDIN_INVITE', next_action: 'CHECK_CONNECTION', next_action_due: TODAY },
      ] },
    },
  });
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  const { contact } = await completeFollowUpAction(before[0].action_id, { root: sandbox });
  assert.equal(contact.status, 'OUTREACH_SENT');
  assert.equal(contact.sent_at, '2026-09-10T00:00:00.000Z'); // untouched
  assert.equal(contact.next_action, null);
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1.length, 1);
  assert.equal(after1[0].bucket, 'WAITING');
});

test('Skip removes the per-contact row from the queue and sets status SKIPPED', async () => {
  seedState({
    'job:d': {
      company: 'Delta', title: 'Role D', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Ivy', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
  });
  const before = listFollowUpActions({ root: sandbox, today: TODAY });
  const { contact } = await skipFollowUpAction(before[0].action_id, { root: sandbox });
  assert.equal(contact.status, 'SKIPPED');
  assert.equal(contact.next_action, null);
  // Pass 5 amendment: the application itself is still live (APPLIED, no
  // application_status closure), so it does not vanish from Home — it falls
  // back to the synthetic WAITING/APPLICATION_PENDING placeholder rather
  // than disappearing, since Skip never closes the application.
  const after1 = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(after1.length, 1);
  assert.equal(after1[0].action_id, applicationPendingActionId('job:d'));
  assert.equal(after1[0].action, 'APPLICATION_PENDING');
  assert.equal(after1[0].bucket, 'WAITING');
  assert.equal(after1[0].contact_id, null);
});

test('an unknown action_id is refused loudly rather than silently no-op', async () => {
  seedState({});
  await assert.rejects(() => completeFollowUpAction('fu-deadbeef', { root: sandbox }));
  await assert.rejects(() => skipFollowUpAction('fu-deadbeef', { root: sandbox }));
});

test('action_id is stable across listFollowUpActions() calls for the same job/contact', () => {
  seedState({
    'job:e': {
      company: 'Epsilon', title: 'Role E', fit_decision: 'APPLY', execution_status: 'APPLIED',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [
        { candidate_id: 'c1', name: 'Jack', lane: 'RECRUITING', score: 90, status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: TODAY },
      ] },
    },
  });
  const a = listFollowUpActions({ root: sandbox, today: TODAY });
  const b = listFollowUpActions({ root: sandbox, today: TODAY });
  assert.equal(a[0].action_id, b[0].action_id);
  assert.equal(a[0].action_id, actionId('job:e', 'c1'));
});
