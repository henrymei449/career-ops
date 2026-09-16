// lib/outreach-search-serper.mjs — the ONE real public-web search provider
// wired into outreach.mjs's contact-discovery interface (Pass 2B).
//
// Reuses providers/_http.mjs's fetchJson — the same timeout/non-2xx/DNS-guard
// wrapper scan.mjs's ATS providers already use — rather than a bare `fetch`,
// even though this call target is a fixed literal URL (not user-controlled
// config), because it is the existing "generic web-search infrastructure" the
// task asked to reuse and there is no reason to hand-roll a second fetch
// wrapper for one more caller.
//
// Provider choice: Serper (google.serper.dev) wraps Google Search results as
// JSON for exactly the `site:linkedin.com/in ...` query shape outreach.mjs
// generates — smallest viable integration for this MVP. No fallback chain,
// no second provider; see AGENTS.md-equivalent non-goals in outreach.mjs's
// own header.
//
// Interface: matches outreach.mjs's discoverContacts()'s `searchProvider`
// exactly — `(query: string) => Promise<Array<{title, url, snippet}>>` — so
// this is a drop-in for CAREER_OPS_SEARCH_PROVIDER, not a special case.

import { fetchJson } from '../providers/_http.mjs';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/**
 * @param {string} query
 * @param {{apiKey?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
export async function serperSearch(query, { apiKey = process.env.SERPER_API_KEY, timeoutMs } = {}) {
  if (!apiKey) {
    throw new Error(
      'SERPER_API_KEY is not set. Add it to your career-ops data root\'s .env ' +
      '(same file as APIFY_TOKEN etc. — see .env.example for the format; ' +
      'https://serper.dev for a free key), or set CAREER_OPS_SEARCH_PROVIDER ' +
      'to use a different search-provider module instead.',
    );
  }

  // fetchJson throws on any non-2xx (HTTP 401 for a bad key, 429 for
  // exhausted quota, etc.) — that throw IS the "fails clearly" behavior:
  // it propagates out of discoverContacts() unmutated, so a provider error
  // never gets recorded as CANDIDATES_FOUND with [].
  const data = await fetchJson(SERPER_ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query }),
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  // A 200 response with no `organic` array is Serper's shape for an error it
  // still answers 2xx for (e.g. "Not enough credits"), not a legitimate zero
  // result set. Distinguishing the two matters: one is a provider failure
  // that must be loud, the other is a real "nothing found" outcome the
  // caller is allowed to persist as CANDIDATES_FOUND with [].
  if (!data || !Array.isArray(data.organic)) {
    throw new Error(`Serper response for "${query}" has no organic results array — treating as a provider error, not zero candidates.`);
  }

  return data.organic.map((r) => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }));
}

/** Default export matches the searchProvider(query) interface directly. */
export default async function search(query) {
  return serperSearch(query);
}
