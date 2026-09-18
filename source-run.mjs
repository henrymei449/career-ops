#!/usr/bin/env node
/**
 * source-run.mjs — shared production orchestration for every source-sourcing
 * entrypoint: discovery -> deterministic filtering -> survivors -> canonical
 * Review batch. Closes the gap where LinkedIn (and, before this, Strategic
 * Employer Cohort / VC Portfolio) scans landed in data/pipeline.md and
 * stopped there, requiring a manual, separate `review.mjs` call before
 * anything showed up in the Review UI.
 *
 * This module does NOT replace scan.mjs's discovery/filter/dedupe logic, and
 * does NOT invent a new batch schema — it owns exactly the one step every
 * source was missing: folding a completed scan run's own survivor URLs into
 * one canonical open Review batch via review.mjs's existing createBatchFromUrls().
 *
 * Each source keeps driving its own scan.mjs call(s) exactly as before (a
 * single multi-match --company call for LinkedIn; a per-company loop for a
 * cohort source, preserved unchanged in the data-root runner scripts) and
 * hands the resulting JSON receipt(s) to runSourceToReview(), which is the
 * only new shared step.
 *
 * Usage:
 *   node source-run.mjs linkedin [--since N]   # LinkedIn: single multi-match scan.mjs call
 *
 * "strategic" and "vc" sources are driven by their own cohort runners in the
 * data root (run-recurring-cohort.mjs, run-vc-portfolio-cohort.mjs) — each
 * keeps its own per-company loop and company list untouched, and calls
 * runSourceToReview() itself at the end with the receipts it already
 * collected. They are not invoked from here because their company lists are
 * user-owned operational data (Data Contract), not shared repo code.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { createBatchFromUrls } from './review.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue } from './lib/cli-flags.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run scan.mjs once for a single `--company` substring (may match several
 * portals.yml entries, as "LinkedIn" matches all enabled LinkedIn query
 * families) and return its parsed JSON receipt. Identical invocation shape
 * to the existing cohort runners (run-recurring-cohort.mjs /
 * run-vc-portfolio-cohort.mjs) — no new scan.mjs CLI surface.
 *
 * @param {string} company - `--company` substring filter.
 * @param {{since?: number|string, repo?: string, root?: string}} [opts]
 * @returns {object} scan.mjs's parsed `careerops.scan.receipt` JSON.
 */
export function runScanForCompany(company, { since, repo = REPO, root } = {}) {
  const argv = [path.join(repo, 'scan.mjs'), '--company', company, '--json', '--quiet'];
  if (since != null) argv.push('--since', String(since));
  const env = { ...process.env };
  if (root) env.CAREER_OPS_DATA_DIR = root;
  const out = execFileSync(process.execPath, argv, { cwd: repo, encoding: 'utf-8', timeout: 180_000, env });
  const line = out.split('\n').reverse().find((l) => l.trim().startsWith('{"version"'));
  if (!line) throw new Error(`scan.mjs produced no JSON receipt for --company "${company}":\n${out.slice(-500)}`);
  return JSON.parse(line);
}

/**
 * Fold N scan.mjs receipts (one multi-match call, or one call per cohort
 * company) into one source-run summary: raw/filtered/survivor counts and the
 * deduped survivor URL list across all of them. Pure aggregation — no I/O,
 * no dedup against Review state (that happens in createReviewBatchForSource,
 * which is the only place that needs to know about batching).
 *
 * @param {object[]} receipts - scan.mjs JSON receipts.
 */
export function summarizeReceipts(receipts) {
  const addedUrls = [];
  const seen = new Set();
  let raw = 0;
  let filtered = 0;
  let survivors = 0;
  for (const r of receipts || []) {
    raw += r?.found ?? 0;
    filtered += r?.filtered ?? 0;
    survivors += r?.added ?? 0;
    for (const u of r?.added_urls ?? []) {
      if (!seen.has(u)) {
        seen.add(u);
        addedUrls.push(u);
      }
    }
  }
  return { raw_count: raw, filtered_count: filtered, survivor_count: survivors, added_urls: addedUrls };
}

/**
 * The terminal step every production source run must reach: fold survivor
 * URLs into exactly one canonical open Review batch. Uses review.mjs's own
 * createBatchFromUrls() — the existing scoped batch writer built for exactly
 * this ("a cohort run... that already knows its exact survivor URLs") — so
 * there is no second Review schema and no sweep of unrelated pipeline.md
 * Pending rows.
 *
 * Idempotent by construction: createBatchFromUrls() dedupes against
 * collectSeenJobKeys() (open + finalized + processed + durable state), so
 * calling this again with the same URLs after they are already batched
 * returns batchId=null with 0 new jobs rather than a duplicate batch.
 *
 * @param {string} source - Source label stored on the batch (`linkedin`, `strategic`, `vc`).
 * @param {string[]} addedUrls - Exact survivor URLs from this run's receipt(s).
 * @param {{root?: string}} [opts]
 */
export function createReviewBatchForSource(source, addedUrls, { root } = {}) {
  if (!addedUrls || addedUrls.length === 0) {
    return { batchId: null, filePath: null, jobCount: 0, skippedAlreadyBatched: [], notFound: [] };
  }
  const opts = { source };
  if (root) opts.root = root;
  const result = createBatchFromUrls(addedUrls, opts);
  return {
    batchId: result.batchId,
    filePath: result.filePath,
    jobCount: result.batch ? result.batch.jobs.length : 0,
    skippedAlreadyBatched: result.skippedAlreadyBatched || [],
    notFound: result.notFound || [],
  };
}

/**
 * Full production contract for one source run: survivors (already collected
 * by the caller's own scan.mjs call(s), preserving that source's existing
 * provider/filter/dedupe/query logic untouched) -> canonical Review batch.
 *
 * Returns the output contract required of every production source
 * invocation: source, run_id, raw_count, filtered_count, survivor_count,
 * batch_id, review_batch_path, status.
 *
 * status:
 *   'ok'                 - survivors > 0, new batch created (batch_id set).
 *   'ok-empty'            - survivors === 0, no batch needed (a valid, complete run).
 *   'ok-already-batched'  - survivors > 0, but every one of them was already
 *                           batched (a genuine retry) — no new batch is a
 *                           correct outcome, not a failure.
 *   'incomplete'          - survivors > 0 and batch creation did not produce
 *                           a batch for at least one of them for any other
 *                           reason (including a survivor URL the receipt
 *                           claimed but pipeline.md's Pending section does
 *                           not actually contain — a discovery/Review
 *                           bookkeeping break). Callers must treat this as a
 *                           failed production run (non-zero exit), never as
 *                           success.
 *
 * @param {{source: string, receipts: object[], root?: string, runId?: string}} args
 */
export function runSourceToReview({ source, receipts, root, runId }) {
  const { raw_count, filtered_count, survivor_count, added_urls } = summarizeReceipts(receipts);
  const result = {
    source,
    run_id: runId || new Date().toISOString(),
    raw_count,
    filtered_count,
    survivor_count,
    batch_id: null,
    review_batch_path: null,
    status: 'ok',
  };

  if (survivor_count === 0) {
    result.status = 'ok-empty';
    return result;
  }

  const batch = createReviewBatchForSource(source, added_urls, { root });

  if (batch.batchId) {
    result.batch_id = batch.batchId;
    result.review_batch_path = batch.filePath;
    result.status = 'ok';
    return result;
  }

  // notFound means the run's own receipt claimed a survivor URL that isn't
  // actually present in pipeline.md's Pending section — a bookkeeping break
  // between discovery and Review, exactly the defect this contract exists to
  // catch. Only "every remaining URL was already batched" (a genuine retry)
  // is a benign no-new-batch outcome.
  result.status = batch.notFound.length === 0 && batch.skippedAlreadyBatched.length === added_urls.length
    ? 'ok-already-batched'
    : 'incomplete';
  return result;
}

/**
 * Read a receipt (or array of receipts) from a JSON file — the
 * source-agnostic entry point for a caller that already ran its own
 * discovery (any shape: a scan.mjs `careerops.scan.receipt`, an
 * append-pipeline-entry.mjs `appendOffers()` result, or anything else with
 * `added`/`added_urls`, since summarizeReceipts() only ever reads those two
 * fields) and wants to hand its survivors to the shared handoff without
 * this module re-running that discovery itself.
 *
 * @param {string} filePath
 * @returns {object[]}
 */
export function readReceiptFile(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  return Array.isArray(raw) ? raw : [raw];
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const source = argv[0];
  const since = flagValue(argv, '--since');
  const root = getCareerOpsRoot();
  const fromReceiptPath = flagValue(argv, '--from-receipt');

  if (fromReceiptPath) {
    // Generic path: any caller (a scheduler wrapper, a future source) that
    // already produced its own receipt(s) hands them straight to the same
    // shared handoff every other source uses — no re-discovery, no second
    // Review implementation. `--source` names the batch's source label.
    const receiptSource = flagValue(argv, '--source');
    if (!receiptSource) {
      console.error('Usage: node source-run.mjs --from-receipt <path> --source <name>');
      process.exitCode = 1;
    } else {
      let result;
      try {
        const receipts = readReceiptFile(fromReceiptPath);
        result = runSourceToReview({ source: receiptSource, receipts, root });
      } catch (err) {
        console.log(JSON.stringify({ source: receiptSource, status: 'incomplete', error: String(err?.message || err) }, null, 2));
        process.exitCode = 1;
        throw err;
      }
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'incomplete') process.exitCode = 1;
    }
  } else if (source === 'linkedin') {
    let result;
    try {
      const receipt = runScanForCompany('LinkedIn', { since, root });
      result = runSourceToReview({ source: 'linkedin', receipts: [receipt], root });
    } catch (err) {
      console.log(JSON.stringify({ source: 'linkedin', status: 'incomplete', error: String(err?.message || err) }, null, 2));
      process.exitCode = 1;
      throw err;
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'incomplete') process.exitCode = 1;
  } else {
    console.error(
      'Usage: node source-run.mjs linkedin [--since N]\n' +
      '       node source-run.mjs --from-receipt <path> --source <name>\n\n' +
      '"strategic" and "vc" run through their existing cohort runners in the data ' +
      'root (run-recurring-cohort.mjs, run-vc-portfolio-cohort.mjs), which call ' +
      'runSourceToReview() themselves at the end of their own per-company loop — ' +
      'their company lists are user-owned operational data, not shared repo code. ' +
      '--from-receipt is for any other caller that already has a receipt-shaped ' +
      'result (a scan.mjs receipt, an append-pipeline-entry.mjs result, etc.) and ' +
      'wants it folded into the same canonical Review handoff without this module ' +
      're-running the discovery itself.',
    );
    process.exitCode = 1;
  }
}
