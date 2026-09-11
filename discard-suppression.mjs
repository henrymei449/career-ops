#!/usr/bin/env node
/**
 * discard-suppression.mjs — safe suppression semantics for data/discard.log.
 *
 * data/discard.log is an append-only audit trail: one line per posting a
 * pre-screen gate rejected, `{timestamp}\t{url}\t{reason}`. Historically the
 * free-text reason sometimes names the company in passing, e.g.
 * `SKIP per user decision (skip Deloitte) -- 5+ yrs Siemens Opcenter
 * specifically required; ...`. Read casually (by a human, or by an agent
 * building context for a scan/triage/pipeline pass), a company appearing in
 * several of these lines can look like a standing "skip this company"
 * policy -- it never was one; every existing reason is a judgment about THAT
 * posting (comp band, tech stack, seniority), not the employer.
 *
 * This module is the single, tested place that decides what a discard.log
 * entry suppresses:
 *
 *   - DEFAULT (any entry, old or new): suppresses ONLY that exact URL. This
 *     is already redundantly enforced by scan.mjs's own pipeline.md/
 *     scan-history.tsv/applications.md URL dedup (a discarded posting's URL
 *     is written to pipeline.md's "Processed" section, which collectSeenUrls
 *     already treats as seen) -- nothing here needs to duplicate that.
 *   - COMPANY-WIDE (opt-in, explicit): ONLY when the reason contains the
 *     literal marker `(SKIP_COMPANY)` immediately followed by the company
 *     name, e.g. `(SKIP_COMPANY) Deloitte`. Every entry written before this
 *     marker existed lacks it by construction, so old ambiguous phrasing
 *     ("(skip Deloitte)", "(skip PTC)", ...) can never match it -- no
 *     migration of data/discard.log is needed for old rows to be safe.
 *
 * Company matching always goes through normalizeCompany() (tracker-utils.mjs
 * -- the same normalizer blacklist.md matching already uses): deterministic
 * case/whitespace/Unicode folding, exact-key equality only. Nothing here
 * does substring or similarity matching on a company name -- two companies
 * whose names merely look alike (different normalizeCompany() keys) never
 * cross-suppress.
 */
import { parseDiscardLog } from './discard-analytics.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { normalizeUrlForDedup } from './scan.mjs';

export const SKIP_COMPANY_MARKER = '(SKIP_COMPANY)';

// Company name = the run of text right after the marker, up to the next
// em-dash/hyphen segment break (the existing discard.log convention already
// separates "what" from "why" with ` -- ` / ` — `) or end of string.
const MARKER_RE = /\(SKIP_COMPANY\)\s+([^\n\t]+?)(?:\s+[-–—]{1,2}\s|\s*$)/;

/**
 * @param {string} reason - One discard.log entry's reason field.
 * @returns {string|null} The company name if the entry carries an explicit
 *   company-wide marker, else null.
 */
export function extractCompanyWideSkip(reason) {
  const m = MARKER_RE.exec(String(reason ?? ''));
  const company = m?.[1]?.trim();
  return company ? company : null;
}

/**
 * @typedef {{timestamp: string, url: string, reason: string}} DiscardEntry
 * @typedef {{urlIndex: Map<string, DiscardEntry>, companyIndex: Map<string, {company: string, reason: string, entry: DiscardEntry}>}} SuppressionIndex
 */

/**
 * @param {DiscardEntry[]} entries - Parsed discard.log rows (parseDiscardLog).
 * @returns {SuppressionIndex}
 */
export function buildSuppressionIndex(entries) {
  const urlIndex = new Map();
  const companyIndex = new Map();
  for (const entry of entries) {
    const urlKey = normalizeUrlForDedup(entry.url);
    if (urlKey && !urlIndex.has(urlKey)) urlIndex.set(urlKey, entry);

    const company = extractCompanyWideSkip(entry.reason);
    if (company) {
      const key = normalizeCompany(company);
      if (key && !companyIndex.has(key)) companyIndex.set(key, { company, reason: entry.reason, entry });
    }
  }
  return { urlIndex, companyIndex };
}

/**
 * Convenience: parse discard.log text straight into a SuppressionIndex.
 * @param {string} discardLogText
 * @returns {SuppressionIndex}
 */
export function buildSuppressionIndexFromText(discardLogText) {
  return buildSuppressionIndex(parseDiscardLog(discardLogText));
}

/**
 * @param {{url: string, company: string}} offer
 * @param {SuppressionIndex} index
 * @returns {{suppressed: boolean, scope: 'url'|'company'|null, entry: object|null}}
 */
export function isSuppressed(offer, index) {
  const urlKey = normalizeUrlForDedup(offer?.url);
  if (urlKey && index.urlIndex.has(urlKey)) {
    return { suppressed: true, scope: 'url', entry: index.urlIndex.get(urlKey) };
  }
  const companyKey = normalizeCompany(offer?.company || '');
  if (companyKey && index.companyIndex.has(companyKey)) {
    return { suppressed: true, scope: 'company', entry: index.companyIndex.get(companyKey) };
  }
  return { suppressed: false, scope: null, entry: null };
}
