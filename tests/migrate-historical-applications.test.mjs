// tests/migrate-historical-applications.test.mjs — PASS 1 historical
// application migration: metadata, applied_at preservation, status mapping,
// dedupe/idempotency, outreach non-contamination, and live-flow isolation.

import { mkdtempSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { migrateHistoricalApplications } from '../migrate-historical-applications.mjs';
import { mapSheetApplicationStatus } from '../application-schema.mjs';
import {
  createBatchFromJobs,
  applyProposedDecisions,
  finalizeBatch,
  ingestFinalizedReviewBatches,
  reviewPaths,
  readJson,
  defaultState,
} from '../review.mjs';
import { markApplied, setOutreachDecision } from '../outreach.mjs';

function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-migrate-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

async function seedKnownJob(root, jobKey, { company, title, url }) {
  // Build a durable job at exactly the job_key migrate-historical-applications
  // expects for one of its KNOWN_JOB_KEYS rows, via the real ingestion path.
  const location = jobKey.startsWith('cr:') ? jobKey.split('@@')[1] : 'US';
  const job = { url, company, title, location, source: 'test', postedAt: '2026-01-01' };
  const { batchId, batch } = createBatchFromJobs([job], { root, source: 'test' });
  const computedKey = batch.jobs[0].job_key;
  if (computedKey !== jobKey) throw new Error(`seedKnownJob: computed ${computedKey}, expected ${jobKey}`);
  applyProposedDecisions(batchId, {
    decisions: [{ job_key: jobKey, proposed_decision: 'APPLY', reason: 'test', reason_codes: [] }],
  }, { root });
  finalizeBatch(batchId, { reviewer: 'test', root });
  await ingestFinalizedReviewBatches({ root });
  await markApplied(jobKey, { root, appliedAt: '2026-09-15' });
  return jobKey;
}

async function main() {
  // ── 1. status mapping is conservative ───────────────────────────────
  {
    const cases = [
      ['Rejected', 'REJECTED'], ['Closed', 'CLOSED'], ['Active', 'ACTIVE'],
      ['Pending', 'ACTIVE'], ['Stale / Unverified', 'STALE'], ['Withdrawn', 'WITHDRAWN'],
      ['', 'UNKNOWN'], ['Something Else', 'UNKNOWN'],
    ];
    let ok = true;
    for (const [raw, expected] of cases) {
      const got = mapSheetApplicationStatus(raw);
      if (got !== expected) { ok = false; fail(`1. mapSheetApplicationStatus(${JSON.stringify(raw)}) = ${got}, expected ${expected}`); }
    }
    if (ok) pass('1. mapSheetApplicationStatus maps sheet statuses conservatively');
  }

  // ── 2. historical creation: applied_at preserved, never migration time ─
  {
    const root = scratchRoot();
    const report = await migrateHistoricalApplications({ root });
    const p = reviewPaths(root);
    const state = readJson(p.statePath, defaultState());

    const kinaxis = report.historicalCreated.find((r) => r.company === 'Kinaxis');
    if (!kinaxis) { fail('2. Kinaxis was not created as a historical record'); }
    else {
      const job = state.jobs[kinaxis.jobKey];
      if (job.applied_at === '2026-09-03T00:00:00.000Z' && job.fit_decision === 'APPLY' && job.execution_status === 'APPLIED') {
        pass('2. historical record preserves the ORIGINAL applied_at, not migration time');
      } else fail(`2. unexpected job shape: ${JSON.stringify(job)}`);
    }
  }

  // ── 3. outreach never manufactures SEARCH_REQUIRED for historical rows ─
  {
    const root = scratchRoot();
    const report = await migrateHistoricalApplications({ root });
    const p = reviewPaths(root);
    const state = readJson(p.statePath, defaultState());
    const bad = report.historicalCreated
      .map((r) => state.jobs[r.jobKey])
      .filter((j) => j.outreach.status === 'SEARCH_REQUIRED' || j.outreach.decision === 'PENDING');
    if (bad.length === 0) pass('3. no historical record is left PENDING or SEARCH_REQUIRED');
    else fail(`3. ${bad.length} historical record(s) manufactured fresh outreach work`);
  }

  // ── 4. six-record outreach-contamination fix: PENDING -> WAIVED/COMPLETE ─
  {
    const root = scratchRoot();
    const odenKey = 'cr:oden technologies::solutions engineer@@chicago il';
    await seedKnownJob(root, odenKey, { company: 'Oden Technologies', title: 'Solutions Engineer', url: '' });

    const p = reviewPaths(root);
    let state = readJson(p.statePath, defaultState());
    if (state.jobs[odenKey].outreach.decision !== 'PENDING') fail('4. setup: seeded job should start PENDING');

    const report = await migrateHistoricalApplications({ root });
    state = readJson(p.statePath, defaultState());
    const job = state.jobs[odenKey];
    const fixed = report.outreachFixed.some((r) => r.jobKey === odenKey);
    if (fixed && job.outreach.decision === 'WAIVED' && job.outreach.status === 'COMPLETE') {
      pass('4. contaminated PENDING outreach resolves to WAIVED/COMPLETE, not SEARCH_REQUIRED');
    } else fail(`4. expected WAIVED/COMPLETE, got ${JSON.stringify(job.outreach)}`);

    if (job.legacy_sheet && job.legacy_sheet.outreach_status_raw === 'Not sent') {
      pass('4. original historical outreach evidence is preserved in legacy_sheet');
    } else fail(`4. legacy_sheet missing/incorrect: ${JSON.stringify(job.legacy_sheet)}`);
  }

  // ── 5. does not touch a decision a human already resolved ──────────────
  {
    const root = scratchRoot();
    const odenKey = 'cr:oden technologies::solutions engineer@@chicago il';
    await seedKnownJob(root, odenKey, { company: 'Oden Technologies', title: 'Solutions Engineer', url: '' });
    await setOutreachDecision(odenKey, 'REQUIRED', { root });

    const report = await migrateHistoricalApplications({ root });
    const p = reviewPaths(root);
    const state = readJson(p.statePath, defaultState());
    const job = state.jobs[odenKey];
    const touchedOutreach = report.outreachFixed.some((r) => r.jobKey === odenKey);
    if (!touchedOutreach && job.outreach.decision === 'REQUIRED') {
      pass('5. migration never overrides an outreach decision a human already resolved');
    } else fail(`5. migration incorrectly touched a resolved outreach decision: ${JSON.stringify(job.outreach)}`);
  }

  // ── 6. current live flow (IFS/Samsara) is completely untouched ─────────
  {
    const root = scratchRoot();
    const ifsKey = 'url:https://jobs.smartrecruiters.com/ifs1/744000149374069-customer-success-manager-manufacturing';
    await seedKnownJob(root, ifsKey, { company: 'IFS', title: 'Customer Success Manager / Manufacturing', url: 'https://jobs.smartrecruiters.com/ifs1/744000149374069-customer-success-manager-manufacturing' });

    const p = reviewPaths(root);
    const before = JSON.stringify(readJson(p.statePath, defaultState()).jobs[ifsKey]);
    await migrateHistoricalApplications({ root });
    const after = JSON.stringify(readJson(p.statePath, defaultState()).jobs[ifsKey]);
    if (before === after) pass('6. IFS (current live application flow) is byte-for-byte untouched');
    else fail('6. IFS record was modified by the historical migration');
  }

  // ── 7. re-running the migration is a safe no-op (idempotent) ───────────
  {
    const root = scratchRoot();
    const first = await migrateHistoricalApplications({ root });
    const p = reviewPaths(root);
    const afterFirst = readJson(p.statePath, defaultState());
    const jobCountFirst = Object.keys(afterFirst.jobs).length;

    const second = await migrateHistoricalApplications({ root });
    const afterSecond = readJson(p.statePath, defaultState());
    const jobCountSecond = Object.keys(afterSecond.jobs).length;

    if (jobCountFirst === jobCountSecond && second.historicalCreated.length === 0 && second.outreachFixed.length === 0) {
      pass('7. re-running the migration creates no duplicates and re-fixes nothing');
    } else fail(`7. re-run was not idempotent: first=${jobCountFirst} second=${jobCountSecond} created=${second.historicalCreated.length} fixed=${second.outreachFixed.length}`);

    const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.updated_at; return c; };
    if (JSON.stringify(strip(afterFirst)) === JSON.stringify(strip(afterSecond))) {
      pass('7. re-run produces identical durable state (aside from updated_at)');
    } else fail('7. re-run changed durable state despite reporting a no-op');
  }

  // ── 8. dry-run never writes to disk ─────────────────────────────────────
  {
    const root = scratchRoot();
    const p = reviewPaths(root);
    const report = await migrateHistoricalApplications({ root, dryRun: true });
    let existsAfter = true;
    try { readFileSync(p.statePath, 'utf-8'); } catch { existsAfter = false; }
    if (!existsAfter && report.historicalCreated.length > 0) {
      pass('8. --dry-run computes the report without writing state');
    } else fail(`8. dry-run should not have written ${p.statePath} (exists=${existsAfter})`);
  }
}

main();
