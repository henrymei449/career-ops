// tests/investigate-queue.test.mjs — Investigate / Queue is a VIRTUAL view over
// durable state (fit_decision=INVESTIGATE, execution_status=NONE): no new
// storage, no copied jobs, original batch history untouched, and a re-decision
// updates the SAME durable record via the existing APPLY / PASS mappings.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import {
  createBatchFromJobs, applyProposedDecisions, finalizeAndIngestBatch, reviewPaths, readJson,
  listInvestigateQueue, decideInvestigateJob, INVESTIGATE_QUEUE_ID,
} from '../review.mjs';
import { investigateQueueSummary, listInvestigateQueueJobs, listOpenBatchSummaries, listReviewJobsForBatch } from '../ui-server.mjs';

const job = (n, title) => ({ url: `https://boards.greenhouse.io/co/jobs/${n}`, company: 'Co', title, location: 'Remote - United States', description: `${title} JD text. `.repeat(20) });

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'co-invq-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const { batchId } = createBatchFromJobs([job(1, 'Inv One'), job(2, 'Inv Two'), job(3, 'Applied Job'), job(4, 'Passed Job')], { root, source: 'test' });
  const open = readJson(join(reviewPaths(root).open, `${batchId}.json`), null);
  open.jobs[0].resume_gate = { gate_status: 'OK', resume_route: 'MANUFACTURING', resume_gate: 'MAJOR TAILOR', role_fit: 'WEAK', why: 'w', material_gaps: ['g'], fit_warning: 'FW-KEEP', estimated_effort: '10 min', sop_version: '2', jd_hash: 'x', raw_output: 'RAW' };
  writeFileSync(join(reviewPaths(root).open, `${batchId}.json`), JSON.stringify(open, null, 2) + '\n');
  const keys = open.jobs.map((j) => j.job_key);
  const decisions = ['INVESTIGATE', 'INVESTIGATE', 'APPLY', 'PASS'];
  applyProposedDecisions(batchId, { decisions: keys.map((k, i) => ({ job_key: k, proposed_decision: decisions[i], reason: 'r', reason_codes: [] })) }, { root });
  await finalizeAndIngestBatch(batchId, { root });

  const statePath = reviewPaths(root).statePath;
  const state0 = readJson(statePath, null);
  const processedPath = join(reviewPaths(root).processed, `${batchId}.json`);
  const processedBefore = readFileSync(processedPath, 'utf-8');

  // ── the queue is exactly the durable INVESTIGATE/NONE jobs ──────────────
  const q = listInvestigateQueue({ root });
  if (q.length === 2 && q.every((x) => x.durable.fit_decision === 'INVESTIGATE' && x.durable.execution_status === 'NONE')) pass('queue = durable jobs with fit_decision=INVESTIGATE and execution_status=NONE (APPLY/PASS jobs excluded)');
  else fail(`queue wrong: ${JSON.stringify(q.map((x) => x.job_key))}`);
  if (listOpenBatchSummaries(root).length === 0 && !existsInBatches(root)) pass('finalized INVESTIGATE jobs are gone from the open batches (no new batch file was created for the queue)');
  else fail('queue created/kept a batch');

  // ── selector entry + card projection (virtual) ──────────────────────────
  const summary = investigateQueueSummary(root);
  if (summary.batch_id === INVESTIGATE_QUEUE_ID && summary.label === 'Investigate / Queue — 2 jobs' && summary.virtual === true) pass('selector entry reads "Investigate / Queue — 2 jobs" and is marked virtual');
  else fail(`summary wrong: ${JSON.stringify(summary)}`);
  const view = listInvestigateQueueJobs(root);
  const one = view.jobs.find((j) => j.title === 'Inv One');
  if (view.jobs.length === 2 && one.url.endsWith('/1') && one.location === 'Remote - United States' && one.resume_gate?.fit_warning === 'FW-KEEP' && one.resume_gate.raw_output === 'RAW' && one.final_decision === 'INVESTIGATE') pass('queue cards keep source URL, location and the original batch\'s Resume Gate result (read from the processed batch)');
  else fail(`card projection wrong: ${JSON.stringify(one)}`);

  // ── INVESTIGATE stays; APPLY / PASS move through the normal paths ───────
  const keyOne = one.job_key;
  const keyTwo = view.jobs.find((j) => j.title === 'Inv Two').job_key;
  const same = await decideInvestigateJob(keyOne, 'INVESTIGATE', { root });
  if (same.unchanged && listInvestigateQueue({ root }).length === 2) pass('choosing INVESTIGATE leaves the job in the queue, unchanged');
  else fail('INVESTIGATE was not a no-op');

  await decideInvestigateJob(keyOne, 'APPLY', { root });
  await decideInvestigateJob(keyTwo, 'PASS', { root });
  const state1 = readJson(statePath, null);
  const a = state1.jobs[keyOne]; const p = state1.jobs[keyTwo];
  if (a.fit_decision === 'APPLY' && a.execution_status === 'READY_TO_APPLY' && a.revisited_from === 'INVESTIGATE') pass('APPLY -> fit_decision=APPLY, execution_status=READY_TO_APPLY (normal Ready to Apply path)');
  else fail(`APPLY mapping wrong: ${JSON.stringify(a)}`);
  if (p.fit_decision === 'PASS' && p.execution_status === 'NONE') pass('PASS -> fit_decision=PASS, execution_status=NONE (normal suppressed path)');
  else fail(`PASS mapping wrong: ${JSON.stringify(p)}`);
  if (listInvestigateQueue({ root }).length === 0 && investigateQueueSummary(root) === null) pass('both jobs left the queue; the selector entry disappears when empty');
  else fail('queue not emptied');

  // ── no duplicates, history untouched, other jobs untouched ──────────────
  if (Object.keys(state1.jobs).length === Object.keys(state0.jobs).length && Object.keys(state1.jobs).length === 4) pass('no duplicate durable records: same 4 job_keys before and after');
  else fail(`durable job count changed: ${Object.keys(state0.jobs).length} -> ${Object.keys(state1.jobs).length}`);
  if (readFileSync(processedPath, 'utf-8') === processedBefore) pass('the original (processed) batch file is byte-identical: history not mutated');
  else fail('processed batch modified');
  if (JSON.stringify(state1.jobs[keys[2]]) === JSON.stringify(state0.jobs[keys[2]]) && JSON.stringify(state1.jobs[keys[3]]) === JSON.stringify(state0.jobs[keys[3]])) pass('unrelated durable jobs are untouched');
  else fail('unrelated durable job changed');

  // ── guards: only INVESTIGATE/NONE jobs can be re-decided here ───────────
  for (const [name, k] of [['an APPLY job', keys[2]], ['a PASS job', keys[3]], ['an unknown job', 'url:nope']]) {
    try { await decideInvestigateJob(k, 'APPLY', { root }); fail(`${name} must be refused`); } catch (e) { if (/not in the Investigate/.test(e.message)) pass(`refused: ${name} is not in the queue`); else fail(e.message); }
  }
  try { await decideInvestigateJob(keyOne, 'SKIP', { root }); fail('invalid decision accepted'); } catch { pass('invalid decision value rejected'); }
  if (listReviewJobsForBatch(undefined, root) === null) pass('existing batch reader is unchanged (no open batches -> null)');
  else fail('batch reader changed');
}

function existsInBatches(root) {
  return listOpenBatchSummaries(root).some((b) => b.batch_id === INVESTIGATE_QUEUE_ID);
}

try { await main(); } catch (err) { fail(`investigate-queue.test.mjs crashed: ${err.stack || err.message}`); }
