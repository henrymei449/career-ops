// review-schema.mjs — canonical shape for the SOP review batch lifecycle
// (sourcing survivor -> UNREVIEWED review batch -> proposed decision ->
// human finalization -> durable state). Pure data/validation functions only
// — no filesystem access here, so review.mjs (the lifecycle/CLI layer) and
// its tests can both depend on one definition of "what a valid batch is."
//
// Extends the existing job model rather than inventing a parallel one:
// job_key reuses the same stable identity primitives the tracker/scanner
// already dedup on (url-key.mjs's normalizeUrl, scan.mjs's
// companyRoleDedupKey), and the geography gate reuses location-tier.mjs's
// classifyGeography — the exact function scan.mjs itself gates survivors on.

import { normalizeUrl } from './url-key.mjs';
import { companyRoleDedupKey, resolveJobDescriptionText } from './scan.mjs';
import { classifyGeography } from './location-tier.mjs';

export const SCHEMA_VERSION = 1;

// review.status: whether a human/SOP pass has produced a decision yet.
export const REVIEW_STATUSES = ['UNREVIEWED', 'REVIEWED'];

// proposed_decision / final_decision vocabulary. Distinct from triage.md's
// PASS/MARGINAL/FAIL verdict language — PASS here means "pass on this role"
// (reject), matching the task's canonical fit/review states.
export const FIT_DECISIONS = ['APPLY', 'INVESTIGATE', 'PASS'];

// execution_status: separate axis from the fit decision. Phase 1 only ever
// sets READY_TO_APPLY (for a finalized APPLY); everything else is NONE.
// APPLIED is added in Pass 2 (outreach.mjs's markApplied) — a human-driven
// transition out of READY_TO_APPLY, never set by ingestFinalizedReviewBatches.
// NOT_APPLYING is a second human-driven transition out of READY_TO_APPLY
// (outreach.mjs's passOnApplication) for a job the human decides not to
// pursue after all — it never rewrites fit_decision, which stays APPLY.
export const EXECUTION_STATUSES = ['NONE', 'READY_TO_APPLY', 'APPLIED', 'NOT_APPLYING'];

export const BATCH_STATUSES = ['open', 'finalized', 'processed'];

/**
 * Stable identity for a job, reusing the SAME dedup primitives the tracker
 * and scanner already key on — never a parallel identity scheme.
 *
 * Prefers the canonical posting-URL key (url-key.mjs's normalizeUrl); when a
 * job carries no usable http(s) URL (e.g. a bare company+title lead), falls
 * back to the company+role(+location) dedup key scan.mjs already computes
 * for intra-scan/tracker dedup. Prefixed so the two key spaces can never
 * collide with each other.
 *
 * @param {{url?: string, company?: string, title?: string, location?: string}} job
 * @returns {string} Stable key, or '' when neither identity signal is usable.
 */
export function computeJobKey(job = {}) {
  const urlKey = normalizeUrl(job.url);
  if (urlKey) return `url:${urlKey}`;
  const crKey = companyRoleDedupKey(job.company, job.title, undefined, job.location);
  return crKey ? `cr:${crKey}` : '';
}

/**
 * Deterministic gate evidence already knowable from the job object alone —
 * computed once at batch-build time so a reviewer (human or SOP provider)
 * sees it without re-deriving it, and so a hard-gate rejection (geography)
 * is machine-checkable independent of whatever a reviewer proposes.
 *
 * @param {object} job
 * @returns {{geography: {state: string, reason: string}}}
 */
export function computeGateEvidence(job = {}) {
  const description = job.description || resolveJobDescriptionText(job) || '';
  return {
    geography: classifyGeography(job, description),
  };
}

/**
 * Fresh review sub-object for a newly-sourced job — no decision has been
 * made yet, so both proposed_decision and final_decision stay null. Only
 * `finalizeBatch` may ever set final_decision; nothing else in this module
 * or review.mjs does, by construction (see #3 in review.mjs's tests).
 */
export function freshReview() {
  return {
    status: 'UNREVIEWED',
    proposed_decision: null,
    final_decision: null,
    reason: '',
    reason_codes: [],
    finalized: false,
    reviewer: null,
    reviewed_at: null,
    finalized_at: null,
  };
}

/**
 * Build one canonical job record for a review batch from a sourcing
 * survivor (the same shape scan.mjs's verifiedOffers/pipeline.md entries
 * carry — company/title/url/source/location/salary/description/postedAt).
 *
 * @param {object} job - A survivor job/offer object.
 * @returns {object} Canonical review job record.
 */
export function buildJobRecord(job = {}) {
  const jobKey = computeJobKey(job);
  const jdText = job.description || '';
  return {
    job_key: jobKey,
    company: job.company ?? '',
    title: job.title ?? '',
    url: job.url ?? '',
    source: job.source ?? '',
    location: job.location ?? '',
    posted_date: job.postedAt ?? job.posted_date ?? '',
    compensation: job.salary ?? job.compensation ?? null,
    jd: jdText
      ? { mode: 'inline', text: jdText }
      : (typeof job.url === 'string' && job.url.startsWith('local:'))
        ? { mode: 'reference', ref: job.url }
        : { mode: 'none' },
    gates: computeGateEvidence(job),
    review: freshReview(),
    // Source-specific provenance (e.g. linkedin-paste-intake.mjs's search
    // query, card labels, URL-resolution status). Carried verbatim; nothing
    // in the lifecycle reads it for a decision.
    ...(job.intake && typeof job.intake === 'object' ? { intake: job.intake } : {}),
  };
}

/**
 * Build a full review batch from an array of sourcing survivors. Records
 * with no usable job_key are dropped (never silently kept with an empty
 * identity that could collide with another record) and reported in
 * `skipped` so the caller can log them.
 *
 * @param {object[]} jobs
 * @param {{batchId: string, source?: string, createdAt?: string}} opts
 * @returns {{batch: object, skipped: object[]}}
 */
export function buildBatch(jobs, { batchId, source = 'manual', createdAt = new Date().toISOString() }) {
  if (!batchId) throw new Error('buildBatch: batchId is required');
  const records = [];
  const skipped = [];
  for (const job of jobs || []) {
    const record = buildJobRecord(job);
    if (!record.job_key) { skipped.push(job); continue; }
    records.push(record);
  }
  const batch = {
    schema_version: SCHEMA_VERSION,
    batch_id: batchId,
    created_at: createdAt,
    status: 'open',
    source,
    jobs: records,
  };
  return { batch, skipped };
}

/**
 * Structural validation shared by every stage of the lifecycle (batch
 * creation, proposed-decision ingestion, finalization). Returns a flat list
 * of human-readable errors; [] means valid.
 *
 * `stage` controls how strict the check is:
 *   - 'open'       — a freshly-created or in-review batch. final_decision
 *                    must be null on every job (a proposed decision alone
 *                    must never carry a final one — see test #3).
 *   - 'proposed'   — same as 'open', plus: if review.status is 'REVIEWED',
 *                    proposed_decision must be a valid FIT_DECISIONS member.
 *   - 'finalized'  — every job must have finalized=true, a valid
 *                    final_decision, and review.status 'REVIEWED'.
 *
 * @param {object} batch
 * @param {'open'|'proposed'|'finalized'} [stage='open']
 * @returns {string[]} Validation errors.
 */
export function validateBatch(batch, stage = 'open') {
  const errors = [];
  if (!batch || typeof batch !== 'object') return ['batch is not an object'];
  if (batch.schema_version !== SCHEMA_VERSION) errors.push(`unexpected schema_version: ${batch.schema_version}`);
  if (!batch.batch_id) errors.push('missing batch_id');
  if (!BATCH_STATUSES.includes(batch.status)) errors.push(`invalid batch status: ${batch.status}`);
  if (!Array.isArray(batch.jobs)) { errors.push('jobs is not an array'); return errors; }

  const seenKeys = new Set();
  batch.jobs.forEach((job, i) => {
    const at = `jobs[${i}]`;
    if (!job.job_key) errors.push(`${at}: missing job_key`);
    else if (seenKeys.has(job.job_key)) errors.push(`${at}: duplicate job_key ${job.job_key}`);
    else seenKeys.add(job.job_key);

    const r = job.review || {};
    if (!REVIEW_STATUSES.includes(r.status)) errors.push(`${at}: invalid review.status ${r.status}`);
    if (r.proposed_decision !== null && !FIT_DECISIONS.includes(r.proposed_decision)) {
      errors.push(`${at}: invalid proposed_decision ${r.proposed_decision}`);
    }
    if (r.proposed_decision === 'INVESTIGATE' && !String(r.reason || '').trim()) {
      errors.push(`${at}: INVESTIGATE requires a concrete reason`);
    }

    if (stage === 'open') {
      if (r.final_decision !== null) errors.push(`${at}: final_decision must be null on an open batch (was ${r.final_decision})`);
      if (r.finalized) errors.push(`${at}: finalized must be false on an open batch`);
    } else if (stage === 'proposed') {
      if (r.final_decision !== null) errors.push(`${at}: final_decision must still be null before finalization (was ${r.final_decision})`);
      if (r.finalized) errors.push(`${at}: finalized must be false before finalization`);
    } else if (stage === 'finalized') {
      if (!r.finalized) errors.push(`${at}: finalized must be true in a finalized batch`);
      if (!FIT_DECISIONS.includes(r.final_decision)) errors.push(`${at}: invalid final_decision ${r.final_decision}`);
      if (r.status !== 'REVIEWED') errors.push(`${at}: review.status must be REVIEWED once finalized`);
    }
  });
  return errors;
}
