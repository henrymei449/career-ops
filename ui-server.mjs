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
  INVESTIGATE_QUEUE_ID,
  listInvestigateQueue,
  decideInvestigateJob,
  passJobFromBatch,
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
  listFollowUpActions,
  completeFollowUpAction,
  skipFollowUpAction,
  updateApplicationStatus,
  updateFollowUpAction,
  updateApplicationStage,
  updateJobOperatingMetadata,
} from './outreach.mjs';
import { intakeJob } from './adhoc-intake.mjs';
import { importLinkedInPaste, setManualJobUrl } from './linkedin-paste-intake.mjs';
import { qualifyLinkedInReceipt, invokeClaudeTriage } from './linkedin-qualification.mjs';
import { resolveResumeGateSop, gateCardView, startBatchGateRun, getBatchGateRun } from './resume-gate.mjs';
import { APPLICATION_ALIVE_STATUSES, APPLICATION_CLOSED_STATUSES } from './application-schema.mjs';
import { deriveOutreachCompletion, buildHomeRows, isOutreachNeeded } from './followup-schema.mjs';

const DATA_ROOT = getCareerOpsRoot();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'ui');

// qualifyLinkedInReceipt defaults to invokeCodexTriage when no `invoke` is
// supplied. The Operator UI's manual-paste evaluator has always been the
// CareerOps Claude triage contract (matching the standalone/batch
// qualification path), never Codex, so the route must resolve it explicitly
// rather than rely on that default. Exported so a test can assert the wiring
// without spawning a real CLI process.
export function resolveLinkedInPasteEvaluator() {
  return invokeClaudeTriage;
}

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
  // Live SOP version, only so a stored gate result can be flagged stale when
  // the SOP has moved on; an unreadable SOP just means "no stale flag".
  let sop = null;
  try { sop = resolveResumeGateSop({ root }); } catch { /* stale flag unavailable */ }
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
      compensation: job.compensation ?? null,
      posted_date: job.posted_date || '',
      intake: job.intake || null,
      // Deterministic geography decision computeGateEvidence already stored
      // at batch-build time (review-schema.mjs) — surfaced so a reviewer
      // sees the JD-informed verdict, not just the raw listing location.
      gates: job.gates || null,
      resume_gate: gateCardView(job, { root, sop }),
    })),
  };
}

/**
 * The Investigate / Queue as ONE more entry in the batch selector — a virtual
 * view over durable state (see review.mjs's listInvestigateQueue), not a batch
 * file. Omitted when empty so the selector's default (newest open batch) and
 * every existing batch summary are unchanged.
 */
export function investigateQueueSummary(root = DATA_ROOT) {
  const count = listInvestigateQueue({ root }).length;
  return count ? { batch_id: INVESTIGATE_QUEUE_ID, label: `Investigate / Queue — ${count} job${count === 1 ? '' : 's'}`, count, source: 'durable', virtual: true } : null;
}

/** Review-card projection of the queue: same shape as a batch job card, from durable state. */
export function listInvestigateQueueJobs(root = DATA_ROOT) {
  let sop = null;
  try { sop = resolveResumeGateSop({ root }); } catch { /* stale flag unavailable */ }
  return {
    batch_id: INVESTIGATE_QUEUE_ID,
    virtual: true,
    jobs: listInvestigateQueue({ root }).map(({ job_key, durable, original }) => ({
      batch_id: INVESTIGATE_QUEUE_ID,
      job_key,
      company: durable.company || original?.company || '',
      title: durable.title || original?.title || '',
      location: original?.location || '',
      url: durable.url || original?.url || '',
      proposed_decision: null,
      reason: durable.reason || '',
      final_decision: 'INVESTIGATE',
      decided_at: durable.decided_at || null,
      gates: original?.gates || null,
      resume_gate: original ? gateCardView(original, { root, sop }) : null,
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

/**
 * Every APPLIED job with its full outreach record (candidates included).
 *
 * `activeOnly` (default true) is the Outreach P0 cleanup default queue: an
 * active execution queue, not a history dump. A record is suppressed when
 * its application has closed (REJECTED/CLOSED/WITHDRAWN — same
 * APPLICATION_ALIVE_STATUSES partition every other view uses) or its
 * outreach has already reached COMPLETE (covers both a genuinely finished
 * REQUIRED/OPTIONAL thread and a WAIVED decision, whose initial status is
 * COMPLETE per outreach-schema.mjs). No history is deleted — this is a read
 * filter only, same durable record either way.
 */
/**
 * READY_TO_APPLY jobs shaped as Home rows (one-shot Home extension): a job
 * whose review is finalized APPLY but not yet submitted. Deliberately built
 * as a SEPARATE list from buildHomeRows()/listFollowUpActions() rather than
 * folded into that function — home-application-coverage.test.mjs locks in
 * "non-APPLIED jobs (READY_TO_APPLY, NONE, NOT_APPLYING) never appear on
 * Home" for that read path, so a READY_TO_APPLY row is a distinct kind the
 * client merges in for the READY TO APPLY / ALL ACTIVE filters, never a
 * disguised APPLIED row (no applied_at, no bucket/status the follow-up
 * vocabulary defines — `home_kind: 'READY_TO_APPLY'` is how the client tells
 * the two apart).
 */
function readyRowsForHome() {
  return listReadyToApply().map((job) => ({
    job_key: job.job_key,
    company: job.company,
    role: job.title,
    url: job.url,
    applied_at: null,
    application_stage: null,
    application_status: null,
    priority: null,
    last_touch: null,
    waiting_on: null,
    notes: null,
    next_action: null,
    due_at: null,
    bucket: null,
    outreach_decision: null,
    outreach_status: null,
    outreach_needed: false,
    action_id: null,
    contact_id: null,
    extra_count: 0,
    actions: [],
    status: 'READY TO APPLY',
    home_kind: 'READY_TO_APPLY',
  }));
}

function listOutreachDetailed({ activeOnly = true } = {}) {
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());
  return Object.entries(state.jobs)
    .filter(([, job]) => job.outreach)
    .filter(([, job]) => {
      if (!activeOnly) return true;
      if (!APPLICATION_ALIVE_STATUSES.includes(effectiveApplicationStatus(job))) return false;
      return job.outreach.status !== 'COMPLETE';
    })
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      decision: job.outreach.decision,
      status: job.outreach.status,
      // Derived job-level completion (Pass 5) — see deriveOutreachCompletion.
      completion: deriveOutreachCompletion(job.outreach),
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
// Re-exported for backward compatibility with anything importing these two
// constants from ui-server.mjs — application-schema.mjs is now their one
// canonical definition (shared with followup-schema.mjs's closure
// suppression, so the two views can never disagree about "closed").
export { APPLICATION_ALIVE_STATUSES, APPLICATION_CLOSED_STATUSES };

function effectiveApplicationStatus(job) {
  return job.application_status || 'ACTIVE';
}

function humanizeOutreachStatus(status) {
  if (!status) return '';
  return status.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Job-level outreach completion patch (Pass 5): render the DERIVED
// completion (deriveOutreachCompletion — COMPLETE/IN_PROGRESS once contacts
// are selected) rather than the raw, never-advancing CONTACTS_SELECTED
// status, so "contacts chosen" and "contact work actually finished" read
// differently on the Applications board. Legacy-sheet text (a historical
// import's own free-text outreach status) is untouched — that is imported
// evidence, not a CareerOps-native status to re-derive.
function outreachDisplay(job) {
  if (job.outreach && job.outreach.status) return humanizeOutreachStatus(deriveOutreachCompletion(job.outreach));
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
  ['GET', '/api/review/batches', async () => {
    const queue = investigateQueueSummary();
    return { batches: [...listOpenBatchSummaries(), ...(queue ? [queue] : [])] };
  }],
  ['GET', '/api/review', async (body, query) => {
    if (query.get('batch_id') === INVESTIGATE_QUEUE_ID) return listInvestigateQueueJobs();
    const result = listReviewJobsForBatch(query.get('batch_id'));
    return result || { batch_id: null, jobs: [] };
  }],
  // PASS is an immediate per-job disposition: durable PASS now, job leaves the open batch now.
  ['POST', '/api/review/pass', async (body) => {
    const { batch_id: batchId, job_key: jobKey } = body;
    if (!batchId || !jobKey) throw new Error('batch_id and job_key required');
    return passJobFromBatch(batchId, jobKey, { root: DATA_ROOT });
  }],
  // Re-decide one Investigate / Queue job in place (durable state only).
  ['POST', '/api/review/investigate/decide', async (body) => {
    const { job_key: jobKey, decision } = body;
    if (!jobKey || !decision) throw new Error('job_key and decision required');
    const { unchanged, job } = await decideInvestigateJob(jobKey, decision, { root: DATA_ROOT });
    return { job_key: jobKey, unchanged, fit_decision: job.fit_decision, execution_status: job.execution_status };
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
  // Resume Gate enrichment for the SELECTED batch only. Starts a background
  // run and returns at once (a batch takes minutes); the UI polls the status
  // route and re-reads /api/review, since each job's result is persisted as
  // it completes. Never touches review decisions — see resume-gate.mjs.
  ['POST', '/api/review/resume-gate', async (body) => {
    const { batch_id: batchId, force = false } = body;
    if (!batchId) throw new Error('batch_id required');
    return startBatchGateRun(batchId, { root: DATA_ROOT, force: !!force });
  }],
  ['GET', '/api/review/resume-gate/status', async (body, query) => {
    const batchId = query.get('batch_id');
    if (!batchId) throw new Error('batch_id required');
    return getBatchGateRun(batchId);
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
  // Applications -> Update Status (Pass 5): a small, human-confirmed
  // lifecycle mutation on the EXACT job_key the operator opened — no role
  // substitution, no requisition merging. See updateApplicationStatus() in
  // outreach.mjs and application-schema.mjs's mapUiApplicationStatus() for
  // the canonical field mapping and idempotency rules.
  ['POST', '/api/applications/status', async (body) => {
    const { job_key: jobKey, status, update_date: updateDate, note } = body;
    if (!jobKey || !status) throw new Error('job_key and status required');
    const job = await updateApplicationStatus(jobKey, status, {
      updateDate: updateDate || null,
      note: note || null,
      root: DATA_ROOT,
    });
    return {
      job_key: jobKey,
      application_status: job.application_status,
      application_outcome: job.application_outcome,
      application_stage: job.application_stage,
      application_last_update: job.application_last_update,
    };
  }],
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
  // Follow-up (Pass 4): derived queue over outreach.selected_contacts — no
  // second source of truth. See followup-schema.mjs for the bucket rule and
  // outreach.mjs for the read/mutation layer. `home_rows` (Pass 5 job-level
  // patch) is the same `actions` list re-grouped one row per job_key —
  // Home's required unit of work — via followup-schema.mjs's buildHomeRows;
  // `actions` itself is kept as-is so Mark Done/Skip keep resolving against
  // real per-contact action_ids.
  ['GET', '/api/followup', async () => {
    const actions = listFollowUpActions();
    const homeRows = buildHomeRows(actions).map((row) => ({
      ...row,
      outreach_needed: isOutreachNeeded(row.outreach_decision, row.outreach_status),
    }));
    return { actions, home_rows: homeRows, ready_rows: readyRowsForHome() };
  }],
  ['POST', '/api/followup/complete', async (body) => {
    const { action_id: actionId } = body;
    if (!actionId) throw new Error('action_id required');
    const { job_key: jobKey, contact } = await completeFollowUpAction(actionId, { root: DATA_ROOT });
    return { job_key: jobKey, contact };
  }],
  ['POST', '/api/followup/skip', async (body) => {
    const { action_id: actionId } = body;
    if (!actionId) throw new Error('action_id required');
    const { job_key: jobKey, contact } = await skipFollowUpAction(actionId, { root: DATA_ROOT });
    return { job_key: jobKey, contact };
  }],
  // Home inline editing (Pass 6): edit a row's primary Next Action/Follow-up
  // in place, without a detour through the Outreach tab. `action_id` is the
  // SAME id Mark Done/Skip already use — it names exactly one contact via
  // outreach.mjs's one-way hash lookup, so this can never touch a job's other
  // (folded) contacts. `next_action: null` clears the due date too (see
  // updateFollowUpAction's own doc comment for why).
  ['POST', '/api/home/action/update', async (body) => {
    const { action_id: actionId, next_action: nextAction = null, next_action_due: nextActionDue = null } = body;
    if (!actionId) throw new Error('action_id required');
    const { job_key: jobKey, contact } = await updateFollowUpAction(actionId, { nextAction, nextActionDue }, { root: DATA_ROOT });
    return { job_key: jobKey, contact };
  }],
  // Home inline editing (Pass 6): edit a job's hiring-process stage. A
  // narrower sibling of /api/applications/status — never touches
  // application_status/outcome, only application_stage.
  ['POST', '/api/home/stage/update', async (body) => {
    const { job_key: jobKey, stage } = body;
    if (!jobKey) throw new Error('job_key required');
    if (!stage) throw new Error('stage required');
    return updateApplicationStage(jobKey, stage, { root: DATA_ROOT });
  }],
  // Home operating-metadata MVP: job-level Priority/Last Touch/Next Action/
  // Waiting On/Follow-Up Due/Notes — see updateJobOperatingMetadata's own
  // doc comment (outreach.mjs) for the patch semantics. Every key besides
  // job_key is forwarded as-is; unknown-field/invalid-value rejection lives
  // there, not in this thin route.
  ['POST', '/api/home/operating/update', async (body) => {
    const { job_key: jobKey, ...patch } = body;
    if (!jobKey) throw new Error('job_key required');
    return updateJobOperatingMetadata(jobKey, patch, { root: DATA_ROOT });
  }],
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
  // Manual LinkedIn results paste: parse -> the same dedupe/history/
  // suppression/geography contracts -> ONE normal open Review batch. All
  // logic lives in linkedin-paste-intake.mjs; this route only forwards.
  ['POST', '/api/review/linkedin-paste', async (body) => {
    const { text, search_query: searchQuery, captured_at: capturedAt, html_links: htmlLinks, resolve_online: resolveOnline } = body;
    if (!String(text || '').trim()) throw new Error('paste text required');
    // Paste is upstream discovery, never direct Review admission. The dry-run
    // receipt preserves all source rows and the existing cheap-gate result;
    // qualification then resolves identity/JD, runs CareerOps triage, queues
    // uncertainty, and creates Review only from qualified survivors.
    const discovery = await importLinkedInPaste(
      { text, search_query: searchQuery, captured_at: capturedAt, html_links: Array.isArray(htmlLinks) ? htmlLinks : [] },
      { root: DATA_ROOT, dryRun: true, resolveOnline: false },
    );
    // allowShadowTitleRules activates ONLY the validated, evidence-gated
    // manufacturing title corrections from linkedin-title-shadow.mjs, as a
    // fallback consulted after the production title_filter has already
    // rejected on a hydrated JD — never scan.mjs/nightly discovery, which
    // this option does not touch, and never portals.yml.
    const qualified = await qualifyLinkedInReceipt(discovery, { root: DATA_ROOT, titlePolicy: process.env.CAREER_OPS_LINKEDIN_TITLE_POLICY || 'existing', invoke: resolveLinkedInPasteEvaluator(), allowShadowTitleRules: true });
    const items = qualified.rows.map((row) => ({
      company: row.company,
      title: row.title,
      location: row.location,
      outcome: row.status === 'QUALIFIED' ? 'added' : (row.status === 'RETRY' ? 'retry' : 'excluded'),
      reason: row.status === 'QUALIFIED' ? 'careerops_qualified' : (row.first_rule?.gate || row.initial_reason || 'rejected'),
      detail: row.triage?.reason || row.retry?.reason || row.first_rule?.evidence?.reason || '',
      url: row.url || '',
      audit_classification: row.audit_classification,
    }));
    return {
      receipt_id: discovery.receipt_id,
      batch_id: qualified.batch_id,
      counts: {
        parsed: qualified.counts.input,
        duplicate: discovery.counts.duplicate,
        excluded: qualified.counts.rejected,
        unresolved: qualified.counts.retry,
        added: qualified.counts.qualified,
        searches: qualified.counts.searches,
        jd_fetches: qualified.counts.jd_fetches,
        llm_calls: qualified.counts.llm_calls,
        llm_succeeded: qualified.counts.llm_succeeded,
        llm_failed: qualified.counts.llm_failed,
        // Bounded concurrent Claude qualification (2026-09-23): the worker
        // count actually used for this import, the maximum observed
        // in-flight calls, and whether a rate limit was hit mid-run.
        concurrency_used: qualified.counts.concurrency_used,
        max_concurrent_observed: qualified.counts.max_concurrent_observed,
        rate_limited: qualified.counts.rate_limited,
      },
      items,
      qualification: qualified,
    };
  }],
  // Manual exact-URL entry for a pasted job whose link could not be resolved.
  ['POST', '/api/review/set-url', async (body) => {
    const { batch_id: batchId, job_key: jobKey, url } = body;
    if (!batchId || !jobKey || !url) throw new Error('batch_id, job_key and url required');
    return setManualJobUrl(batchId, jobKey, url, { root: DATA_ROOT });
  }],
];

function matchRoute(method, urlPath) {
  return API_ROUTES.find(([m, p]) => m === method && p === urlPath);
}

/** Exposes the exact [method, path, handler] route the real HTTP server
 * dispatches to, so an isolated acceptance test can call the actual
 * production route function directly instead of re-implementing it. */
export function getApiRoute(method, urlPath) {
  const route = matchRoute(method, urlPath);
  if (!route) throw new Error(`no route ${method} ${urlPath}`);
  return route[2];
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
