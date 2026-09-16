#!/usr/bin/env node
/**
 * adhoc-intake.mjs — manual job URL -> canonical review batch (#pass3).
 *
 * The smallest usable bridge from "I found a job myself" (LinkedIn, a
 * company careers page, a recruiter link) into the exact same pipeline a
 * sourced job already goes through: capture -> identity/dedupe check ->
 * UNREVIEWED review batch (source: 'ad_hoc') -> the same first-pass-fit SOP
 * (modes/review-sop.md, run out-of-band exactly like every other batch —
 * see review.mjs's "SOP execution boundary" docstring, unchanged here) ->
 * the same human Review tab -> the same Ready to Apply / Mark Applied /
 * Applications / Outreach flow. No parallel job model, no parallel state
 * store, no parallel scoring: this module is capture + dedupe only.
 *
 * Capture reuses the exact same provider dispatch the rest of the codebase
 * already has:
 *   - browser-extract.mjs's fetchJdViaKnownApi() for a known ATS posting
 *     (Greenhouse/Lever/Ashby/Workday) — no browser needed.
 *   - browser-extract.mjs's captureJdViaBrowser() (the same generic
 *     Playwright DOM-read main()'s jd mode falls through to) for any other
 *     http(s) URL — a LinkedIn post, a company's own careers page, anything.
 * Neither path is duplicated here; this module only orchestrates them.
 *
 * Identity/dedupe reuses review-schema.mjs's computeJobKey() (the SAME
 * url-first/company-role-fallback identity every batch already keys on) and
 * checks it against BOTH durable state (data/review-state.json, via
 * review.mjs's getJobState) and any open/finalized batch (via review.mjs's
 * findBatchedJob) BEFORE spending a network/browser call — a duplicate URL
 * short-circuits on the cheap URL-normalization check alone.
 *
 * Company/location for a known-ATS capture are a best-effort read off the
 * posting URL's own slug (Greenhouse board / Lever slug / Ashby org /
 * Workday tenant) and the JD text's own "Location: ..." metadata line
 * (written by browser-extract.mjs's normalize*Job() functions) — never
 * fabricated. For a generic (non-ATS) capture, company is a best-effort
 * parse of the page title ("Title at Company", "Title - Company") and may
 * come back empty; an empty company/location is not a capture failure (the
 * job still has a real URL and JD text), it is evidence the review-sop.md
 * first-pass-fit step should flag as an unresolved fact (INVESTIGATE),
 * exactly as review-sop.md already specifies for any missing evidence.
 *
 * Usage:
 *   node adhoc-intake.mjs <url>   # capture + dedupe-check + batch, JSON to stdout
 */

import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { fetchJdViaKnownApi, captureJdViaBrowser } from './browser-extract.mjs';
import { resolveAtsApi } from './liveness-api.mjs';
import { computeJobKey } from './review-schema.mjs';
import { createBatchFromJobs, getJobState, findBatchedJob } from './review.mjs';

const DATA_ROOT = getCareerOpsRoot();

/**
 * Best-effort human-readable name from an ATS URL slug (a Greenhouse board,
 * Lever slug, Ashby org, or Workday tenant). Never authoritative — it is a
 * fallback for when the JD text/API payload carries no company field at all
 * (none of the four ATS JD payloads do), shown to the reviewer as-is so a
 * wrong guess is visibly a guess rather than silently accepted as fact.
 *
 * @param {string} slug
 * @returns {string}
 */
export function slugToCompanyName(slug) {
  return String(slug || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Best-effort company guess from a generic page's <title>/<h1> text, for the
 * non-ATS capture path where there is no URL slug to fall back on. Handles
 * the two dominant real-world shapes ("Title at Company", "Title - Company |
 * Site") and returns '' rather than a wrong guess when neither matches — an
 * empty company is honest signal the SOP can act on; a wrong one is not.
 *
 * @param {string} title
 * @returns {string}
 */
export function guessCompanyFromTitle(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const atMatch = /\bat\s+([A-Z][\w&.,' -]{1,60})$/.exec(t);
  if (atMatch) return atMatch[1].trim();
  // "Title - Company" (2 segments) or "Title - Company | Site" (3+, where the
  // trailing segment is the site/brand, not the employer) both put the
  // company in the second segment.
  const parts = t.split(/\s+[-|–]\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : '';
}

/**
 * Pull the "Location: ..." metadata line browser-extract.mjs's
 * normalizeWorkdayJob/normalizeAshbyJob/normalizeGreenhouseJob/
 * normalizeLeverJob already prepend to JD text, rather than re-deriving
 * location from a second source. '' when the JD carries no such line.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractLocationFromJdText(text) {
  const m = /^Location:\s*(.+)$/m.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

/**
 * Capture one job posting into the canonical {url, title, company, location,
 * description, source} shape review-schema.mjs's buildJobRecord() expects —
 * trying the known-ATS API first, falling through to the generic browser
 * capture, exactly like browser-extract.mjs's own jd-mode CLI does.
 *
 * @param {string} url - already-validated http(s) URL.
 * @param {{maxChars?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{job: object} | {unresolvable: true, reason: string, code: string}>}
 */
export async function captureJob(url, { maxChars, timeoutMs } = {}) {
  const apiResult = await fetchJdViaKnownApi(url, maxChars, timeoutMs);
  if (apiResult) {
    const resolved = resolveAtsApi(url);
    const parts = resolved?.parts || {};
    const slug = parts.board || parts.org || parts.tenant || parts.slug || '';
    return {
      job: {
        url: apiResult.url,
        title: apiResult.title,
        company: slugToCompanyName(slug),
        location: extractLocationFromJdText(apiResult.text),
        description: apiResult.text,
        source: `ad_hoc:${apiResult.ats}`,
      },
    };
  }

  const browserResult = await captureJdViaBrowser(url, { maxChars, timeoutMs });
  if (browserResult.error) {
    return { unresolvable: true, reason: browserResult.error, code: browserResult.code };
  }
  return {
    job: {
      url: browserResult.url,
      title: browserResult.title,
      company: guessCompanyFromTitle(browserResult.title),
      location: '',
      description: browserResult.text,
      source: 'ad_hoc:generic',
    },
  };
}

/**
 * Durable-state-or-batched lookup for one job_key. Durable state
 * (data/review-state.json) is checked first — it is authoritative once a
 * batch has been finalized+ingested — then any open/finalized batch that
 * has not reached durable state yet (review.mjs's findBatchedJob).
 *
 * @param {string} jobKey
 * @param {{root?: string}} [opts]
 * @returns {{state: string, summary: {company:string,title:string,url:string}, batch_id?: string, reason?: string}|null}
 */
export function findExistingJob(jobKey, { root = DATA_ROOT } = {}) {
  const durable = getJobState(jobKey, { root });
  if (durable) {
    let state;
    if (durable.fit_decision === 'PASS') state = 'PASS';
    else if (durable.execution_status === 'APPLIED') state = 'APPLIED';
    else if (durable.execution_status === 'READY_TO_APPLY') state = 'READY_TO_APPLY';
    else if (durable.execution_status === 'NOT_APPLYING') state = 'NOT_APPLYING';
    else if (durable.fit_decision === 'INVESTIGATE') state = 'INVESTIGATE';
    else state = 'DECIDED';
    return {
      state,
      summary: { company: durable.company || '', title: durable.title || '', url: durable.url || '' },
      reason: durable.reason || '',
    };
  }

  const batched = findBatchedJob(jobKey, { root });
  if (batched) {
    const r = batched.job.review;
    const state = r.final_decision
      ? 'REVIEWED_PENDING_FINALIZE'
      : r.proposed_decision
        ? 'PROPOSED_PENDING_REVIEW'
        : 'UNREVIEWED';
    return {
      state,
      summary: { company: batched.job.company || '', title: batched.job.title || '', url: batched.job.url || '' },
      batch_id: batched.batch_id,
    };
  }

  return null;
}

/**
 * The whole ad-hoc intake pipeline for one URL: validate -> cheap dedupe
 * check (URL identity alone, before any network/browser call) -> capture ->
 * scoped ad_hoc batch. Never throws for an ordinary bad outcome (invalid
 * URL, duplicate, unresolvable posting) — those come back as a distinct
 * `outcome`, matching this module's contract with its one caller
 * (POST /api/intake in ui-server.mjs), which needs to tell them apart in the
 * UI rather than treat every non-2xx the same.
 *
 * @param {string} rawUrl
 * @param {{root?: string, maxChars?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<
 *   {outcome: 'created', batch_id: string, job_key: string, job: object, evidence_gaps: string[]} |
 *   {outcome: 'existing', job_key: string, state: string, summary: object, batch_id?: string, reason?: string} |
 *   {outcome: 'unsupported', reason: string, code: string} |
 *   {outcome: 'error', error: string}
 * >}
 */
export async function intakeJob(rawUrl, { root = DATA_ROOT, maxChars, timeoutMs } = {}) {
  let url;
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http(s)');
    url = parsed.href;
  } catch {
    return { outcome: 'error', error: `invalid URL: ${rawUrl}` };
  }

  const jobKey = computeJobKey({ url });
  if (!jobKey) return { outcome: 'error', error: 'could not derive a stable identity for this URL' };

  const existing = findExistingJob(jobKey, { root });
  if (existing) return { outcome: 'existing', job_key: jobKey, ...existing };

  const captured = await captureJob(url, { maxChars, timeoutMs });
  if (captured.unresolvable) {
    return { outcome: 'unsupported', reason: captured.reason, code: captured.code };
  }

  const { batchId, batch, skipped } = createBatchFromJobs([captured.job], { root, source: 'ad_hoc' });
  if (!batchId || skipped.length) {
    return { outcome: 'error', error: 'captured job could not be keyed into a batch (no derivable identity)' };
  }
  const job = batch.jobs[0];
  return {
    outcome: 'created',
    batch_id: batchId,
    job_key: job.job_key,
    job: { company: job.company, title: job.title, url: job.url, location: job.location },
    evidence_gaps: ['company', 'title', 'location'].filter((f) => !job[f]),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node adhoc-intake.mjs <url>');
    process.exitCode = 1;
    return;
  }
  const result = await intakeJob(url);
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === 'error') process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`adhoc-intake.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
