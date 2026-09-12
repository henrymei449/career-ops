#!/usr/bin/env node
/**
 * post-title-gate.mjs — the shared candidate-processing chain that runs
 * AFTER title_filter and BEFORE pipeline.md, extracted so Lane A (scan.mjs's
 * own keyword-matched candidates) and Lane B (recall-relevance.mjs's
 * semantic-recall promotions) run through IDENTICAL logic rather than two
 * implementations that can drift.
 *
 * Split into three composable stages, matching the eligibility/content/dedup
 * split the dual-lane design needs:
 *   - runStructuralChecks: tier, location, posting-age, posted-date, salary —
 *     every one operates on fields already present on a normalized job
 *     object (title/location/postedAt/salary), no JD fetch required. This is
 *     also what recall-capture.mjs runs BEFORE writing a title-filter reject
 *     into the holding pen, so a candidate that would never survive geography
 *     or freshness never even enters the recall pool.
 *   - runContentChecks: content_filter, country_eligibility_filter,
 *     visa_filter — these read `job.description`, which is inconsistently
 *     available (whatever the provider's list API happened to include, or
 *     nothing) and semantically about JD text, not structural facts.
 *   - runDedupChecks: URL dedup, then company+role fuzzy dedup — the same
 *     two checks scan.mjs's own loop already runs, same functions.
 *   - runPostTitleGate: the three composed, in the same order scan.mjs's
 *     inline chain always ran them.
 *
 * Depends only on scan.mjs's already-exported, already-safe pure helpers
 * (normalizeUrlForDedup, companyRoleDedupKey, matchedTitleKeywords) — the
 * same functions scan-ats-full.mjs has imported directly from scan.mjs for
 * as long as that script has existed. No scanner/CLI logic, no network, no
 * writes: this module never touches main() or argv.
 */
import { classifyTier } from './classify-tier.mjs';
import { normalizeUrlForDedup, companyRoleDedupKey, matchedTitleKeywords } from './scan.mjs';

/**
 * @typedef {{accepted: true} | {accepted: false, reason: string}} GateResult
 */

/**
 * No-fetch structural checks only. Safe to run on a title-filter reject
 * before it ever enters the recall holding pen.
 *
 * @param {{title: string, location?: string, url?: string, postedAt?: number, salary?: object}} job
 * @param {{skipTiers?: string[], locationFilter?: Function, postingAgeFilter?: Function, postedDateFilter?: Function, salaryFilter?: Function}} filters
 * @returns {GateResult}
 */
export function runStructuralChecks(job, filters = {}) {
  const { skipTiers = [], locationFilter, postingAgeFilter, postedDateFilter, salaryFilter } = filters;

  if (skipTiers.length > 0 && skipTiers.includes(classifyTier(job.title))) {
    return { accepted: false, reason: 'tier' };
  }
  if (locationFilter && !locationFilter(job.location, job.url, job.title)) {
    return { accepted: false, reason: 'location' };
  }
  if (postingAgeFilter && !postingAgeFilter(job.postedAt)) {
    return { accepted: false, reason: 'posting_age' };
  }
  if (postedDateFilter && !postedDateFilter(job.postedAt)) {
    return { accepted: false, reason: 'posted_date' };
  }
  if (salaryFilter && !salaryFilter(job.salary)) {
    return { accepted: false, reason: 'salary' };
  }
  return { accepted: true };
}

/**
 * JD-content-dependent checks. Only meaningful when `job.description` is
 * present; every filter here already treats an absent/empty description as
 * a pass (same "don't penalize missing data" convention scan.mjs uses
 * everywhere else), so this degrades safely for a job with no description.
 *
 * @param {{title: string, description?: string}} job
 * @param {{contentFilter?: Function, countryEligibilityFilter?: Function, visaFilter?: Function, titleFilterConfig?: object}} filters
 * @returns {GateResult}
 */
export function runContentChecks(job, filters = {}) {
  const { contentFilter, countryEligibilityFilter, visaFilter, titleFilterConfig } = filters;
  const matchedKeywords = titleFilterConfig ? matchedTitleKeywords(job.title, titleFilterConfig) : [];

  if (contentFilter && !contentFilter(job.description, matchedKeywords)) {
    return { accepted: false, reason: 'content' };
  }
  if (countryEligibilityFilter && !countryEligibilityFilter(job.description)) {
    return { accepted: false, reason: 'country_eligibility' };
  }
  if (visaFilter && !visaFilter(job.description)) {
    return { accepted: false, reason: 'visa' };
  }
  return { accepted: true };
}

/**
 * URL dedup, then company+role fuzzy dedup — same functions, same order,
 * same wildcard semantics as scan.mjs's own inline loop.
 *
 * @param {{url: string, company: string, title: string, location?: string}} job
 * @param {{seenUrls?: Set<string>, seenCompanyRoles?: Set<string>, seenCompanyRoleBases?: Set<string>, canonicalizeCompany?: Function, dedupIncludeLocation?: boolean, isAggregator?: boolean}} dedupState
 * @returns {GateResult & {dedupUrl?: string, key?: string|null, baseKey?: string}}
 */
export function runDedupChecks(job, dedupState = {}) {
  const {
    seenUrls, seenCompanyRoles, seenCompanyRoleBases,
    canonicalizeCompany, dedupIncludeLocation = false, isAggregator = false,
  } = dedupState;

  const dedupUrl = normalizeUrlForDedup(job.url);
  if (seenUrls && seenUrls.has(dedupUrl)) {
    return { accepted: false, reason: 'duplicate_url', dedupUrl };
  }

  const baseKey = companyRoleDedupKey(job.company, job.title, canonicalizeCompany);
  const key = isAggregator
    ? null
    : (dedupIncludeLocation ? companyRoleDedupKey(job.company, job.title, canonicalizeCompany, job.location) : baseKey);

  if (
    key !== null && seenCompanyRoles && (
      seenCompanyRoles.has(key) ||
      seenCompanyRoles.has(baseKey) ||
      (key === baseKey && seenCompanyRoleBases?.has(baseKey))
    )
  ) {
    return { accepted: false, reason: 'duplicate_company_role', dedupUrl, key, baseKey };
  }

  return { accepted: true, dedupUrl, key, baseKey };
}

/**
 * The full post-title chain, in scan.mjs's original order: structural →
 * content → dedup. Both Lane A (scan.mjs's own loop) and Lane B
 * (recall-relevance.mjs, after a HIGH verdict) call this SAME function —
 * it is the one and only place this sequence is implemented.
 *
 * @param {object} job
 * @param {object} filters - union of runStructuralChecks/runContentChecks filter params
 * @param {object} dedupState - runDedupChecks params
 * @returns {GateResult}
 */
export function runPostTitleGate(job, filters = {}, dedupState = {}) {
  const structural = runStructuralChecks(job, filters);
  if (!structural.accepted) return structural;

  const content = runContentChecks(job, filters);
  if (!content.accepted) return content;

  return runDedupChecks(job, dedupState);
}
