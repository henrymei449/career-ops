// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Official-domain-search provider — a bounded, query-first fallback for
// companies whose careers site has no provider-backed scan. EXPLICIT-ONLY:
// no detect(), so it is reached only via `provider: official-domain-search`
// on a portals.yml entry (never auto-claims a URL).
//
//   approved title queries (portals.yml title_filter_overrides, via ctx)
//     -> `site:` queries on the entry's official domain (lib/official-domain-search.mjs)
//     -> scope + requisition-id dedupe -> URL screen
//     -> fetch each surviving page (bounded) -> liveness + title/location extraction
//     -> Job[]  (title/geography/dedup filtering stays in scan.mjs's loop)
//
// Not a crawler: no pagination, no link traversal, no inventory enumeration.
// Location is never inferred from the URL/locale path or office geography;
// an unknown location is returned as '' so downstream classification lands it
// in the existing needs-validation bucket instead of a PASS.
//
// Entry config (portals.yml):
//   provider: official-domain-search
//   official_domain_search:
//     host: wd1.myworkdaysite.com          # exact official/ATS host
//     path_prefix: /recruiting/onto        # optional tenant scope
//     query_scope: horiba.com              # optional; site: scope for the QUERY only
//     query_extra: '"job-specification"'   # optional literal marker added to each query
//     job_path_re: '/onto_careers/(job/|details/)'   # posting URL shape (case-insensitive)
//     req_id_re: '_(r-\d+)'                # capture 1 = requisition id (dedupe key)
//     strip_path_suffix_re: '/apply$'
//     lowercase_path: true
//     prefer_re: '/job/'
//     keep_params: []
//     require_json_ld: true                # Workday: no JobPosting payload => not live
//     body_location: false                 # conservative body-text location extractor
//     max_queries: 30   max_lane_queries: 10   max_unique: 60   max_fetch: 40

import {
  collectCandidates, assessJobPage,
} from '../lib/official-domain-search.mjs';
import { serperSearch } from '../lib/outreach-search-serper.mjs';

const DEFAULT_MAX_QUERIES = 30;
const DEFAULT_MAX_UNIQUE = 60;
const DEFAULT_MAX_FETCH = 40;
const DEFAULT_MAX_LANE_QUERIES = 10;

/** @param {unknown} v */
const asRegex = (v, name) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`official-domain-search: ${name} must be a string regex`);
  return new RegExp(v, 'i');
};

/**
 * portals.yml entry config -> lib DomainProfile.
 * @param {any} cfg
 */
export function buildProfile(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('official-domain-search: entry has no official_domain_search block');
  if (typeof cfg.host !== 'string' || !cfg.host) throw new Error('official-domain-search: official_domain_search.host is required');
  const jobPathRe = asRegex(cfg.job_path_re, 'job_path_re');
  if (!jobPathRe) throw new Error('official-domain-search: official_domain_search.job_path_re is required');
  return {
    host: cfg.host.toLowerCase(),
    pathPrefix: cfg.path_prefix || undefined,
    queryScope: cfg.query_scope || undefined,
    queryExtra: cfg.query_extra || undefined,
    keepParams: Array.isArray(cfg.keep_params) ? cfg.keep_params : [],
    jobPathRe,
    reqIdRe: asRegex(cfg.req_id_re, 'req_id_re'),
    stripPathSuffixRe: asRegex(cfg.strip_path_suffix_re, 'strip_path_suffix_re'),
    lowercasePath: cfg.lowercase_path === true,
    preferRe: asRegex(cfg.prefer_re, 'prefer_re'),
    requireJsonLd: cfg.require_json_ld === true,
    bodyLocation: cfg.body_location === true,
  };
}

/**
 * The approved title queries for a company: title_filter_overrides
 * `positive_extra` for every override block that lists the company (exact,
 * case-insensitive name match — the same rule scan.mjs's override matcher uses).
 * "A + B" (an AND-group) becomes `"A" B`; a plain string becomes `"A"`.
 * No query is ever invented: no matching override => no terms.
 * @param {string} companyName
 * @param {any[]|undefined} overrides raw `title_filter_overrides` from portals.yml
 * @returns {string[]}
 */
export function approvedQueryTerms(companyName, overrides) {
  const name = String(companyName).trim().toLowerCase();
  const terms = [];
  for (const block of Array.isArray(overrides) ? overrides : []) {
    const companies = Array.isArray(block?.companies) ? block.companies : [];
    if (!companies.some((c) => typeof c === 'string' && c.trim().toLowerCase() === name)) continue;
    for (const raw of Array.isArray(block.positive_extra) ? block.positive_extra : []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const [head, ...rest] = raw.split(' + ').map((s) => s.trim()).filter(Boolean);
      terms.push(rest.length ? `"${head}" ${rest.join(' ')}` : `"${head}"`);
    }
  }
  return [...new Set(terms)];
}

/**
 * Separate, bounded fallback query list for a title lane (`title_filter_lanes[].fallback_queries`).
 * Explicit strings only: nothing is derived or invented, and a company outside the lane's
 * `companies` gets none.
 * @param {string} companyName
 * @param {any[]|undefined} lanes raw `title_filter_lanes` from portals.yml
 * @returns {string[]}
 */
export function laneFallbackQueries(companyName, lanes) {
  const name = String(companyName).trim().toLowerCase();
  const out = [];
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const companies = Array.isArray(lane?.companies) ? lane.companies : [];
    if (!companies.some((c) => typeof c === 'string' && c.trim().toLowerCase() === name)) continue;
    for (const q of Array.isArray(lane.fallback_queries) ? lane.fallback_queries : []) {
      if (typeof q === 'string' && q.trim()) out.push(q.trim());
    }
  }
  return [...new Set(out)];
}

/**
 * Core run, with the searcher injectable for tests.
 * @param {any} entry
 * @param {any} ctx
 * @param {{search?: (q: string) => Promise<any[]>}} [deps]
 * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
 */
export async function fetchOfficialDomainJobs(entry, ctx, { search = (q) => serperSearch(q) } = {}) {
  const cfg = entry.official_domain_search;
  const profile = buildProfile(cfg);
  const allTerms = approvedQueryTerms(entry.name, ctx?.titleFilterOverridesRaw);
  const laneTerms = laneFallbackQueries(entry.name, ctx?.titleFilterLanesRaw)
    .slice(0, Number(cfg.max_lane_queries) || DEFAULT_MAX_LANE_QUERIES);
  if (allTerms.length === 0 && laneTerms.length === 0) {
    throw new Error(`official-domain-search: no approved title queries (title_filter_overrides / title_filter_lanes) for "${entry.name}"`);
  }
  // Single pass: Lane A's existing queries first (unchanged), then the lane's own bounded
  // list. One provider.fetch returns one job set; scan.mjs's loop applies every title lane.
  const terms = [...new Set([...allTerms.slice(0, Number(cfg.max_queries) || DEFAULT_MAX_QUERIES), ...laneTerms])];

  const { candidates } = await collectCandidates({
    search, profile, terms,
    maxPerQuery: 20, maxUnique: Number(cfg.max_unique) || DEFAULT_MAX_UNIQUE,
  });
  const likely = candidates.filter((c) => c.likelyJob).slice(0, Number(cfg.max_fetch) || DEFAULT_MAX_FETCH);

  /** @type {Array<{title: string, url: string, company: string, location: string}>} */
  const jobs = [];
  let transportFailures = 0;
  for (const cand of likely) {
    let fetched;
    try {
      const html = await ctx.fetchText(cand.canonicalUrl, { redirect: 'error' });
      fetched = { status: 200, html };
    } catch (err) {
      const status = /** @type {any} */ (err)?.status;
      if (status) fetched = { status, html: '' }; // 404/410/5xx: a verdict, not a transport failure
      else { transportFailures += 1; continue; }
    }
    const verdict = assessJobPage(fetched, profile);
    if (!verdict.live) continue; // dead / stale / generic pages are never jobs
    jobs.push({
      title: verdict.title,
      url: cand.canonicalUrl,
      company: entry.name,
      // 'unavailable' becomes '' so scan.mjs/location-tier treat it as unknown
      // (needs-validation), never as a match.
      location: verdict.location === 'unavailable' ? '' : verdict.location,
    });
  }
  if (likely.length > 0 && transportFailures === likely.length) {
    throw new Error(`official-domain-search: every page fetch failed for ${entry.name} (network/DNS) — treating as a provider error`);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'official-domain-search',
  async fetch(entry, ctx) {
    return fetchOfficialDomainJobs(entry, ctx);
  },
};
