// tests/home-job-level-rows.test.mjs — Home presentation/aggregation patch.
// Pure unit tests over followup-schema.mjs's buildHomeRows/selectHomeAction/
// deriveHomeStatus: no filesystem, fixture action arrays shaped exactly like
// listFollowUpActions() output (see buildFollowUpAction/
// buildApplicationPendingAction). Home's contract is "one row per applied
// job" — these tests are the ones that would catch a regression back to
// "one row per contact action."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeRows, selectHomeAction, deriveHomeStatus } from '../followup-schema.mjs';

function fu(overrides) {
  return {
    action_id: 'fu-00000001',
    job_key: 'job:x',
    company: 'X',
    role: 'Role',
    contact_id: 'c1',
    contact_name: 'Contact',
    contact_role: '',
    action: 'SEND_EMAIL',
    channel: 'email',
    due_at: null,
    bucket: 'WAITING',
    contact_status: 'CONTACT_SELECTED',
    application_status: 'ACTIVE',
    application_stage: 'Applied',
    applied_at: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

function ap(overrides) {
  return fu({
    action_id: 'ap-00000001',
    contact_id: null,
    contact_name: null,
    contact_role: '',
    action: 'APPLICATION_PENDING',
    channel: null,
    due_at: null,
    bucket: 'WAITING',
    contact_status: null,
    ...overrides,
  });
}

test('a job with 5 contact actions collapses to exactly one Home row (the Tulip defect)', () => {
  const actions = [
    fu({ action_id: 'fu-1', contact_id: 'c1', job_key: 'job:tulip', bucket: 'OVERDUE', due_at: '2026-09-01' }),
    fu({ action_id: 'fu-2', contact_id: 'c2', job_key: 'job:tulip', bucket: 'UPCOMING', due_at: '2026-09-21' }),
    fu({ action_id: 'fu-3', contact_id: 'c3', job_key: 'job:tulip', bucket: 'WAITING', due_at: null }),
    fu({ action_id: 'fu-4', contact_id: 'c4', job_key: 'job:tulip', bucket: 'WAITING', due_at: null }),
    fu({ action_id: 'fu-5', contact_id: 'c5', job_key: 'job:tulip', bucket: 'TODAY', due_at: '2026-09-16' }),
  ];
  const rows = buildHomeRows(actions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_key, 'job:tulip');
  assert.equal(rows[0].extra_count, 4);
  assert.equal(rows[0].actions.length, 5);
});

test('a job with zero contacts (the fallback-only shape) is still exactly one row', () => {
  const rows = buildHomeRows([ap({ job_key: 'job:datch' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_key, 'job:datch');
  assert.equal(rows[0].extra_count, 0);
});

test('two different jobs never merge into one row', () => {
  const rows = buildHomeRows([
    fu({ job_key: 'job:a', action_id: 'fu-a' }),
    fu({ job_key: 'job:b', action_id: 'fu-b' }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.job_key)), new Set(['job:a', 'job:b']));
});

test('selectHomeAction priority: OVERDUE beats TODAY beats UPCOMING beats undated WAITING', () => {
  const actions = [
    fu({ action_id: 'fu-upcoming', bucket: 'UPCOMING', due_at: '2026-09-30' }),
    fu({ action_id: 'fu-waiting', bucket: 'WAITING', due_at: null }),
    fu({ action_id: 'fu-today', bucket: 'TODAY', due_at: '2026-09-16' }),
    fu({ action_id: 'fu-overdue', bucket: 'OVERDUE', due_at: '2026-09-01' }),
  ];
  assert.equal(selectHomeAction(actions).action_id, 'fu-overdue');
  assert.equal(selectHomeAction(actions.filter((a) => a.action_id !== 'fu-overdue')).action_id, 'fu-today');
  assert.equal(selectHomeAction(actions.filter((a) => ['fu-upcoming', 'fu-waiting'].includes(a.action_id))).action_id, 'fu-upcoming');
});

test('selectHomeAction: nearest UPCOMING wins over a later one', () => {
  const actions = [
    fu({ action_id: 'fu-far', bucket: 'UPCOMING', due_at: '2026-10-15' }),
    fu({ action_id: 'fu-near', bucket: 'UPCOMING', due_at: '2026-09-21' }),
  ];
  assert.equal(selectHomeAction(actions).action_id, 'fu-near');
});

test('selectHomeAction: a real undated WAITING action outranks the synthetic no-action fallback', () => {
  const actions = [
    ap({ action_id: 'ap-1', job_key: 'job:mix' }),
    fu({ action_id: 'fu-real', job_key: 'job:mix', bucket: 'WAITING', due_at: null }),
  ];
  assert.equal(selectHomeAction(actions).action_id, 'fu-real');
});

test('buildHomeRows: NEXT ACTION and FOLLOW-UP are null for a fallback row — APPLICATION_PENDING never surfaces', () => {
  const rows = buildHomeRows([ap({ job_key: 'job:salsify', company: 'Salsify' })]);
  assert.equal(rows[0].next_action, null);
  assert.equal(rows[0].due_at, null);
  assert.notEqual(rows[0].next_action, 'APPLICATION_PENDING');
});

test('buildHomeRows: a real action surfaces its own action/due_at, undated included', () => {
  const rows = buildHomeRows([
    fu({ job_key: 'job:samsara', action: 'CHECK_CONNECTION', bucket: 'WAITING', due_at: null }),
  ]);
  assert.equal(rows[0].next_action, 'CHECK_CONNECTION');
  assert.equal(rows[0].due_at, null);
});

test('deriveHomeStatus: OVERDUE/TODAY -> ACTION DUE, everything else -> WAITING, STALE application_status wins', () => {
  assert.equal(deriveHomeStatus(fu({ bucket: 'OVERDUE' })), 'ACTION DUE');
  assert.equal(deriveHomeStatus(fu({ bucket: 'TODAY' })), 'ACTION DUE');
  assert.equal(deriveHomeStatus(fu({ bucket: 'UPCOMING', due_at: '2026-09-30' })), 'WAITING');
  assert.equal(deriveHomeStatus(fu({ bucket: 'WAITING' })), 'WAITING');
  assert.equal(deriveHomeStatus(ap({})), 'WAITING');
  assert.equal(deriveHomeStatus(fu({ bucket: 'TODAY', application_status: 'STALE' })), 'STALE');
});

test('buildHomeRows: repeated calls over the same input produce identical rows — no drift on refresh', () => {
  const actions = [
    fu({ job_key: 'job:once', action_id: 'fu-1' }),
    ap({ job_key: 'job:twice' }),
  ];
  assert.deepEqual(buildHomeRows(actions), buildHomeRows(actions));
});

test('buildHomeRows: row carries applied_at through from the source action for the APPLIED column', () => {
  const rows = buildHomeRows([fu({ job_key: 'job:dated', applied_at: '2026-09-10T12:00:00.000Z' })]);
  assert.equal(rows[0].applied_at, '2026-09-10T12:00:00.000Z');
});

test('sortHomeRows ordering matches severity-first: OVERDUE, TODAY, UPCOMING, WAITING', () => {
  const rows = buildHomeRows([
    fu({ job_key: 'job:w', bucket: 'WAITING', due_at: null }),
    fu({ job_key: 'job:o', bucket: 'OVERDUE', due_at: '2026-09-01' }),
    fu({ job_key: 'job:t', bucket: 'TODAY', due_at: '2026-09-16' }),
    fu({ job_key: 'job:u', bucket: 'UPCOMING', due_at: '2026-09-20' }),
  ]);
  assert.deepEqual(rows.map((r) => r.job_key), ['job:o', 'job:t', 'job:u', 'job:w']);
});
