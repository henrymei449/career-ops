// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Lever provider — hits the public postings endpoint.
// Auto-detects from careers_url via jobs.(eu.)?lever.co/<slug>.
// Handles both explicit `api:` URLs and auto-detection from `careers_url`.
//
// The v0 postings list ships every posting's full description in one payload,
// so it can run past the global 10s default (providers/_http.mjs) and abort
// with no status — one such abort (Machina Labs, 2026-10-17) left a company's
// raw count unknown and failed a whole strict discovery night. Same remedy as
// ashby.mjs: a longer per-request timeout plus the shared bounded retry, which
// still never re-asks a board that answered a deterministic 4xx.
import { fetchJsonWithRetry } from './_http.mjs';

const LEVER_TIMEOUT_MS = 30_000;
const LEVER_RETRIES = 2;

const ALLOWED_LEVER_HOSTS = new Set(['api.lever.co', 'api.eu.lever.co']);

/** @param {string} url */
function assertLeverUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lever: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`lever: URL must use HTTPS: ${url}`);
  if (!ALLOWED_LEVER_HOSTS.has(parsed.hostname))
    throw new Error(`lever: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_LEVER_HOSTS].join(', ')}`);
  return url;
}

/** @param {import('./_types.js').PortalEntry} entry */
function resolveApiUrl(entry) {
  // Explicit api: wins — lets an entry keep a human-facing corporate
  // careers_url (e.g. https://www.coalfire.com/careers) while still pinning
  // the Lever postings board (mirrors greenhouse's api: precedence).
  if (entry.api) {
    assertLeverUrl(entry.api);
    return entry.api;
  }
  let url;
  try {
    url = new URL(entry.careers_url || '');
  } catch {
    return null;
  }
  const host = url.hostname.match(/^jobs\.((?:eu\.)?lever\.co)$/);
  if (!host) return null;
  const slug = url.pathname.split('/').filter(Boolean)[0];
  if (!slug) return null;
  return `https://api.${host[1]}/v0/postings/${slug}`;
}

/** Fold `categories.location` together with any extra `categories.allLocations`
 *  into one string. Lever puts a SINGLE primary city in `location`, and exposes
 *  the full set on multi-location postings in `allLocations` — reading only the
 *  former silently hides every other eligible location from scan.mjs's
 *  location_filter (e.g. a req open in Barcelona AND Montevideo looks
 *  Barcelona-only). Mirrors resolveLocation() in providers/remotli.mjs.
 *  @param {any} categories */
function resolveLocation(categories) {
  const primary = typeof categories?.location === 'string' ? categories.location.trim() : '';
  const all = Array.isArray(categories?.allLocations)
    ? categories.allLocations.filter(l => typeof l === 'string' && l.trim()).map(l => l.trim())
    : [];
  const merged = [];
  for (const l of [primary, ...all]) {
    if (l && !merged.some(m => m.toLowerCase() === l.toLowerCase())) merged.push(l);
  }
  return merged.join('; ');
}

/** @type {Provider} */
export default {
  id: 'lever',

  detect(entry) {
    try {
      const apiUrl = resolveApiUrl(entry);
      return apiUrl ? { url: apiUrl } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const apiUrl = resolveApiUrl(entry);
    if (!apiUrl) throw new Error(`lever: cannot derive API URL for ${entry.name}`);
    assertLeverUrl(apiUrl);
    const json = await fetchJsonWithRetry(
      ctx,
      apiUrl,
      { timeoutMs: LEVER_TIMEOUT_MS, redirect: 'error' },
      { retries: LEVER_RETRIES },
    );
    if (!Array.isArray(json)) return [];
    return json.map(j => ({
      title: j.text || '',
      url: j.hostedUrl || '',
      company: entry.name,
      location: resolveLocation(j.categories),
      // Lever's v0 postings list ships the full description for free (same
      // payload, no per-job request) — enables scan.mjs content_filter.
      description: typeof j.descriptionPlain === 'string' ? j.descriptionPlain : '',
      postedAt: typeof j.createdAt === 'number' ? j.createdAt : undefined,
    }));
  },
};
