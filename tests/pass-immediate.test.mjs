// tests/pass-immediate.test.mjs — PASS in an OPEN batch is an immediate
// per-job disposition: durable PASS now (normal suppression semantics), job
// removed from the open batch now, Resume Gate never sees it afterwards.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import { createBatchFromJobs, createBatchFromPipelinePending, passJobFromBatch, reviewPaths, readJson, isSuppressed, getJobState } from '../review.mjs';
import { runResumeGateForBatch } from '../resume-gate.mjs';
import { listReviewJobsForBatch } from '../ui-server.mjs';

const jd = (t) => `${t} full JD text. `.repeat(20);
const job = (n, title) => ({ url: `https://boards.greenhouse.io/co/jobs/${n}`, company: 'Co', title, location: 'Remote - United States', description: jd(title) });
const SOP = { path: 'f', source: 'registry', version: '2', sha256: 'x', text: '---\nsop: resume-gate\nversion: 2\n---\n```\nRESUME ROUTE:\n<INDUSTRY 4.0 / ELASTIC / ACCOUNT EXECUTIVE / MANUFACTURING>\n\nRESUME GATE:\n<AS-IS / MINOR TAILOR / MEDIUM TAILOR / MAJOR TAILOR>\n\nROLE FIT:\n<STRONG / MODERATE / WEAK>\n```\n' };
const OUT = 'RESUME ROUTE:\nMANUFACTURING\n\nWHY:\nw\n\nRESUME GATE:\nMINOR TAILOR\n\nROLE FIT:\nSTRONG\n\nMATERIAL GAPS:\n- None material.\n\nESTIMATED EFFORT:\n10 min\n\nFIT WARNING:\nNONE';

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'co-pass-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const { batchId, batch } = createBatchFromJobs([job(1, 'Keep A'), job(2, 'Bad Fit'), job(3, 'Keep B')], { root, source: 'test' });
  const bad = batch.jobs.find((j) => j.title === 'Bad Fit');

  const r = await passJobFromBatch(batchId, bad.job_key, { root });
  const view = listReviewJobsForBatch(batchId, root); // fresh read from disk == what a refresh shows
  if (r.remaining === 2 && view.jobs.length === 2 && !view.jobs.some((j) => j.job_key === bad.job_key)) pass('PASS removes the job from the open batch immediately; batch count 3 -> 2; a fresh read does not bring it back');
  else fail(`batch not updated: ${JSON.stringify({ r, n: view?.jobs.length })}`);

  const d = getJobState(bad.job_key, { root });
  if (d.fit_decision === 'PASS' && d.execution_status === 'NONE' && d.url === bad.url && d.company === 'Co' && d.title === 'Bad Fit' && d.batch_id === batchId && d.decided_at && isSuppressed(bad.job_key, { root })) pass('durable state is the normal PASS record (fit_decision=PASS, execution_status=NONE) and isSuppressed() is true');
  else fail(`durable record wrong: ${JSON.stringify(d)}`);

  // discovery/dedupe: a pipeline.md Pending entry for that job must not be re-batched
  writeFileSync(join(root, 'data', 'pipeline.md'), `## Pending\n\n- [ ] ${bad.url} | Co | Bad Fit | Remote - United States\n`);
  const again = createBatchFromPipelinePending({ root });
  if (!again.batchId) pass('discovery suppression intact: the passed job is not re-batched from pipeline.md');
  else fail('passed job was re-batched');

  // Resume Gate: only the 2 remaining jobs, never the passed one
  const seen = [];
  const s = await runResumeGateForBatch(batchId, { root, sop: SOP, jdResolvers: [], invoke: async (prompt) => { seen.push(/Bad Fit/.test(prompt) ? 'BAD' : /Keep A/.test(prompt) ? 'A' : 'B'); return { text: OUT }; } });
  if (s.total === 2 && s.gated === 2 && seen.sort().join() === 'A,B') pass('Run Resume Gate sees only the 2 remaining jobs and invokes on both; the passed job is never invoked');
  else fail(`gate saw wrong jobs: ${JSON.stringify({ total: s.total, gated: s.gated, seen })}`);

  // guards
  try { await passJobFromBatch(batchId, bad.job_key, { root }); fail('re-pass of a removed job should be refused'); } catch { pass('a job already removed cannot be passed again from the batch'); }
  const keepA = view.jobs.find((j) => j.title === 'Keep A').job_key;
  const stateP = reviewPaths(root).statePath;
  const st = readJson(stateP, null); st.jobs[keepA] = { fit_decision: 'APPLY', execution_status: 'APPLIED' }; writeFileSync(stateP, JSON.stringify(st));
  try { await passJobFromBatch(batchId, keepA, { root }); fail('must not overwrite an existing non-PASS durable decision'); } catch (e) { if (/already has a durable APPLY/.test(e.message)) pass('refuses to overwrite an existing non-PASS durable decision'); else fail(e.message); }
  if (listReviewJobsForBatch(batchId, root).jobs.some((j) => j.job_key === keepA)) pass('the refused job stays in the batch untouched');
  else fail('refused job was removed');

  // passing the rest empties and deletes the open batch file; durable records remain
  const keepB = view.jobs.find((j) => j.title === 'Keep B').job_key;
  const st2 = readJson(stateP, null); delete st2.jobs[keepA]; writeFileSync(stateP, JSON.stringify(st2));
  await passJobFromBatch(batchId, keepA, { root });
  const last = await passJobFromBatch(batchId, keepB, { root });
  if (last.remaining === 0 && !existsSync(join(reviewPaths(root).open, `${batchId}.json`)) && isSuppressed(keepA, { root }) && isSuppressed(keepB, { root }) && isSuppressed(bad.job_key, { root })) pass('passing the last jobs deletes the emptied open batch; all three durable PASS records remain');
  else fail(`emptied-batch handling wrong: ${JSON.stringify(last)}`);
  if (Object.keys(readJson(stateP, null).jobs).length === 3) pass('exactly one durable record per job (no duplicates)');
  else fail('duplicate/extra durable records');
}

try { await main(); } catch (err) { fail(`pass-immediate.test.mjs crashed: ${err.stack || err.message}`); }
