// tests/source-run.test.mjs — production source -> canonical Review batch
// contract (P0: every production sourcing invocation must end in exactly one
// open Review batch when it finds survivors, or a clean no-batch success when
// it doesn't).
//
// Fixture-based: fabricates scan.mjs-shaped JSON receipts directly rather
// than invoking scan.mjs or any external provider, so this suite runs
// offline and costs nothing.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, finish } from './helpers.mjs';

import { summarizeReceipts, createReviewBatchForSource, runSourceToReview } from '../source-run.mjs';
import { loadOpenBatch } from '../review.mjs';

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), 'co-source-run-test-'));
}

function receipt({ found = 0, filtered = 0, added = 0, added_urls = [] } = {}) {
  return { version: 'careerops.scan.receipt@1', found, filtered, added, added_urls, errors: [], dry_run: false };
}

/**
 * Seed a scratch root's data/pipeline.md Pending section with one row per
 * URL, mirroring what scan.mjs itself would have just written — that's the
 * artifact createBatchFromUrls() (called by runSourceToReview()) reads
 * survivor job records from.
 *
 * job identity (computeJobKey) for a `local:jds/...` reference is derived
 * from company+title+location, NOT the URL, so each row gets a distinct
 * company/title (keyed off the URL) — otherwise two genuinely different
 * fixture postings would collide onto the same job_key, as two REAL distinct
 * postings with different companies never would.
 */
function seedPipeline(root, urls) {
  mkdirSync(join(root, 'data'), { recursive: true });
  const rows = urls.map((u, i) => `- [ ] ${u} | Company ${i} (${u}) | Solutions Consultant | Remote | posted: 2026-09-16`);
  writeFileSync(join(root, 'data', 'pipeline.md'), `# Pipeline\n\n## Pending\n${rows.join('\n')}\n`);
}

async function main() {
  // ── LinkedIn survivors -> Review batch ─────────────────────────────────
  {
    const root = scratchRoot();
    const urls = ['local:jds/a.md', 'local:jds/b.md', 'local:jds/c.md'];
    seedPipeline(root, urls);
    const r = receipt({ found: 50, filtered: 47, added: 3, added_urls: urls });
    const result = runSourceToReview({ source: 'linkedin', receipts: [r], root });

    if (result.status === 'ok' && result.batch_id) pass('linkedin: survivors produce an ok run with a batch_id');
    else fail(`linkedin: expected ok+batch_id, got ${JSON.stringify(result)}`);

    if (result.source === 'linkedin' && result.raw_count === 50 && result.filtered_count === 47 && result.survivor_count === 3) {
      pass('linkedin: output contract counts match the receipt');
    } else fail(`linkedin: output contract counts wrong: ${JSON.stringify(result)}`);

    const batch = loadOpenBatch(result.batch_id, { root });
    if (batch && batch.jobs.length === 3 && batch.source === 'linkedin') {
      pass('linkedin: batch has exactly the 3 survivors and the correct source label');
    } else fail(`linkedin: batch shape wrong: ${JSON.stringify(batch)}`);

    if (result.review_batch_path && existsSync(result.review_batch_path)) {
      pass('linkedin: review_batch_path points at a real file on disk');
    } else fail('linkedin: review_batch_path missing or does not exist');
  }

  // ── Strategic Employer Cohort survivors -> Review batch ────────────────
  {
    const root = scratchRoot();
    seedPipeline(root, ['local:jds/strat-1.md', 'local:jds/strat-2.md']);
    const receipts = [
      receipt({ found: 5, filtered: 4, added: 1, added_urls: ['local:jds/strat-1.md'] }),
      receipt({ found: 8, filtered: 8, added: 0, added_urls: [] }),
      receipt({ found: 3, filtered: 2, added: 1, added_urls: ['local:jds/strat-2.md'] }),
    ];
    const result = runSourceToReview({ source: 'strategic', receipts, root });

    if (result.status === 'ok' && result.batch_id && result.survivor_count === 2) {
      pass('strategic: per-company receipts fold into one batch of 2 survivors');
    } else fail(`strategic: expected ok/2 survivors, got ${JSON.stringify(result)}`);

    const batch = loadOpenBatch(result.batch_id, { root });
    if (batch && batch.source === 'strategic' && batch.jobs.length === 2) {
      pass('strategic: batch source label is "strategic"');
    } else fail(`strategic: wrong batch source/shape: ${JSON.stringify(batch)}`);
  }

  // ── VC Portfolio survivors -> Review batch ──────────────────────────────
  {
    const root = scratchRoot();
    seedPipeline(root, ['local:jds/vc-1.md']);
    const receipts = [
      receipt({ found: 2, filtered: 1, added: 1, added_urls: ['local:jds/vc-1.md'] }),
    ];
    const result = runSourceToReview({ source: 'vc', receipts, root });

    if (result.status === 'ok' && result.batch_id) pass('vc: survivor produces an ok run with a batch_id');
    else fail(`vc: expected ok+batch_id, got ${JSON.stringify(result)}`);

    const batch = loadOpenBatch(result.batch_id, { root });
    if (batch && batch.source === 'vc' && batch.jobs.length === 1) pass('vc: batch source label is "vc"');
    else fail(`vc: wrong batch source/shape: ${JSON.stringify(batch)}`);
  }

  // ── Zero survivors -> no empty batch required ───────────────────────────
  {
    const root = scratchRoot();
    const r = receipt({ found: 40, filtered: 40, added: 0, added_urls: [] });
    const result = runSourceToReview({ source: 'linkedin', receipts: [r], root });

    if (result.status === 'ok-empty' && result.batch_id === null && result.review_batch_path === null) {
      pass('zero survivors: successful run, no batch created');
    } else fail(`zero survivors: expected ok-empty/null batch, got ${JSON.stringify(result)}`);
  }

  // ── Only current-run survivors ingested (no sweep of unrelated rows) ────
  {
    const root = scratchRoot();
    seedPipeline(root, ['local:jds/unrelated-prior-run.md', 'local:jds/this-run-only.md']);
    // Seed an UNRELATED job into an already-open batch via a separate
    // createReviewBatchForSource call, mimicking a prior, unrelated run.
    createReviewBatchForSource('strategic', ['local:jds/unrelated-prior-run.md'], { root });

    const r = receipt({ found: 5, filtered: 4, added: 1, added_urls: ['local:jds/this-run-only.md'] });
    const result = runSourceToReview({ source: 'linkedin', receipts: [r], root });
    const batch = loadOpenBatch(result.batch_id, { root });

    const urls = batch.jobs.map((j) => j.url || j.job_key);
    const containsUnrelated = urls.some((u) => String(u).includes('unrelated-prior-run'));
    if (batch.jobs.length === 1 && !containsUnrelated) {
      pass('scoped batch contains only this run\'s survivor, not an unrelated prior batch\'s job');
    } else fail(`scoped batch leaked unrelated rows: ${JSON.stringify(urls)}`);
  }

  // ── No duplicate jobs inside a batch (same URL twice in one receipt) ────
  {
    const root = scratchRoot();
    seedPipeline(root, ['local:jds/dup.md']);
    const r = receipt({ found: 2, filtered: 1, added: 2, added_urls: ['local:jds/dup.md', 'local:jds/dup.md'] });
    const result = runSourceToReview({ source: 'linkedin', receipts: [r], root });
    const batch = loadOpenBatch(result.batch_id, { root });

    if (batch.jobs.length === 1) pass('a URL repeated within one receipt is not double-added to the batch');
    else fail(`expected 1 deduped job, got ${batch.jobs.length}`);
  }

  // ── Rerun/retry does not create duplicate semantic ingestion ────────────
  {
    const root = scratchRoot();
    const urls = ['local:jds/retry-1.md', 'local:jds/retry-2.md'];
    seedPipeline(root, urls);
    const first = runSourceToReview({ source: 'linkedin', receipts: [receipt({ found: 2, filtered: 0, added: 2, added_urls: urls })], root });
    if (first.status === 'ok' && first.batch_id) pass('retry: first run creates a batch');
    else fail(`retry: first run did not create a batch: ${JSON.stringify(first)}`);

    // Exact same receipt again (the "did I already run this" case) — scan.mjs
    // itself would normally report added: 0 on a true rerun, but this proves
    // the batch layer's own dedup holds even if a caller re-submits the same URLs.
    const second = runSourceToReview({ source: 'linkedin', receipts: [receipt({ found: 2, filtered: 0, added: 2, added_urls: urls })], root });
    if (second.status === 'ok-already-batched' && second.batch_id === null) {
      pass('retry: resubmitting the same survivors does not create a second batch');
    } else fail(`retry: expected ok-already-batched/null batch_id, got ${JSON.stringify(second)}`);

    const batchFile = JSON.parse(readFileSync(first.review_batch_path, 'utf-8'));
    if (batchFile.jobs.length === 2) pass('retry: the original batch still holds exactly its 2 jobs, not 4');
    else fail(`retry: original batch job count drifted: ${batchFile.jobs.length}`);
  }

  // ── Batch visible to the existing Review UI loader (loadOpenBatch) ──────
  {
    const root = scratchRoot();
    seedPipeline(root, ['local:jds/ui-visible.md']);
    const r = receipt({ found: 1, filtered: 0, added: 1, added_urls: ['local:jds/ui-visible.md'] });
    const result = runSourceToReview({ source: 'vc', receipts: [r], root });
    const loaded = loadOpenBatch(result.batch_id, { root });
    if (loaded && loaded.batch_id === result.batch_id) {
      pass('batch created by runSourceToReview() is loadable via review.mjs\'s existing loadOpenBatch()');
    } else fail('batch not visible to the existing Review UI loader (loadOpenBatch)');
  }

  // ── Batch-creation failure marks the source run incomplete ──────────────
  {
    const root = scratchRoot();
    // Simulate "found survivor URLs in the receipt that pipeline.md never
    // actually recorded" (e.g. a caller bug, or pipeline.md write raced) —
    // createBatchFromUrls() reports these as notFound, not as a fabricated
    // job, and the source run must not report success.
    const r = receipt({ found: 1, filtered: 0, added: 1, added_urls: ['local:jds/never-in-pipeline.md'] });
    // createReviewBatchForSource pulls from data/pipeline.md's Pending
    // section, which is empty in a fresh scratch root, so this URL cannot be
    // resolved into a job record — exactly the "incomplete" case.
    const result = runSourceToReview({ source: 'linkedin', receipts: [r], root });
    if (result.status === 'incomplete' && result.batch_id === null) {
      pass('survivors that cannot be resolved into batch jobs mark the run incomplete, not success');
    } else fail(`expected incomplete/null batch_id, got ${JSON.stringify(result)}`);
  }

  // ── summarizeReceipts: pure aggregation sanity ───────────────────────────
  {
    const s = summarizeReceipts([
      receipt({ found: 10, filtered: 8, added: 2, added_urls: ['local:jds/x.md', 'local:jds/y.md'] }),
      receipt({ found: 5, filtered: 5, added: 0, added_urls: [] }),
    ]);
    if (s.raw_count === 15 && s.filtered_count === 13 && s.survivor_count === 2 && s.added_urls.length === 2) {
      pass('summarizeReceipts() folds multiple receipts into correct totals');
    } else fail(`summarizeReceipts() totals wrong: ${JSON.stringify(s)}`);
  }
}

try {
  await main();
} catch (err) {
  fail(`source-run.test.mjs crashed: ${err.stack || err.message}`);
}
finish();
