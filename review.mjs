#!/usr/bin/env node
/**
 * review.mjs — SOP review batch lifecycle (sourcing survivor -> UNREVIEWED
 * batch -> proposed decision -> human finalization -> durable state).
 *
 * Extends existing structures rather than a parallel job model: batches are
 * built from data/pipeline.md's Pending section (the existing canonical
 * "sourcing survivor" artifact scan.mjs already writes — see its Pending
 * marker/format in modes/pipeline.md), job identity reuses url-key.mjs /
 * scan.mjs's dedup keys (review-schema.mjs's computeJobKey), and canonical
 * states mirror templates/states.yml's convention of one small closed
 * vocabulary as the source of truth (see review-schema.mjs).
 *
 * Storage (under the Data Root, alongside reports/ and jds/):
 *   review/open/{batch_id}.json       - created, possibly reviewed, not yet finalized
 *   review/finalized/{batch_id}.json  - human-finalized, awaiting ingestion
 *   review/processed/{batch_id}.json  - ingested (idempotency archive)
 *   data/review-state.json            - durable job_key -> decision/execution state
 *
 * SOP execution boundary: this module builds the schema/state/finalization
 * infrastructure and a plain data contract (buildBatch / emitSopForm /
 * validateReviewedOutput). It never calls an LLM API itself — an external
 * review provider (a person, or later an LLM) produces `proposed_decision`s
 * out-of-band and hands them back through applyProposedDecisions(), which
 * validates the shape but never writes final_decision. Only finalizeBatch()
 * may do that, and only a human calls finalizeBatch().
 *
 * Usage:
 *   node review.mjs create [--limit N]                 # batch new pipeline.md survivors
 *   node review.mjs sop <batchId>                       # compact SOP-review text form
 *   node review.mjs apply-decisions <batchId> <file>     # merge proposed decisions (open/)
 *   node review.mjs finalize <batchId> [--overrides f]   # human finalization -> finalized/
 *   node review.mjs ingest                               # idempotent finalized/ -> durable state
 *   node review.mjs status [--job-key K]                 # query durable state
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  SCHEMA_VERSION,
  FIT_DECISIONS,
  buildBatch,
  buildJobRecord,
  validateBatch,
  computeJobKey,
} from './review-schema.mjs';

const DATA_ROOT = getCareerOpsRoot();

export function reviewPaths(root = DATA_ROOT) {
  const base = path.join(root, 'review');
  return {
    base,
    open: path.join(base, 'open'),
    finalized: path.join(base, 'finalized'),
    processed: path.join(base, 'processed'),
    statePath: path.join(root, 'data', 'review-state.json'),
  };
}

function ensureDirs(root) {
  const p = reviewPaths(root);
  for (const dir of [p.open, p.finalized, p.processed, path.dirname(p.statePath)]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function contentHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// ── Pipeline pending parsing (data/pipeline.md's Pending section) ──────────
// Mirrors modes/pipeline.md's documented row grammar: `- [ ] {url} | {company}
// | {title}` plus optional trailing columns (location, compensation) and
// optional labeled segments (posted:, trust:, note:, rank:), order-tolerant.
const LABELED_RE = /^(posted|trust|note|rank):\s*(.*)$/i;

export function parsePipelinePendingEntries(text) {
  const out = [];
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!raw.startsWith('- [ ] ')) continue;
    const cells = raw.slice(6).split('|').map((c) => c.trim());
    const url = cells[0] ?? '';
    if (!url) continue;
    const entry = { url, company: cells[1] ?? '', title: cells[2] ?? '', location: '', compensation: '', postedAt: '' };
    for (const cell of cells.slice(3)) {
      const m = LABELED_RE.exec(cell);
      if (m) {
        const [, label, value] = m;
        if (label.toLowerCase() === 'posted') entry.postedAt = value.trim();
        // trust:/note:/rank: are scanner/ranker annotations, not gate inputs —
        // read past them here but nothing else in this module consumes them.
        continue;
      }
      if (!entry.location) entry.location = cell;
      else if (!entry.compensation) entry.compensation = cell;
    }
    out.push(entry);
  }
  return out;
}

function nextBatchId(root) {
  const p = reviewPaths(root);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existingIds = new Set();
  for (const dir of [p.open, p.finalized, p.processed]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const m = /^(batch-\d{8}-\d{4,})\.json$/.exec(f);
      if (m) existingIds.add(m[1]);
    }
  }
  let seq = 1;
  let id;
  do {
    id = `batch-${day}-${String(seq).padStart(4, '0')}`;
    seq += 1;
  } while (existingIds.has(id));
  return id;
}

/**
 * Build an UNREVIEWED review batch from an explicit array of sourcing
 * survivors (the lower-level, directly testable entry point — no filesystem
 * source assumed).
 */
export function createBatchFromJobs(jobs, { root = DATA_ROOT, source = 'manual', batchId } = {}) {
  const p = ensureDirs(root);
  const id = batchId || nextBatchId(root);
  const { batch, skipped } = buildBatch(jobs, { batchId: id, source });
  const errors = validateBatch(batch, 'open');
  if (errors.length) throw new Error(`createBatchFromJobs: built an invalid batch: ${errors.join('; ')}`);
  const filePath = path.join(p.open, `${id}.json`);
  atomicWriteFile(filePath, JSON.stringify(batch, null, 2) + '\n');
  return { batchId: id, filePath, batch, skipped };
}

/**
 * Build an UNREVIEWED review batch from data/pipeline.md's Pending section —
 * the existing canonical sourcing-survivor artifact. Only entries whose
 * job_key has never been batched before (open, finalized, processed, or
 * already in durable state) are included, so re-running this after a scan
 * only picks up genuinely new survivors.
 */
export function createBatchFromPipelinePending({ root = DATA_ROOT, limit = Infinity, pipelinePath } = {}) {
  const p = ensureDirs(root);
  const pipeline = pipelinePath || path.join(root, 'data', 'pipeline.md');
  if (!existsSync(pipeline)) return { batchId: null, filePath: null, batch: null, skipped: [] };
  const entries = parsePipelinePendingEntries(readFileSync(pipeline, 'utf-8'));

  const seen = new Set();
  const state = readJson(p.statePath, null);
  if (state?.jobs) for (const k of Object.keys(state.jobs)) seen.add(k);
  for (const dir of [p.open, p.finalized, p.processed]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const b = readJson(path.join(dir, f), null);
      for (const j of b?.jobs || []) if (j.job_key) seen.add(j.job_key);
    }
  }

  const fresh = [];
  for (const entry of entries) {
    if (fresh.length >= limit) break;
    const key = computeJobKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(entry);
  }
  if (fresh.length === 0) return { batchId: null, filePath: null, batch: null, skipped: [] };
  return createBatchFromJobs(fresh, { root, source: 'pipeline.md' });
}

/** Load an open batch by id, or null. */
export function loadOpenBatch(batchId, { root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  return readJson(path.join(p.open, `${batchId}.json`), null);
}

/**
 * Compact, SOP-review-friendly text rendering of an open batch: one block
 * per job with the fields a reviewer (human or LLM) needs and the
 * deterministic gate evidence already computed, so a hard-gate rejection
 * (e.g. geography) is visible before any judgment call.
 */
export function emitSopForm(batch) {
  const lines = [`# Review batch ${batch.batch_id} (${batch.jobs.length} job(s))`, ''];
  for (const job of batch.jobs) {
    lines.push(`## ${job.company} — ${job.title}`);
    lines.push(`job_key: ${job.job_key}`);
    lines.push(`url: ${job.url || '(none)'}`);
    lines.push(`location: ${job.location || '(unspecified)'}`);
    lines.push(`posted: ${job.posted_date || '(unknown)'}`);
    lines.push(`compensation: ${job.compensation ?? '(undisclosed)'}`);
    lines.push(`geography_gate: ${job.gates.geography.state} (${job.gates.geography.reason})`);
    if (job.jd.mode === 'inline') {
      lines.push('jd:');
      lines.push(job.jd.text);
    } else if (job.jd.mode === 'reference') {
      lines.push(`jd_ref: ${job.jd.ref}`);
    } else {
      lines.push('jd: (not captured)');
    }
    lines.push('---');
    lines.push(`DECISION FOR ${job.job_key}: {"proposed_decision": "APPLY|INVESTIGATE|PASS", "reason": "...", "reason_codes": []}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Validate an external SOP provider's structured output before it ever
 * touches a batch file. Never mutates durable state itself, and a proposed
 * decision alone can never set final_decision (validateBatch's 'proposed'
 * stage enforces final_decision stays null) — see review-schema.mjs.
 *
 * @param {{decisions: Array<{job_key: string, proposed_decision: string, reason?: string, reason_codes?: string[]}>}} output
 * @returns {string[]} Validation errors; [] means valid.
 */
export function validateReviewedOutput(output) {
  const errors = [];
  if (!output || !Array.isArray(output.decisions)) return ['output.decisions must be an array'];
  const seen = new Set();
  output.decisions.forEach((d, i) => {
    const at = `decisions[${i}]`;
    if (!d.job_key) errors.push(`${at}: missing job_key`);
    else if (seen.has(d.job_key)) errors.push(`${at}: duplicate job_key ${d.job_key}`);
    else seen.add(d.job_key);
    if (!FIT_DECISIONS.includes(d.proposed_decision)) errors.push(`${at}: invalid proposed_decision ${d.proposed_decision}`);
    if (d.proposed_decision === 'INVESTIGATE' && !String(d.reason || '').trim()) {
      errors.push(`${at}: INVESTIGATE requires a concrete unresolved fact in reason`);
    }
  });
  return errors;
}

/**
 * Merge validated proposed decisions into an open batch. The batch stays in
 * open/ — this never finalizes anything and never writes a final_decision.
 */
export function applyProposedDecisions(batchId, output, { root = DATA_ROOT } = {}) {
  const errors = validateReviewedOutput(output);
  if (errors.length) throw new Error(`applyProposedDecisions: invalid SOP output: ${errors.join('; ')}`);
  const p = reviewPaths(root);
  const filePath = path.join(p.open, `${batchId}.json`);
  const batch = readJson(filePath, null);
  if (!batch) throw new Error(`applyProposedDecisions: no open batch ${batchId}`);
  const byKey = new Map(output.decisions.map((d) => [d.job_key, d]));
  for (const job of batch.jobs) {
    const d = byKey.get(job.job_key);
    if (!d) continue;
    job.review.status = 'REVIEWED';
    job.review.proposed_decision = d.proposed_decision;
    job.review.reason = d.reason || '';
    job.review.reason_codes = Array.isArray(d.reason_codes) ? d.reason_codes : [];
    job.review.reviewed_at = new Date().toISOString();
  }
  const postErrors = validateBatch(batch, 'proposed');
  if (postErrors.length) throw new Error(`applyProposedDecisions: resulting batch invalid: ${postErrors.join('; ')}`);
  atomicWriteFile(filePath, JSON.stringify(batch, null, 2) + '\n');
  return batch;
}

/**
 * Human finalization: for each job, final_decision = an explicit override
 * (keyed by job_key) if given, else the reviewed proposed_decision. A job
 * with neither is left un-finalizable — the whole batch refuses to finalize
 * rather than silently defaulting an unreviewed job to a decision nobody
 * made (see AGENTS.md's no-fabrication posture applied to decisions, not
 * just content). The model's recommendation alone never becomes durable
 * state: this function is the ONLY place final_decision is ever set, and a
 * human is the only caller of it.
 *
 * @param {string} batchId
 * @param {{overrides?: Record<string,string>, reviewer?: string, root?: string}} [opts]
 */
export function finalizeBatch(batchId, { overrides = {}, reviewer = null, root = DATA_ROOT } = {}) {
  const p = ensureDirs(root);
  const openPath = path.join(p.open, `${batchId}.json`);
  const batch = readJson(openPath, null);
  if (!batch) throw new Error(`finalizeBatch: no open batch ${batchId}`);

  const missing = [];
  const now = new Date().toISOString();
  for (const job of batch.jobs) {
    const decision = overrides[job.job_key] ?? job.review.proposed_decision;
    if (!FIT_DECISIONS.includes(decision)) { missing.push(job.job_key); continue; }
    job.review.final_decision = decision;
    job.review.status = 'REVIEWED';
    job.review.finalized = true;
    job.review.finalized_at = now;
    if (overrides[job.job_key] && overrides[job.job_key] !== job.review.proposed_decision) {
      job.review.reason = `${job.review.reason ? job.review.reason + ' ' : ''}[human override: was ${job.review.proposed_decision ?? 'none'}]`.trim();
    }
    job.review.reviewer = reviewer;
  }
  if (missing.length) {
    throw new Error(`finalizeBatch: ${missing.length} job(s) have no proposed_decision and no override: ${missing.join(', ')}`);
  }
  batch.status = 'finalized';
  const errors = validateBatch(batch, 'finalized');
  if (errors.length) throw new Error(`finalizeBatch: resulting batch invalid: ${errors.join('; ')}`);

  const finalizedPath = path.join(p.finalized, `${batchId}.json`);
  atomicWriteFile(finalizedPath, JSON.stringify(batch, null, 2) + '\n');
  try { unlinkSync(openPath); } catch { /* best-effort; finalized/ copy is authoritative */ }
  return batch;
}

function defaultState() {
  return { schema_version: SCHEMA_VERSION, updated_at: null, ingested_batches: {}, jobs: {} };
}

/** Read-only lookup into the durable review-state store. */
export function getJobState(jobKey, { root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  return state.jobs[jobKey] || null;
}

export function isSuppressed(jobKey, { root = DATA_ROOT } = {}) {
  return getJobState(jobKey, { root })?.fit_decision === 'PASS';
}

/**
 * Idempotent ingestion of every finalized/ batch not yet reflected in the
 * durable state store. Tracked by batch_id AND a content hash (so a
 * finalized file that changed after being ingested once is re-ingested, but
 * an identical re-run — or a re-run after a move failed halfway — is a
 * no-op for state and just retries the move). This is the ONLY function
 * that mutates data/review-state.json, and it is safe to call on every
 * session start (see doctor.mjs's onboardingState()) or by hand
 * (`node review.mjs ingest`, the admin/debug path).
 *
 * @returns {Promise<{ingested: string[], skipped: string[], errors: Array<{batchId: string, errors: string[]}>}>}
 */
export async function ingestFinalizedReviewBatches({ root = DATA_ROOT } = {}) {
  const p = ensureDirs(root);
  if (!existsSync(p.finalized)) return { ingested: [], skipped: [], errors: [] };
  const files = readdirSync(p.finalized).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return { ingested: [], skipped: [], errors: [] };

  const ingested = [];
  const skipped = [];
  const validationErrors = [];

  for (const file of files) {
    const finalizedPath = path.join(p.finalized, file);
    const batch = readJson(finalizedPath, null);
    if (!batch) { validationErrors.push({ batchId: file, errors: ['unreadable/invalid JSON'] }); continue; }
    const batchId = batch.batch_id || file.replace(/\.json$/, '');
    const hash = contentHash(batch);

    // withPipelineLock guards the whole read-modify-write of the state file,
    // so two concurrent ingestion callers (e.g. doctor.mjs running in two
    // sessions at once) cannot both apply the same batch.
    const outcome = await withPipelineLock(p.statePath, async () => {
      const state = readJson(p.statePath, defaultState());
      const already = state.ingested_batches[batchId];
      if (already === hash) return 'already-ingested';

      const errors = validateBatch(batch, 'finalized');
      if (errors.length) return { invalid: errors };

      for (const job of batch.jobs) {
        const decision = job.review.final_decision;
        state.jobs[job.job_key] = {
          fit_decision: decision,
          execution_status: decision === 'APPLY' ? 'READY_TO_APPLY' : 'NONE',
          reason: job.review.reason || '',
          company: job.company,
          title: job.title,
          url: job.url,
          batch_id: batchId,
          decided_at: job.review.finalized_at,
        };
      }
      state.ingested_batches[batchId] = hash;
      state.updated_at = new Date().toISOString();
      atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
      return 'ingested';
    });

    if (outcome && typeof outcome === 'object' && outcome.invalid) {
      validationErrors.push({ batchId, errors: outcome.invalid });
      continue; // leave the invalid file in finalized/ for a human to fix
    }

    // Move (or, on a retried already-ingested batch, clean up) regardless of
    // whether this call did the ingesting — a previous run may have applied
    // state but died before the move.
    const processedPath = path.join(p.processed, file);
    try {
      if (existsSync(processedPath)) unlinkSync(finalizedPath);
      else renameSync(finalizedPath, processedPath);
    } catch { /* best-effort; next ingest run retries the move */ }

    if (outcome === 'ingested') ingested.push(batchId);
    else skipped.push(batchId);
  }
  return { ingested, skipped, errors: validationErrors };
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'create') {
    const limit = Number(flagValue(argv, '--limit')) || Infinity;
    const result = createBatchFromPipelinePending({ limit });
    if (!result.batchId) {
      console.log('No new survivors to batch (pipeline.md Pending is empty or all already batched).');
      return;
    }
    console.log(`Created ${result.batchId} with ${result.batch.jobs.length} job(s) -> ${result.filePath}`);
    if (result.skipped.length) console.log(`Skipped ${result.skipped.length} entr(y/ies) with no derivable job_key.`);
    return;
  }

  if (cmd === 'sop') {
    const batchId = argv[1];
    const batch = loadOpenBatch(batchId);
    if (!batch) { console.error(`No open batch ${batchId}`); process.exitCode = 1; return; }
    console.log(emitSopForm(batch));
    return;
  }

  if (cmd === 'apply-decisions') {
    const [, batchId, file] = argv;
    const output = readJson(file, null);
    if (!output) { console.error(`Could not read ${file}`); process.exitCode = 1; return; }
    applyProposedDecisions(batchId, output);
    console.log(`Applied proposed decisions to ${batchId} (still open — run finalize when ready).`);
    return;
  }

  if (cmd === 'finalize') {
    const batchId = argv[1];
    const overridesFile = flagValue(argv, '--overrides');
    const overrides = overridesFile ? readJson(overridesFile, {}) : {};
    const reviewer = flagValue(argv, '--reviewer') || null;
    const batch = finalizeBatch(batchId, { overrides, reviewer });
    console.log(`Finalized ${batchId}: ${batch.jobs.map((j) => `${j.job_key}=${j.review.final_decision}`).join(', ')}`);
    return;
  }

  if (cmd === 'ingest') {
    const result = await ingestFinalizedReviewBatches();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'status') {
    const jobKey = flagValue(argv, '--job-key');
    if (jobKey) {
      console.log(JSON.stringify(getJobState(jobKey), null, 2));
      return;
    }
    const p = reviewPaths(DATA_ROOT);
    const state = readJson(p.statePath, defaultState());
    console.log(JSON.stringify({ jobCount: Object.keys(state.jobs).length, ingestedBatches: Object.keys(state.ingested_batches).length }, null, 2));
    return;
  }

  console.log(`Usage:
  node review.mjs create [--limit N]
  node review.mjs sop <batchId>
  node review.mjs apply-decisions <batchId> <decisionsFile.json>
  node review.mjs finalize <batchId> [--overrides overrides.json] [--reviewer name]
  node review.mjs ingest
  node review.mjs status [--job-key K]`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`review.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
