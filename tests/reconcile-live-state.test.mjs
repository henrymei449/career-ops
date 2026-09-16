// tests/reconcile-live-state.test.mjs — PASS 6 live-state reconciliation:
// exact job matching, terminal-application isolation, invite/reply mapping,
// no fabricated timestamps, generic-fallback preservation, ambiguous
// evidence handling, and idempotent rerun. Mirrors
// tests/migrate-historical-applications.test.mjs's style/scope.

import { mkdtempSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { reconcileLiveState } from '../reconcile-live-state.mjs';
import { reviewPaths, readJson, defaultState } from '../review.mjs';
import { atomicWriteFile } from '../scan.mjs';
import { listFollowUpActions } from '../outreach.mjs';

function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-reconcile-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

// Seeds a durable job at exactly the job_key one of RECONCILIATION_SOURCE's
// entries expects, in the Pass 1 WAIVED/COMPLETE historical-migration shape
// (empty selected_contacts) unless overridden.
function seedLiveJob(root, jobKey, { company, title, applicationStatus = 'ACTIVE', executionStatus = 'APPLIED', outreach } = {}) {
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  state.jobs[jobKey] = {
    fit_decision: 'APPLY',
    execution_status: executionStatus,
    reason: 'test seed',
    company,
    title,
    url: jobKey.startsWith('url:') ? jobKey.slice(4) : '',
    batch_id: 'test-seed',
    decided_at: '2026-09-10T00:00:00.000Z',
    applied_at: '2026-09-10T00:00:00.000Z',
    outreach: outreach || { decision: 'WAIVED', status: 'COMPLETE', candidates: [], selected_contacts: [] },
    application_status: applicationStatus,
    application_stage: 'Applied',
    application_last_update: '2026-09-10',
    application_outcome: '',
  };
  atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
}

const AMAT_KEY = 'url:https://amat.wd1.myworkdayjobs.com/External/job/Home--MobileAZ-001/Technical-Consultant---Process-Quality-Products_R2623145';
const INSTALILY_KEY = 'cr:instalily ai::strategic associate@@nyc';

async function main() {
  // ── 1. exact job matching: known evidence attaches to its exact job_key ─
  {
    const root = scratchRoot();
    seedLiveJob(root, AMAT_KEY, { company: 'Applied Materials', title: 'Technical Consultant - Process Quality' });
    const report = await reconcileLiveState({ root });
    const updated = report.updated.find((r) => r.jobKey === AMAT_KEY);
    if (updated && updated.contactsAdded.length === 1 && updated.contactsAdded[0].name.includes('PJ')) {
      pass('1. exact job_key match attaches the right evidence to the right job');
    } else fail(`1. expected Applied Materials update with PJ contact, got ${JSON.stringify(updated)}`);
  }

  // ── 2. terminal application (REJECTED) is never reopened/touched ───────
  {
    const root = scratchRoot();
    seedLiveJob(root, AMAT_KEY, { company: 'Applied Materials', title: 'Technical Consultant - Process Quality', applicationStatus: 'REJECTED' });
    const p = reviewPaths(root);
    const before = JSON.stringify(readJson(p.statePath, defaultState()).jobs[AMAT_KEY]);
    const report = await reconcileLiveState({ root });
    const after = JSON.stringify(readJson(p.statePath, defaultState()).jobs[AMAT_KEY]);
    const skipped = report.skippedNotLive.some((r) => r.jobKey === AMAT_KEY);
    if (skipped && before === after) pass('2. a REJECTED (terminal) application is skipped and left byte-for-byte untouched');
    else fail(`2. terminal application was touched or not reported skipped: skipped=${skipped}`);
  }

  // ── 3. invite-sent evidence maps to OUTREACH_SENT / LINKEDIN_INVITE ─────
  {
    const root = scratchRoot();
    const geckoKey = 'cr:gecko robotics::deployment lead navy manufacturing@@us';
    seedLiveJob(root, geckoKey, { company: 'Gecko Robotics', title: 'Deployment Lead | Navy Manufacturing' });
    await reconcileLiveState({ root });
    const p = reviewPaths(root);
    const job = readJson(p.statePath, defaultState()).jobs[geckoKey];
    const contact = job.outreach.selected_contacts[0];
    if (contact && contact.status === 'OUTREACH_SENT' && contact.channel === 'LINKEDIN_INVITE') {
      pass('3. LinkedIn invite-sent evidence maps to OUTREACH_SENT / LINKEDIN_INVITE');
    } else fail(`3. unexpected contact shape: ${JSON.stringify(contact)}`);
  }

  // ── 4. no fabricated timestamps — sent_at/replied_at stay null ─────────
  {
    const root = scratchRoot();
    seedLiveJob(root, INSTALILY_KEY, { company: 'InstaLILY AI', title: 'Strategic Associate' });
    await reconcileLiveState({ root });
    const p = reviewPaths(root);
    const job = readJson(p.statePath, defaultState()).jobs[INSTALILY_KEY];
    const contact = job.outreach.selected_contacts[0];
    if (contact.sent_at === null && contact.replied_at === null && contact.last_action_at === null) {
      pass('4. reconciliation never fabricates sent_at/replied_at/last_action_at timestamps');
    } else fail(`4. a timestamp was fabricated: ${JSON.stringify(contact)}`);
  }

  // ── 5. generic APPLICATION_PENDING fallback preserved when no evidence ──
  {
    const root = scratchRoot();
    const noEvidenceKey = 'cr:kinaxis::business consultant@@us';
    seedLiveJob(root, noEvidenceKey, { company: 'Kinaxis', title: 'Business Consultant' });
    const report = await reconcileLiveState({ root });
    const touched = report.updated.some((r) => r.jobKey === noEvidenceKey) || report.alreadyReconciled.some((r) => r.jobKey === noEvidenceKey);
    const actions = listFollowUpActions({ root, today: '2026-09-16' });
    const row = actions.find((a) => a.job_key === noEvidenceKey);
    if (!touched && row && row.action === 'APPLICATION_PENDING') {
      pass('5. a job with no sheet evidence keeps the generic APPLICATION_PENDING fallback');
    } else fail(`5. expected untouched APPLICATION_PENDING fallback: touched=${touched} row=${JSON.stringify(row)}`);
  }

  // ── 6. Home integration: reconciled evidence replaces APPLICATION_PENDING ─
  {
    const root = scratchRoot();
    seedLiveJob(root, AMAT_KEY, { company: 'Applied Materials', title: 'Technical Consultant - Process Quality' });
    const before = listFollowUpActions({ root, today: '2026-09-16' }).find((a) => a.job_key === AMAT_KEY);
    await reconcileLiveState({ root });
    const after = listFollowUpActions({ root, today: '2026-09-16' }).find((a) => a.job_key === AMAT_KEY);
    if (before?.action === 'APPLICATION_PENDING' && after && after.action !== 'APPLICATION_PENDING' && after.contact_name?.includes('PJ')) {
      pass('6. Home replaces generic APPLICATION_PENDING with the reconciled contact action');
    } else fail(`6. Home did not pick up reconciled evidence: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  // ── 7. ambiguous evidence (job_key not found) -> MANUAL_REVIEW, no throw ─
  {
    const root = scratchRoot();
    const report = await reconcileLiveState({ root }); // empty state — no jobs exist at all
    if (report.manualReview.length === RECONCILIATION_ENTRY_COUNT(report) && report.updated.length === 0) {
      pass('7. missing job_keys are reported as MANUAL_REVIEW rather than guessed at or thrown');
    } else fail(`7. unexpected report on empty state: ${JSON.stringify({ manualReview: report.manualReview.length, updated: report.updated.length })}`);
  }

  // ── 8. idempotent rerun: second run is a no-op ──────────────────────────
  {
    const root = scratchRoot();
    for (const key of [AMAT_KEY, INSTALILY_KEY]) {
      seedLiveJob(root, key, { company: key === AMAT_KEY ? 'Applied Materials' : 'InstaLILY AI', title: 'test' });
    }
    const first = await reconcileLiveState({ root });
    const p = reviewPaths(root);
    const afterFirst = readJson(p.statePath, defaultState());
    const second = await reconcileLiveState({ root });
    const afterSecond = readJson(p.statePath, defaultState());

    const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.updated_at; return c; };
    if (second.updated.length === 0 && JSON.stringify(strip(afterFirst)) === JSON.stringify(strip(afterSecond))) {
      pass('8. re-running reconciliation is a safe no-op (idempotent)');
    } else fail(`8. re-run was not idempotent: second.updated=${second.updated.length}`);
  }

  // ── 9. dry-run never writes to disk ─────────────────────────────────────
  {
    const root = scratchRoot();
    seedLiveJob(root, AMAT_KEY, { company: 'Applied Materials', title: 'test' });
    const p = reviewPaths(root);
    const before = readFileSync(p.statePath, 'utf-8');
    const report = await reconcileLiveState({ root, dryRun: true });
    const after = readFileSync(p.statePath, 'utf-8');
    if (before === after && report.updated.length > 0) {
      pass('9. --dry-run computes the report without writing state');
    } else fail('9. dry-run mutated state on disk');
  }

  // ── 10. current live-flow jobs (already-populated outreach) are additive ─
  {
    const root = scratchRoot();
    const geckoKey = 'cr:gecko robotics::deployment lead navy manufacturing@@us';
    seedLiveJob(root, geckoKey, {
      company: 'Gecko Robotics', title: 'Deployment Lead | Navy Manufacturing',
      outreach: { decision: 'REQUIRED', status: 'CONTACTS_SELECTED', candidates: [], selected_contacts: [{ candidate_id: 'cand-preexisting', name: 'Someone Else', lane: 'RECRUITING', source: 'MANUAL', score: 0, status: 'REPLIED', channel: 'EMAIL', sent_at: null, replied_at: null, last_action_at: null, next_action: null, next_action_due: null }] },
    });
    await reconcileLiveState({ root });
    const p = reviewPaths(root);
    const job = readJson(p.statePath, defaultState()).jobs[geckoKey];
    const names = job.outreach.selected_contacts.map((c) => c.name);
    if (names.includes('Someone Else') && names.length === 2) {
      pass('10. reconciliation appends to existing selected_contacts rather than replacing them');
    } else fail(`10. expected both contacts preserved, got ${JSON.stringify(names)}`);
  }
}

function RECONCILIATION_ENTRY_COUNT() {
  // Kept in sync manually with RECONCILIATION_SOURCE.length in
  // reconcile-live-state.mjs; test 7 seeds an entirely empty state so every
  // entry must report MANUAL_REVIEW.
  return 12;
}

main().catch((e) => { fail(`reconcile-live-state test crashed: ${e.message}\n${e.stack}`); process.exitCode = 1; });
