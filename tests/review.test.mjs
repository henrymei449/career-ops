// tests/review.test.mjs — SOP review batch lifecycle (#review-mvp).
//
// Exercises the full backend lifecycle end to end: sourcing survivor ->
// UNREVIEWED batch -> proposed decision -> human finalization ->
// idempotent ingestion -> durable state. Each numbered test below maps to
// one item in the task's required-proof list.

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { normalizeUrl } from '../url-key.mjs';
import { companyRoleDedupKey } from '../scan.mjs';
import { computeJobKey, buildBatch, validateBatch, FIT_DECISIONS } from '../review-schema.mjs';
import {
  reviewPaths,
  readJson,
  createBatchFromJobs,
  createBatchFromPipelinePending,
  createBatchFromUrls,
  extractJobsToNewBatch,
  loadOpenBatch,
  applyProposedDecisions,
  validateReviewedOutput,
  finalizeBatch,
  finalizeAndIngestBatch,
  ingestFinalizedReviewBatches,
  getJobState,
  isSuppressed,
} from '../review.mjs';

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), 'co-review-test-'));
}

const SAMPLE_JOB = {
  url: 'https://boards.greenhouse.io/acme/jobs/12345?utm_source=x',
  company: 'Acme Manufacturing',
  title: 'Manufacturing Solutions Consultant',
  location: 'Remote - United States',
  source: 'greenhouse',
  postedAt: '2026-09-10',
  salary: '150000-180000 USD',
  description: 'We are hiring a Manufacturing Solutions Consultant to run MES POCs for enterprise semiconductor and aerospace accounts. Fully remote within the United States.',
};

async function main() {
  // ── 1. survivor -> UNREVIEWED batch ───────────────────────────────────
  {
    const root = scratchRoot();
    const { batchId, filePath, batch } = createBatchFromJobs([SAMPLE_JOB], { root, source: 'test' });
    if (batchId && existsSync(filePath) && batch.jobs.length === 1) pass('1. survivor produces a batch file on disk');
    else fail('1. survivor did not produce a batch file');

    const job = batch.jobs[0];
    if (job.review.status === 'UNREVIEWED' && job.review.proposed_decision === null && job.review.final_decision === null) {
      pass('1. new job record starts UNREVIEWED with no decisions');
    } else fail(`1. new job record was not UNREVIEWED: ${JSON.stringify(job.review)}`);

    const errors = validateBatch(batch, 'open');
    if (errors.length === 0) pass('1. freshly-built batch validates as "open"');
    else fail(`1. freshly-built batch failed validation: ${errors.join('; ')}`);
  }

  // ── 2. proposed APPLY/INVESTIGATE/PASS representable ──────────────────
  {
    const root = scratchRoot();
    const jobs = [
      { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Manufacturing Solutions Consultant' },
      { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/2', title: 'Software Engineer II' },
      { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/3', title: 'Plant Manager', location: 'Chicago, IL' },
    ];
    const { batchId, batch } = createBatchFromJobs(jobs, { root, source: 'test' });
    const decisions = batch.jobs.map((j, i) => ({
      job_key: j.job_key,
      proposed_decision: FIT_DECISIONS[i % 3],
      reason: FIT_DECISIONS[i % 3] === 'INVESTIGATE' ? 'JD does not state remote eligibility; confirm with recruiter' : 'test reason',
    }));
    const output = { decisions };
    const valErrors = validateReviewedOutput(output);
    if (valErrors.length === 0) pass('2. a decisions payload covering APPLY/INVESTIGATE/PASS validates');
    else fail(`2. valid decisions payload was rejected: ${valErrors.join('; ')}`);

    const updated = applyProposedDecisions(batchId, output, { root });
    const gotDecisions = updated.jobs.map((j) => j.review.proposed_decision).sort();
    if (JSON.stringify(gotDecisions) === JSON.stringify(FIT_DECISIONS.slice().sort())) {
      pass('2. all three decision values round-trip through applyProposedDecisions');
    } else fail(`2. decisions did not round-trip: ${JSON.stringify(gotDecisions)}`);

    // INVESTIGATE without a reason must be rejected.
    const badOutput = { decisions: [{ job_key: batch.jobs[0].job_key, proposed_decision: 'INVESTIGATE', reason: '' }] };
    const badErrors = validateReviewedOutput(badOutput);
    if (badErrors.some((e) => /reason/i.test(e))) pass('2. INVESTIGATE with no reason is rejected');
    else fail('2. INVESTIGATE with no reason was NOT rejected');
  }

  // ── 3. proposed decision alone cannot mutate durable state ────────────
  {
    const root = scratchRoot();
    const { batchId, batch } = createBatchFromJobs([SAMPLE_JOB], { root, source: 'test' });
    const jobKey = batch.jobs[0].job_key;
    applyProposedDecisions(batchId, { decisions: [{ job_key: jobKey, proposed_decision: 'APPLY', reason: 'looks good' }] }, { root });

    const reOpened = loadOpenBatch(batchId, { root });
    if (reOpened.jobs[0].review.final_decision === null) pass('3. proposed decision leaves final_decision null on the batch');
    else fail('3. proposed decision wrote a final_decision — should be impossible');

    const state = getJobState(jobKey, { root });
    if (state === null) pass('3. proposed decision alone never touches durable review-state');
    else fail(`3. proposed-only batch leaked into durable state: ${JSON.stringify(state)}`);

    // ingest with nothing finalized yet must be a no-op.
    const result = await ingestFinalizedReviewBatches({ root });
    if (result.ingested.length === 0) pass('3. ingestion with no finalized batches ingests nothing');
    else fail('3. ingestion ingested something with no finalized batch present');
  }

  // ── 4. human override is preserved ────────────────────────────────────
  {
    const root = scratchRoot();
    const { batchId, batch } = createBatchFromJobs([SAMPLE_JOB], { root, source: 'test' });
    const jobKey = batch.jobs[0].job_key;
    applyProposedDecisions(batchId, { decisions: [{ job_key: jobKey, proposed_decision: 'APPLY', reason: 'model likes it' }] }, { root });

    const finalized = finalizeBatch(batchId, { overrides: { [jobKey]: 'PASS' }, reviewer: 'henry', root });
    const job = finalized.jobs[0];
    if (job.review.final_decision === 'PASS' && job.review.proposed_decision === 'APPLY') {
      pass('4. human override wins over the proposed decision, proposed_decision preserved for audit');
    } else fail(`4. override was not applied/preserved correctly: ${JSON.stringify(job.review)}`);
    if (/override/i.test(job.review.reason)) pass('4. override is recorded in the reason trail');
    else fail('4. override was not annotated in reason');
  }

  // ── 5/6/7/9/10 — finalize + ingest lifecycle ───────────────────────────
  {
    const root = scratchRoot();
    const passJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/pass', title: 'Software Engineer II' };
    const investigateJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/inv', title: 'Manufacturing Consultant', location: 'United States' };
    const applyJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/apply', title: 'Manufacturing Solutions Consultant' };
    const { batchId, batch } = createBatchFromJobs([passJob, investigateJob, applyJob], { root, source: 'test' });
    const [pKey, iKey, aKey] = batch.jobs.map((j) => j.job_key);

    applyProposedDecisions(batchId, {
      decisions: [
        { job_key: pKey, proposed_decision: 'PASS', reason: 'core function is SWE, not manufacturing solutions' },
        { job_key: iKey, proposed_decision: 'INVESTIGATE', reason: 'location says only "United States"; confirm remote/NYC eligibility' },
        { job_key: aKey, proposed_decision: 'APPLY', reason: 'direct archetype hit, comp and geography clear' },
      ],
    }, { root });
    finalizeBatch(batchId, { root });

    // 8. unfinalized batch cannot mutate history: before ingestion, no durable state yet.
    if (getJobState(pKey, { root }) === null) pass('8. finalized-but-not-yet-ingested batch has not touched durable state');
    else fail('8. durable state was mutated before ingestion ran');

    const result1 = await ingestFinalizedReviewBatches({ root });
    if (result1.ingested.includes(batchId)) pass('9. first ingestion run ingests the finalized batch');
    else fail(`9. first ingestion run did not ingest: ${JSON.stringify(result1)}`);

    // 5. finalized PASS persists and suppresses.
    const passState = getJobState(pKey, { root });
    if (passState?.fit_decision === 'PASS') pass('5. finalized PASS persists in durable state');
    else fail(`5. PASS did not persist: ${JSON.stringify(passState)}`);
    if (isSuppressed(pKey, { root })) pass('5. a PASSed job_key reads as suppressed');
    else fail('5. a PASSed job_key does not read as suppressed');

    // 6. finalized INVESTIGATE does not resurface as NEW.
    const invState = getJobState(iKey, { root });
    if (invState?.fit_decision === 'INVESTIGATE') pass('6. finalized INVESTIGATE persists in durable state');
    else fail(`6. INVESTIGATE did not persist: ${JSON.stringify(invState)}`);

    // Re-source the same three jobs via pipeline.md — none should resurface as new.
    const pipelinePath = join(root, 'data', 'pipeline.md');
    mkdirSync(join(root, 'data'), { recursive: true });
    const rows = [passJob, investigateJob, applyJob]
      .map((j) => `- [ ] ${j.url} | ${j.company} | ${j.title} | ${j.location}`)
      .join('\n');
    writeFileSync(pipelinePath, `# Pipeline\n\n## Pending\n\n${rows}\n\n## Processed\n`);
    const resourced = createBatchFromPipelinePending({ root, pipelinePath });
    if (resourced.batchId === null) pass('6. re-sourcing PASS/INVESTIGATE/APPLY jobs produces no new batch (none resurface)');
    else fail(`6. a previously-decided job resurfaced as new: ${JSON.stringify(resourced.batch?.jobs?.map((j) => j.job_key))}`);

    // 7. finalized APPLY becomes READY_TO_APPLY.
    const applyState = getJobState(aKey, { root });
    if (applyState?.fit_decision === 'APPLY' && applyState?.execution_status === 'READY_TO_APPLY') {
      pass('7. finalized APPLY sets execution_status=READY_TO_APPLY');
    } else fail(`7. APPLY did not reach READY_TO_APPLY: ${JSON.stringify(applyState)}`);
    if (passState.execution_status === 'NONE' && invState.execution_status === 'NONE') {
      pass('7. execution_status stays NONE for PASS/INVESTIGATE (decision and execution are separate axes)');
    } else fail('7. execution_status leaked READY_TO_APPLY onto a non-APPLY decision');

    // File moved out of finalized/ into processed/.
    const p = reviewPaths(root);
    if (!existsSync(join(p.finalized, `${batchId}.json`)) && existsSync(join(p.processed, `${batchId}.json`))) {
      pass('9. ingested batch file moved from finalized/ to processed/');
    } else fail('9. ingested batch file was not moved to processed/');

    // 9. idempotency: run ingestion again — must not double-apply or error.
    const stateFileBefore = readFileSync(p.statePath, 'utf-8');
    const result2 = await ingestFinalizedReviewBatches({ root });
    const stateFileAfter = readFileSync(p.statePath, 'utf-8');
    if (result2.ingested.length === 0 && stateFileBefore === stateFileAfter) {
      pass('9. re-running ingestion is a no-op (idempotent)');
    } else fail(`9. re-running ingestion was NOT a no-op: ${JSON.stringify(result2)}`);
  }

  // ── 11. finalizeAndIngestBatch() — the combined UI/service lifecycle step ──
  {
    const root = scratchRoot();
    const applyJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/lc-apply', title: 'Manufacturing Solutions Consultant' };
    const investigateJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/lc-inv', title: 'Manufacturing Consultant', location: 'United States' };
    const passJob = { ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/lc-pass', title: 'Software Engineer II' };
    const { batchId, batch } = createBatchFromJobs([applyJob, investigateJob, passJob], { root, source: 'test' });
    const [aKey, iKey, pKey] = batch.jobs.map((j) => j.job_key);

    // No SOP pass at all here — every decision arrives as a human override,
    // exactly the shape the UI's Finalize Batch sends.
    const overrides = { [aKey]: 'APPLY', [iKey]: 'INVESTIGATE', [pKey]: 'PASS' };

    if (getJobState(aKey, { root }) === null) {
      pass('11. before finalizeAndIngestBatch, durable state has no record for these jobs');
    } else fail('11. durable state already had a record before finalizeAndIngestBatch ran');

    const { batch: finalized, ingestion } = await finalizeAndIngestBatch(batchId, { overrides, reviewer: 'ui-test', root });

    if (finalized.status === 'finalized') pass('11. finalizeAndIngestBatch finalizes the batch');
    else fail(`11. batch did not finalize: status=${finalized.status}`);

    if (ingestion.ingested.includes(batchId)) {
      pass('11. finalizeAndIngestBatch ingests the SAME batch it just finalized, in one call');
    } else fail(`11. finalizeAndIngestBatch did not report the batch as ingested: ${JSON.stringify(ingestion)}`);

    // Durable state is updated IMMEDIATELY — no separate doctor.mjs/ingest
    // call required, which is the whole point of this lifecycle function.
    const applyState = getJobState(aKey, { root });
    if (applyState?.fit_decision === 'APPLY' && applyState?.execution_status === 'READY_TO_APPLY') {
      pass('11. APPLY reaches fit_decision=APPLY/execution_status=READY_TO_APPLY immediately, with no separate ingest call');
    } else fail(`11. APPLY did not reach READY_TO_APPLY immediately: ${JSON.stringify(applyState)}`);

    const investigateState = getJobState(iKey, { root });
    const passState = getJobState(pKey, { root });
    if (investigateState?.fit_decision === 'INVESTIGATE' && investigateState?.execution_status === 'NONE'
      && passState?.fit_decision === 'PASS' && passState?.execution_status === 'NONE') {
      pass('11. INVESTIGATE and PASS both land at execution_status=NONE');
    } else fail(`11. INVESTIGATE/PASS execution_status leaked: ${JSON.stringify({ investigateState, passState })}`);

    // finalized/ -> processed/ movement happens as part of the same call.
    const p = reviewPaths(root);
    if (!existsSync(join(p.finalized, `${batchId}.json`)) && existsSync(join(p.processed, `${batchId}.json`))) {
      pass('11. batch moves from finalized/ to processed/ within the single finalizeAndIngestBatch call');
    } else fail('11. batch was not moved to processed/ by finalizeAndIngestBatch');

    // Re-running the general ingestion sweep (what doctor.mjs still does)
    // afterward must be a harmless no-op — the UI/service path already did
    // the real work, doctor.mjs is a catch-all, not a second write.
    const stateFileBefore = readFileSync(p.statePath, 'utf-8');
    const doctorSweep = await ingestFinalizedReviewBatches({ root });
    const stateFileAfter = readFileSync(p.statePath, 'utf-8');
    if (doctorSweep.ingested.length === 0 && stateFileBefore === stateFileAfter) {
      pass('11. a subsequent doctor.mjs-style ingestion sweep is a harmless no-op (UI/service path is not doctor-dependent)');
    } else fail(`11. subsequent ingestion sweep was not a no-op: ${JSON.stringify(doctorSweep)}`);
  }

  // ── 12. createBatchFromUrls() — scoped batch creation (cohort survivors) ──
  {
    const root = scratchRoot();
    mkdirSync(join(root, 'data'), { recursive: true });
    const pipelinePath = join(root, 'data', 'pipeline.md');
    // A realistic Pending section: a large pre-existing backlog PLUS the two
    // "cohort survivor" rows we actually want — mirrors the real production
    // shape (390-ish backlog rows sitting alongside 2 fresh cohort rows).
    const backlogRows = Array.from({ length: 12 }, (_, i) =>
      `- [ ] https://boards.greenhouse.io/acme/jobs/backlog-${i} | BacklogCo | Backlog Role ${i} | Remote - United States`);
    const cohortJobA = { url: 'https://jobs.smartrecruiters.com/ifs1/cohort-a', company: 'IFS', title: 'Forward Deployed AI Engineer', location: 'Itasca, IL, Remote' };
    const cohortJobB = { url: 'https://jobs.smartrecruiters.com/ifs1/cohort-b', company: 'IFS', title: 'Customer Success Manager', location: 'Itasca, IL, Remote' };
    const cohortRows = [cohortJobA, cohortJobB].map((j) => `- [ ] ${j.url} | ${j.company} | ${j.title} | ${j.location}`);
    writeFileSync(pipelinePath, `# Pipeline\n\n## Pending\n\n${backlogRows.join('\n')}\n${cohortRows.join('\n')}\n\n## Processed\n`);

    const result = createBatchFromUrls([cohortJobA.url, cohortJobB.url], { root, pipelinePath, source: 'cohort' });
    if (result.batchId && result.batch.jobs.length === 2) {
      pass('12. scoped batch creation includes exactly the requested jobs (2, not the 12-row backlog)');
    } else fail(`12. scoped batch had wrong membership: ${JSON.stringify(result.batch?.jobs?.length)}`);

    const titles = result.batch.jobs.map((j) => j.title).sort();
    if (titles.includes('Forward Deployed AI Engineer') && titles.includes('Customer Success Manager')) {
      pass('12. scoped batch contains the exact two requested titles');
    } else fail(`12. scoped batch had wrong titles: ${JSON.stringify(titles)}`);

    if (result.batch.source === 'cohort') pass('12. scoped batch records source=cohort');
    else fail(`12. scoped batch source was not recorded: ${result.batch.source}`);

    // The backlog rows must never have been touched/batched by this call.
    const p = reviewPaths(root);
    const openFiles = readdirSync(p.open);
    let backlogBatched = false;
    for (const f of openFiles) {
      const b = readJson(join(p.open, f), null);
      if (b?.jobs?.some((j) => j.company === 'BacklogCo')) backlogBatched = true;
    }
    if (!backlogBatched) pass('12. scoped batch creation does not sweep the unrelated Pending backlog');
    else fail('12. scoped batch creation swept backlog rows it should not have touched');

    // Re-running with the same URLs after the batch exists: already-batched,
    // reported distinctly, not silently duplicated into a second batch.
    const second = createBatchFromUrls([cohortJobA.url, cohortJobB.url], { root, pipelinePath, source: 'cohort' });
    if (second.batchId === null && second.skippedAlreadyBatched.length === 2) {
      pass('12. re-running on already-batched URLs creates no duplicate batch and reports them as already-batched');
    } else fail(`12. re-run did not correctly detect already-batched URLs: ${JSON.stringify(second)}`);

    // A URL not present in Pending at all is reported, not silently dropped.
    const notFoundResult = createBatchFromUrls(['https://example.com/not-in-pipeline'], { root, pipelinePath });
    if (notFoundResult.batchId === null && notFoundResult.notFound.includes('https://example.com/not-in-pipeline')) {
      pass('12. a URL absent from Pending is reported in notFound, not silently ignored');
    } else fail(`12. notFound reporting broken: ${JSON.stringify(notFoundResult)}`);
  }

  // ── 13. extractJobsToNewBatch() — controlled correction for a job stuck ──
  //       in the wrong-scoped batch (the batch-20260916-0006 real scenario)
  {
    const root = scratchRoot();
    const bigJob1 = { url: 'https://boards.greenhouse.io/acme/jobs/big-1', company: 'BacklogCo', title: 'Backlog Role 1' };
    const bigJob2 = { url: 'https://boards.greenhouse.io/acme/jobs/big-2', company: 'BacklogCo', title: 'Backlog Role 2' };
    const survivorA = { url: 'https://jobs.smartrecruiters.com/ifs1/extract-a', company: 'IFS', title: 'Forward Deployed AI Engineer' };
    const survivorB = { url: 'https://jobs.smartrecruiters.com/ifs1/extract-b', company: 'IFS', title: 'Customer Success Manager' };
    const { batchId: bigBatchId, batch: bigBatch } = createBatchFromJobs([bigJob1, survivorA, survivorB, bigJob2], { root, source: 'pipeline.md' });
    const [k1, kA, kB, k2] = bigBatch.jobs.map((j) => j.job_key);

    const result = extractJobsToNewBatch(bigBatchId, [kA, kB], { root, source: 'cohort' });
    if (result.extractedCount === 2 && result.remainingCount === 2) {
      pass('13. extraction moves exactly the requested 2 jobs, leaving the other 2 in place');
    } else fail(`13. extraction counts wrong: ${JSON.stringify(result)}`);

    const newBatch = loadOpenBatch(result.newBatchId, { root });
    const newKeys = newBatch.jobs.map((j) => j.job_key).sort();
    if (JSON.stringify(newKeys) === JSON.stringify([kA, kB].sort())) {
      pass('13. new batch contains exactly the extracted job_keys, nothing else');
    } else fail(`13. new batch membership wrong: ${JSON.stringify(newKeys)}`);
    if (newBatch.source === 'cohort') pass('13. new batch records the given source');
    else fail(`13. new batch source wrong: ${newBatch.source}`);

    const sourceAfter = loadOpenBatch(bigBatchId, { root });
    const sourceKeys = sourceAfter.jobs.map((j) => j.job_key).sort();
    if (JSON.stringify(sourceKeys) === JSON.stringify([k1, k2].sort())) {
      pass('13. source batch retains exactly the 2 non-extracted jobs after removal');
    } else fail(`13. source batch membership wrong after extraction: ${JSON.stringify(sourceKeys)}`);
    if (sourceAfter.batch_id === bigBatchId) pass('13. source batch keeps its original batch_id (not recreated)');
    else fail('13. source batch_id changed unexpectedly');

    // Verbatim relocation: job_key and gates are untouched, not recomputed.
    const originalA = bigBatch.jobs.find((j) => j.job_key === kA);
    const movedA = newBatch.jobs.find((j) => j.job_key === kA);
    if (JSON.stringify(movedA.gates) === JSON.stringify(originalA.gates) && movedA.job_key === originalA.job_key) {
      pass('13. moved job record is relocated verbatim (job_key and gates unchanged, not recomputed)');
    } else fail('13. moved job record diverged from its original');

    // No job_key exists in both batches simultaneously.
    const overlap = sourceKeys.filter((k) => newKeys.includes(k));
    if (overlap.length === 0) pass('13. no job_key appears in both the source and new batch (no duplicate)');
    else fail(`13. duplicate job_key(s) across batches: ${overlap}`);

    // Refuses to extract an already-decided job.
    const root2 = scratchRoot();
    const decidedJob = { url: 'https://boards.greenhouse.io/acme/jobs/decided-1', company: 'Acme', title: 'Decided Role' };
    const { batchId: decidedBatchId, batch: decidedBatch } = createBatchFromJobs([decidedJob], { root: root2, source: 'test' });
    applyProposedDecisions(decidedBatchId, { decisions: [{ job_key: decidedBatch.jobs[0].job_key, proposed_decision: 'APPLY', reason: 'test' }] }, { root: root2 });
    let threw = false;
    try { extractJobsToNewBatch(decidedBatchId, [decidedBatch.jobs[0].job_key], { root: root2 }); }
    catch { threw = true; }
    if (threw) pass('13. extraction refuses a job that already has a proposed_decision');
    else fail('13. extraction allowed moving an already-reviewed job');

    // Refuses an unknown job_key.
    let threwMissing = false;
    try { extractJobsToNewBatch(bigBatchId, ['url:not-in-this-batch'], { root }); }
    catch { threwMissing = true; }
    if (threwMissing) pass('13. extraction refuses an unknown job_key');
    else fail('13. extraction silently ignored an unknown job_key');
  }

  // ── 10. existing stable job identity is reused ─────────────────────────
  {
    const urlJob = { url: 'https://boards.greenhouse.io/acme/jobs/999?utm_source=linkedin', company: 'Acme', title: 'Role' };
    const expectedUrlKey = `url:${normalizeUrl(urlJob.url)}`;
    if (computeJobKey(urlJob) === expectedUrlKey && expectedUrlKey !== 'url:') {
      pass('10. job_key for a URL-bearing job reuses url-key.mjs normalizeUrl() verbatim');
    } else fail(`10. job_key diverged from normalizeUrl(): ${computeJobKey(urlJob)} vs ${expectedUrlKey}`);

    const noUrlJob = { company: 'Acme Corp.', title: 'Solutions Consultant', location: 'Remote' };
    const expectedCrKey = `cr:${companyRoleDedupKey(noUrlJob.company, noUrlJob.title, undefined, noUrlJob.location)}`;
    if (computeJobKey(noUrlJob) === expectedCrKey) {
      pass('10. job_key for a URL-less job reuses scan.mjs companyRoleDedupKey() verbatim');
    } else fail(`10. job_key diverged from companyRoleDedupKey(): ${computeJobKey(noUrlJob)} vs ${expectedCrKey}`);

    // Two spellings of the same posting URL must key identically — the same
    // guarantee the tracker's own dedup relies on (url-key.mjs).
    const a = computeJobKey({ url: 'http://boards.greenhouse.io/acme/jobs/1/?utm_source=x' });
    const b = computeJobKey({ url: 'https://Boards.Greenhouse.io/acme/jobs/1' });
    if (a === b && a !== '') pass('10. two URL spellings of the same posting share one job_key');
    else fail(`10. URL identity was not reused correctly: ${a} vs ${b}`);
  }

  // ── batch-shape sanity (buildBatch/validateBatch direct) ───────────────
  {
    const { batch } = buildBatch([SAMPLE_JOB], { batchId: 'batch-direct-0001', source: 'test' });
    if (validateBatch(batch, 'open').length === 0) pass('buildBatch()/validateBatch() agree on a minimal valid batch');
    else fail('buildBatch() produced a batch validateBatch() rejects');
  }
}

try {
  await main();
} catch (err) {
  fail(`review.test.mjs crashed: ${err.stack || err.message}`);
}
