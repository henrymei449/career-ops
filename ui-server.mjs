#!/usr/bin/env node
/**
 * ui-server.mjs — minimal local operator UI for the CareerOps workflow
 * locked in docs/careerops-state-model.md.
 *
 * The CLI (review.mjs / outreach.mjs) is the test/admin surface; this is the
 * smallest usable page a human can run the same proven workflow from without
 * typing job keys, JSON, or CLI commands. It is a thin HTTP adapter only —
 * every transition below calls the EXACT function the CLI calls
 * (finalizeBatch, markApplied, passOnApplication, setOutreachDecision,
 * startOutreach, discoverContacts, selectContacts). No transition rule, validation, or
 * state write is duplicated here; this file only reads state to render it
 * and forwards button clicks to those functions.
 *
 * No new system of record: every GET re-reads data/review-state.json (and
 * review/open/*.json) fresh, and the browser holds nothing durable — a
 * reload always reflects the actual file on disk.
 *
 * Usage: node ui-server.mjs [--port 5173]
 */

import { createServer } from 'http';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  reviewPaths,
  readJson,
  defaultState,
  finalizeAndIngestBatch,
} from './review.mjs';
import {
  markApplied,
  passOnApplication,
  setOutreachDecision,
  startOutreach,
  discoverContacts,
  selectContacts,
  listOutreach,
  resolveSearchProvider,
} from './outreach.mjs';
import { intakeJob } from './adhoc-intake.mjs';

const DATA_ROOT = getCareerOpsRoot();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'ui');

// ── Read helpers (pure reads over existing storage — no new state) ─────────

/** Every open batch file, parsed, newest (by created_at) first. */
export function readOpenBatches(root = DATA_ROOT) {
  const p = reviewPaths(root);
  if (!existsSync(p.open)) return [];
  const files = readdirSync(p.open).filter((f) => f.endsWith('.json'));
  const batches = [];
  for (const file of files) {
    const batch = readJson(path.join(p.open, file), null);
    if (batch) batches.push(batch);
  }
  batches.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return batches;
}

/**
 * One row per open batch — id, created_at, job count, source/provenance —
 * for the UI's batch selector. `source` is whatever createBatchFromJobs()
 * was called with ('cohort', 'pipeline.md', 'manual', ...); never invented
 * here, never defaulted to a human-friendly label the batch itself doesn't
 * carry.
 */
export function listOpenBatchSummaries(root = DATA_ROOT) {
  return readOpenBatches(root).map((batch) => ({
    batch_id: batch.batch_id,
    created_at: batch.created_at,
    count: batch.jobs.length,
    source: batch.source || '',
  }));
}

/**
 * Jobs for ONE open batch — the batch-aware replacement for the old
 * all-batches-flattened read. `batchId` omitted (or not found) defaults to
 * the newest open batch (readOpenBatches() is already newest-first), so a
 * freshly created cohort batch is what the UI opens to by default. Returns
 * null when there are no open batches at all.
 */
export function listReviewJobsForBatch(batchId, root = DATA_ROOT) {
  const batches = readOpenBatches(root);
  if (batches.length === 0) return null;
  const batch = batchId ? batches.find((b) => b.batch_id === batchId) : batches[0];
  if (!batch) return null;
  return {
    batch_id: batch.batch_id,
    jobs: batch.jobs.map((job) => ({
      batch_id: batch.batch_id,
      job_key: job.job_key,
      company: job.company,
      title: job.title,
      location: job.location || '',
      url: job.url || '',
      proposed_decision: job.review.proposed_decision,
      reason: job.review.reason || '',
      final_decision: job.review.final_decision,
    })),
  };
}

/** Durable jobs with fit_decision=APPLY, execution_status=READY_TO_APPLY. */
function listReadyToApply() {
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());
  return Object.entries(state.jobs)
    .filter(([, job]) => job.fit_decision === 'APPLY' && job.execution_status === 'READY_TO_APPLY')
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      url: job.url || '',
    }));
}

/** Every APPLIED job with its full outreach record (candidates included). */
function listOutreachDetailed() {
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());
  return Object.entries(state.jobs)
    .filter(([, job]) => job.outreach)
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      decision: job.outreach.decision,
      status: job.outreach.status,
      candidates: job.outreach.candidates || [],
      selected_contacts: job.outreach.selected_contacts || [],
    }));
}

// ── Applications ("What Is Alive?" board, Pass 2) ───────────────────────────
//
// A job belongs here once it represents a real submitted application:
// execution_status === 'APPLIED' (set only by markApplied(), never by this
// file). This is a READ-ONLY view over durable state — no field written here.
//
// application_status/stage/last_update come from application-schema.mjs's
// axis (Pass 1 migration). A job that reached APPLIED through the live
// CareerOps workflow rather than the historical-sheet migration has none of
// those fields (migrate-historical-applications.mjs deliberately left the
// live-workflow jobs — e.g. IFS, Samsara, Datch — untouched). That is not a
// "never infer state from absence" violation: nothing has closed, rejected,
// or withdrawn that application through any known transition, so ACTIVE is
// the only status consistent with everything actually recorded about it,
// not a guess layered on top of a missing field.
export const APPLICATION_ALIVE_STATUSES = ['ACTIVE', 'STALE'];
export const APPLICATION_CLOSED_STATUSES = ['REJECTED', 'CLOSED', 'WITHDRAWN'];

function effectiveApplicationStatus(job) {
  return job.application_status || 'ACTIVE';
}

function humanizeOutreachStatus(status) {
  if (!status) return '';
  return status.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function outreachDisplay(job) {
  if (job.outreach && job.outreach.status) return humanizeOutreachStatus(job.outreach.status);
  if (job.legacy_sheet && job.legacy_sheet.outreach_status_raw) return job.legacy_sheet.outreach_status_raw;
  return '';
}

/** Comparable sort key: application_last_update (date) if present, else applied_at (timestamp), end-of-day normalized so date-only values compare correctly against full timestamps. */
function applicationSortKey(job) {
  if (job.application_last_update) return `${job.application_last_update}T23:59:59.999Z`;
  return job.applied_at || '';
}

/**
 * Applications view, filtered and sorted. `filter` is 'alive' | 'closed' | 'all'
 * (default 'alive'). Sort: most recent activity first (applicationSortKey
 * DESC), job_key ASC as a deterministic tie-breaker.
 */
export function listApplications(filter = 'alive', root = DATA_ROOT) {
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  const applied = Object.entries(state.jobs).filter(([, job]) => job.execution_status === 'APPLIED');

  const rows = applied.map(([jobKey, job]) => {
    const status = effectiveApplicationStatus(job);
    return {
      job_key: jobKey,
      company: job.company,
      title: job.title,
      url: job.url || '',
      applied_at: job.applied_at || null,
      application_status: status,
      application_stage: job.application_stage || 'Applied',
      application_last_update: job.application_last_update || null,
      outreach: outreachDisplay(job),
      _sortKey: applicationSortKey(job),
    };
  });

  const filtered = rows.filter((r) => {
    if (filter === 'closed') return APPLICATION_CLOSED_STATUSES.includes(r.application_status);
    if (filter === 'all') return true;
    return APPLICATION_ALIVE_STATUSES.includes(r.application_status); // 'alive' (default)
  });

  filtered.sort((a, b) => {
    const cmp = String(b._sortKey).localeCompare(String(a._sortKey));
    return cmp !== 0 ? cmp : a.job_key.localeCompare(b.job_key);
  });

  return filtered.map(({ _sortKey, ...row }) => row);
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(filePath);
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(body);
}

const API_ROUTES = [
  ['GET', '/api/review/batches', async () => ({ batches: listOpenBatchSummaries() })],
  ['GET', '/api/review', async (body, query) => {
    const result = listReviewJobsForBatch(query.get('batch_id'));
    return result || { batch_id: null, jobs: [] };
  }],
  ['POST', '/api/review/finalize', async (body) => {
    const { batch_id: batchId, overrides = {}, reviewer } = body;
    if (!batchId) throw new Error('batch_id required');
    const { batch, ingestion } = await finalizeAndIngestBatch(batchId, { overrides, reviewer: reviewer || null, root: DATA_ROOT });
    return {
      batch_id: batch.batch_id,
      status: batch.status,
      ingested: ingestion.ingested.includes(batchId),
      ingestion_errors: ingestion.errors,
    };
  }],
  ['GET', '/api/ready', async () => ({ jobs: listReadyToApply() })],
  ['POST', '/api/ready/applied', async (body) => {
    const { job_key: jobKey, reviewer } = body;
    if (!jobKey) throw new Error('job_key required');
    const { alreadyApplied, job } = await markApplied(jobKey, { reviewer: reviewer || null, root: DATA_ROOT });
    return { alreadyApplied, execution_status: job.execution_status, applied_at: job.applied_at };
  }],
  ['POST', '/api/ready/pass', async (body) => {
    const { job_key: jobKey } = body;
    if (!jobKey) throw new Error('job_key required');
    const { alreadyPassed, job } = await passOnApplication(jobKey, { root: DATA_ROOT });
    return { alreadyPassed, execution_status: job.execution_status, closed_at: job.closed_at, closed_reason: job.closed_reason };
  }],
  ['GET', '/api/applications', async (body, query) => ({ applications: listApplications(query.get('filter') || 'alive') })],
  ['GET', '/api/outreach', async () => ({ jobs: listOutreachDetailed() })],
  ['POST', '/api/outreach/decision', async (body) => {
    const { job_key: jobKey, decision } = body;
    if (!jobKey || !decision) throw new Error('job_key and decision required');
    const outreach = await setOutreachDecision(jobKey, decision, { root: DATA_ROOT });
    return { decision: outreach.decision, status: outreach.status };
  }],
  ['POST', '/api/outreach/start', async (body) => {
    const { job_key: jobKey } = body;
    if (!jobKey) throw new Error('job_key required');
    const { alreadyStarted, outreach } = await startOutreach(jobKey, { root: DATA_ROOT });
    return { alreadyStarted, status: outreach.status };
  }],
  ['POST', '/api/outreach/discover', async (body) => {
    const { job_key: jobKey } = body;
    if (!jobKey) throw new Error('job_key required');
    const searchProvider = await resolveSearchProvider();
    const { candidates } = await discoverContacts(jobKey, { searchProvider, root: DATA_ROOT });
    return { candidates };
  }],
  ['POST', '/api/outreach/select', async (body) => {
    const { job_key: jobKey, candidate_ids: candidateIds } = body;
    if (!jobKey || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      throw new Error('job_key and a non-empty candidate_ids array are required');
    }
    const outreach = await selectContacts(jobKey, candidateIds, { root: DATA_ROOT });
    return { status: outreach.status, selected_contacts: outreach.selected_contacts };
  }],
  // Follow-up workflow is not implemented (docs/careerops-state-model.md) —
  // this queue is read-only/empty by design, never a source of invented state.
  ['GET', '/api/followup', async () => ({ jobs: [] })],
  // Ad-hoc job intake (#pass3): paste-a-URL entry point into the SAME
  // review-batch pipeline every sourced job goes through. All capture/
  // dedupe/batch logic lives in adhoc-intake.mjs — this route only forwards
  // the URL and shapes the response, same thin-adapter pattern as every
  // other route above.
  ['POST', '/api/intake', async (body) => {
    const { url } = body;
    if (!url) throw new Error('url required');
    return intakeJob(url, { root: DATA_ROOT });
  }],
];

function matchRoute(method, urlPath) {
  return API_ROUTES.find(([m, p]) => m === method && p === urlPath);
}

async function handleApi(req, res, urlPath, query) {
  const route = matchRoute(req.method, urlPath);
  if (!route) { sendJson(res, 404, { error: `no route ${req.method} ${urlPath}` }); return; }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await route[2](body, query);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

function main() {
  const port = Number(flagValue(process.argv.slice(2), '--port')) || 5173;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { handleApi(req, res, url.pathname, url.searchParams); return; }
    serveStatic(req, res, url.pathname);
  });
  server.listen(port, () => {
    console.log(`CareerOps operator UI: http://localhost:${port}  (data root: ${DATA_ROOT})`);
  });
}

if (isMainModule(import.meta.url)) main();
