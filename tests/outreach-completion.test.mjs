// tests/outreach-completion.test.mjs — Pass 5 job-level outreach completion
// patch (followup-schema.mjs's deriveOutreachCompletion) and its wiring into
// ui-server.mjs's Applications/Outreach reads. Mirrors the Pass 5 spec's
// acceptance-test list (section 10) line for line, plus the production
// fixtures named in the spec (IFS/Samsara/Datch) as a direct regression
// guard against the exact shapes seen in data/review-state.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveOutreachCompletion } from '../followup-schema.mjs';

function contact(overrides) {
  return { candidate_id: 'c1', name: 'Someone', lane: 'RECRUITING', score: 90, ...overrides };
}

test('no outreach record -> null', () => {
  assert.equal(deriveOutreachCompletion(null), null);
  assert.equal(deriveOutreachCompletion(undefined), null);
});

test('WAIVED decision already durably COMPLETE -> passed through unchanged', () => {
  assert.equal(deriveOutreachCompletion({ decision: 'WAIVED', status: 'COMPLETE', selected_contacts: [] }), 'COMPLETE');
});

test('statuses before contact selection pass through unchanged', () => {
  assert.equal(deriveOutreachCompletion({ decision: 'PENDING', status: 'NOT_STARTED', selected_contacts: [] }), 'NOT_STARTED');
  assert.equal(deriveOutreachCompletion({ decision: 'REQUIRED', status: 'SEARCH_REQUIRED', selected_contacts: [] }), 'SEARCH_REQUIRED');
  assert.equal(deriveOutreachCompletion({ decision: 'REQUIRED', status: 'CANDIDATES_FOUND', selected_contacts: [] }), 'CANDIDATES_FOUND');
});

test('CONTACTS_SELECTED with an empty selected_contacts array is defensively passed through', () => {
  assert.equal(deriveOutreachCompletion({ decision: 'REQUIRED', status: 'CONTACTS_SELECTED', selected_contacts: [] }), 'CONTACTS_SELECTED');
});

test('selected contact still CONTACT_SELECTED -> IN_PROGRESS', () => {
  const outreach = { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', selected_contacts: [contact({ status: 'CONTACT_SELECTED' })] };
  assert.equal(deriveOutreachCompletion(outreach), 'IN_PROGRESS');
});

test('selected contact has a pending next_action (any status) -> IN_PROGRESS', () => {
  const outreach = {
    decision: 'REQUIRED', status: 'CONTACTS_SELECTED',
    selected_contacts: [contact({ status: 'OUTREACH_SENT', next_action: 'CHECK_CONNECTION', next_action_due: null })],
  };
  assert.equal(deriveOutreachCompletion(outreach), 'IN_PROGRESS');
});

test('all selected contacts executed/dispositioned with no pending next_action -> COMPLETE', () => {
  const outreach = {
    decision: 'REQUIRED', status: 'CONTACTS_SELECTED',
    selected_contacts: [
      contact({ candidate_id: 'c1', status: 'OUTREACH_SENT', next_action: null }),
      contact({ candidate_id: 'c2', status: 'COMPLETE', next_action: null }),
      contact({ candidate_id: 'c3', status: 'SKIPPED', next_action: null }),
      contact({ candidate_id: 'c4', status: 'REPLIED', next_action: null }),
    ],
  };
  assert.equal(deriveOutreachCompletion(outreach), 'COMPLETE');
});

test('mixed: one contact resolved, one still pending -> IN_PROGRESS (not COMPLETE until ALL are resolved)', () => {
  const outreach = {
    decision: 'REQUIRED', status: 'CONTACTS_SELECTED',
    selected_contacts: [
      contact({ candidate_id: 'c1', status: 'OUTREACH_SENT', next_action: null }),
      contact({ candidate_id: 'c2', status: 'CONTACT_SELECTED', next_action: 'SEND_EMAIL', next_action_due: '2026-09-16' }),
    ],
  };
  assert.equal(deriveOutreachCompletion(outreach), 'IN_PROGRESS');
});

// ── Production fixture regression: the exact shapes named in the Pass 5
//    spec (IFS/Dirkje+Hannah B, Samsara/James Jackson, Datch) ─────────────

test('IFS: Hannah B (OUTREACH_SENT/CHECK_CONNECTION, no due) + Dirkje (CONTACT_SELECTED/SEND_EMAIL due today) -> IN_PROGRESS, not COMPLETE', () => {
  const outreach = {
    decision: 'REQUIRED', status: 'CONTACTS_SELECTED',
    selected_contacts: [
      contact({ candidate_id: 'cand-c662b33e', name: 'Hannah B', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', next_action: 'CHECK_CONNECTION', next_action_due: null }),
      contact({ candidate_id: 'cand-manual-dirkje', name: 'Dirkje', status: 'CONTACT_SELECTED', channel: 'EMAIL', next_action: 'SEND_EMAIL', next_action_due: '2026-09-16' }),
    ],
  };
  assert.equal(deriveOutreachCompletion(outreach), 'IN_PROGRESS');
});

test('Samsara: James Jackson (OUTREACH_SENT/CHECK_CONNECTION, no due) among selected contacts -> IN_PROGRESS', () => {
  const outreach = {
    decision: 'REQUIRED', status: 'CONTACTS_SELECTED',
    selected_contacts: [
      contact({ candidate_id: 'cand-589be343', name: 'Kyra Jacobs' }), // no status field at all — defaults to CONTACT_SELECTED
      contact({ candidate_id: 'cand-3d7ca064', name: 'James Jackson', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', next_action: 'CHECK_CONNECTION', next_action_due: null }),
      contact({ candidate_id: 'cand-f2234a91', name: 'Steve Arola' }),
    ],
  };
  assert.equal(deriveOutreachCompletion(outreach), 'IN_PROGRESS');
});

test('Datch: WAIVED with no selected contacts -> COMPLETE, no Follow-up action', () => {
  const outreach = { decision: 'WAIVED', status: 'COMPLETE', selected_contacts: [] };
  assert.equal(deriveOutreachCompletion(outreach), 'COMPLETE');
});
