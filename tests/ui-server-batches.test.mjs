// tests/ui-server-batches.test.mjs — batch-aware Review UI adapter (#3520-ish
// "scoped review batches"). Exercises ui-server.mjs's pure read helpers
// (readOpenBatches / listOpenBatchSummaries / listReviewJobsForBatch)
// against a fixture root with MULTIPLE open batches — the exact production
// shape that triggered this work (batch-20260916-0005 + a large
// batch-20260916-0006). Also proves finalizeAndIngestBatch (already tested
// in review.test.mjs for single-batch correctness) leaves a SECOND open
// batch completely untouched when only the first is finalized.

import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { createBatchFromJobs, finalizeAndIngestBatch, reviewPaths, readJson } from '../review.mjs';
import { readOpenBatches, listOpenBatchSummaries, listReviewJobsForBatch } from '../ui-server.mjs';

function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), 'co-ui-batches-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}

async function main() {
  // ── multiple open batches load, each with correct membership ───────────
  const root = scratchRoot();
  const olderJob = { url: 'https://boards.greenhouse.io/acme/jobs/older-1', company: 'OlderCo', title: 'Older Role', location: 'Remote - United States' };
  const { batchId: olderBatchId } = createBatchFromJobs([olderJob], { root, source: 'pipeline.md' });

  // Force distinct created_at ordering deterministically (createBatchFromJobs
  // stamps "now" — a fixture must not depend on real wall-clock gaps between
  // two calls in the same test tick).
  const p = reviewPaths(root);
  const olderBatch = readJson(join(p.open, `${olderBatchId}.json`), null);
  olderBatch.created_at = '2026-09-15T00:00:00.000Z';
  writeFileSync(join(p.open, `${olderBatchId}.json`), JSON.stringify(olderBatch, null, 2) + '\n');

  const cohortJobA = { url: 'https://jobs.smartrecruiters.com/ifs1/cohort-a', company: 'IFS', title: 'Forward Deployed AI Engineer', location: 'Itasca, IL, Remote' };
  const cohortJobB = { url: 'https://jobs.smartrecruiters.com/ifs1/cohort-b', company: 'IFS', title: 'Customer Success Manager', location: 'Itasca, IL, Remote' };
  const { batchId: cohortBatchId } = createBatchFromJobs([cohortJobA, cohortJobB], { root, source: 'cohort' });
  const cohortBatch = readJson(join(p.open, `${cohortBatchId}.json`), null);
  cohortBatch.created_at = '2026-09-16T09:00:00.000Z'; // newer than olderBatch
  writeFileSync(join(p.open, `${cohortBatchId}.json`), JSON.stringify(cohortBatch, null, 2) + '\n');

  const batches = readOpenBatches(root);
  if (batches.length === 2) pass('multiple open batches load');
  else fail(`expected 2 open batches, got ${batches.length}`);

  // ── newest-first ordering (default-selection basis) ─────────────────────
  if (batches[0].batch_id === cohortBatchId) pass('newest batch (by created_at) sorts first — the UI default-selection basis');
  else fail(`newest-first ordering wrong: ${batches.map((b) => b.batch_id)}`);

  const summaries = listOpenBatchSummaries(root);
  const cohortSummary = summaries.find((s) => s.batch_id === cohortBatchId);
  if (cohortSummary && cohortSummary.count === 2 && cohortSummary.source === 'cohort') {
    pass('batch summary carries id, count, and source for the selector label');
  } else fail(`batch summary missing/wrong: ${JSON.stringify(cohortSummary)}`);

  // ── selected batch shows only its own jobs ───────────────────────────────
  const cohortView = listReviewJobsForBatch(cohortBatchId, root);
  if (cohortView.jobs.length === 2 && cohortView.jobs.every((j) => j.batch_id === cohortBatchId)) {
    pass('selected batch shows only its own jobs (2, all tagged with the right batch_id)');
  } else fail(`selected batch view leaked/miscounted: ${JSON.stringify(cohortView)}`);
  const cohortTitles = cohortView.jobs.map((j) => j.title).sort();
  if (cohortTitles.includes('Forward Deployed AI Engineer') && cohortTitles.includes('Customer Success Manager')) {
    pass('selected batch job list contains exactly the expected titles');
  } else fail(`unexpected titles in selected batch: ${JSON.stringify(cohortTitles)}`);

  // ── switching batch changes visible jobs correctly ──────────────────────
  const olderView = listReviewJobsForBatch(olderBatchId, root);
  if (olderView.jobs.length === 1 && olderView.jobs[0].company === 'OlderCo') {
    pass('switching to the other batch shows only its own (different) jobs');
  } else fail(`switching batches did not isolate correctly: ${JSON.stringify(olderView)}`);

  // ── default (no batch_id given) resolves to the newest open batch ──────
  const defaultView = listReviewJobsForBatch(undefined, root);
  if (defaultView.batch_id === cohortBatchId) {
    pass('omitting batch_id defaults to the newest open batch');
  } else fail(`default batch selection picked the wrong batch: ${defaultView.batch_id}`);

  // ── decisions/finalize do not leak across batches ───────────────────────
  const aKey = cohortView.jobs.find((j) => j.title === 'Forward Deployed AI Engineer').job_key;
  const bKey = cohortView.jobs.find((j) => j.title === 'Customer Success Manager').job_key;
  const overrides = { [aKey]: 'INVESTIGATE', [bKey]: 'PASS' };
  const { batch: finalized, ingestion } = await finalizeAndIngestBatch(cohortBatchId, { overrides, root });
  if (finalized.status === 'finalized' && ingestion.ingested.includes(cohortBatchId)) {
    pass('finalize targets the selected batch only, via the existing finalizeAndIngestBatch lifecycle');
  } else fail(`finalize did not complete as expected: ${JSON.stringify({ status: finalized.status, ingestion })}`);

  // The OTHER open batch (olderBatchId) must be completely untouched —
  // still open, still exactly its original one job, no decision applied.
  const remainingOpen = readOpenBatches(root);
  if (remainingOpen.length === 1 && remainingOpen[0].batch_id === olderBatchId) {
    pass('another open batch remains open and unmodified after finalizing a different one');
  } else fail(`unrelated batch was affected: ${JSON.stringify(remainingOpen.map((b) => b.batch_id))}`);
  const untouchedOlder = readJson(join(p.open, `${olderBatchId}.json`), null);
  if (untouchedOlder.jobs[0].review.final_decision === null && untouchedOlder.jobs[0].review.status === 'UNREVIEWED') {
    pass('the untouched batch\'s job still has no decision — no cross-batch leakage');
  } else fail(`unrelated batch's job was mutated: ${JSON.stringify(untouchedOlder.jobs[0].review)}`);

  // ── single-batch behavior still works (the pre-existing common case) ───
  const root2 = scratchRoot();
  const soloJob = { url: 'https://boards.greenhouse.io/acme/jobs/solo-1', company: 'SoloCo', title: 'Solo Role', location: 'Remote - United States' };
  const { batchId: soloBatchId } = createBatchFromJobs([soloJob], { root: root2, source: 'pipeline.md' });
  const soloBatches = readOpenBatches(root2);
  const soloView = listReviewJobsForBatch(undefined, root2);
  if (soloBatches.length === 1 && soloView.batch_id === soloBatchId && soloView.jobs.length === 1) {
    pass('single-open-batch behavior is unchanged: one batch, default selection resolves to it, exactly its job shows');
  } else fail(`single-batch case regressed: ${JSON.stringify({ soloBatches: soloBatches.length, soloView })}`);

  // ── no open batches at all ───────────────────────────────────────────────
  const root3 = scratchRoot();
  const emptyView = listReviewJobsForBatch(undefined, root3);
  if (emptyView === null) pass('no open batches -> listReviewJobsForBatch returns null, not a crash');
  else fail(`expected null for zero open batches, got ${JSON.stringify(emptyView)}`);
}

try {
  await main();
} catch (err) {
  fail(`ui-server-batches.test.mjs crashed: ${err.stack || err.message}`);
}
