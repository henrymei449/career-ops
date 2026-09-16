// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Pinpoint provider — hits the public per-tenant postings.json feed.
// Auto-detects from careers_url pattern `https://<slug>.pinpointhq.com`.
//
// Pinpoint's postings.json is public, zero-auth and returns every active
// posting for the tenant in a single call:
//   https://<slug>.pinpointhq.com/postings.json
// Response shape: { data: [ { title, url, path, location: { name, city,
//   province, ... }, job: { department, division, ... }, compensation, ... } ] }
//
// Per-tenant subdomains are the variable part — SSRF defence uses a regex
// match on `<safe-slug>.pinpointhq.com` rather than a static allowlist, the
// same approach as the recruitee provider.
//
// Some tenants front the same postings.json feed on their own branded domain
// instead of <slug>.pinpointhq.com (e.g. careers.infor.com/postings.json,
// confirmed live 2026-09-16). An auto-detected careers_url must still match
// PINPOINT_HOST_RE — that regex is the only SSRF guard on an arbitrary
// scraped/imported URL. An explicit `api:` is different: it is operator-typed
// portals.yml config, not auto-detected, so it is trusted the same way
// successfactors.mjs trusts an explicit branded-host `api:`/`careers_url`
// with no host allowlist at all — https: is still required.

// The tenant label must be a valid DNS label: it may contain hyphens but must
// not start or end with one (so `acme-.pinpointhq.com` is rejected). The
// optional trailing group keeps single-character labels (e.g. `a.pinpointhq.com`)
// valid. Only the auto-detected (careers_url-derived) path routes through
// this constant — an explicit `api:` bypasses it (see resolveApiUrl).
const PINPOINT_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pinpointhq\.com$/;

/** @param {string} url */
function assertHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`pinpoint: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`pinpoint: URL must use HTTPS: ${url}`);
  return url;
}

function resolveApiUrl(entry) {
  // Explicit api: wins and bypasses the pinpointhq.com host check — trusted
  // operator config for a tenant on its own branded domain (see header note).
  if (typeof entry.api === 'string' && entry.api) {
    return assertHttpsUrl(entry.api);
  }
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!PINPOINT_HOST_RE.test(parsed.hostname)) return null;
  return `https://${parsed.hostname}/postings.json`;
}

/** @type {Provider} */
export default {
  id: 'pinpoint',

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
    if (!apiUrl) throw new Error(`pinpoint: cannot derive API URL for ${entry.name}`);
    // redirect:'error' prevents SSRF via server-side redirects
    const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
    return parsePinpointResponse(json, entry.name);
  },
};

/**
 * Parse a Pinpoint /postings.json response. Exported for unit tests.
 *
 * Pinpoint returns:
 *   { data: [{ title, url, path, location: { name, city, province, ... }, ... }] }
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed.
 *   - url:      `url` — an absolute posting URL on the tenant's own
 *               `<slug>.pinpointhq.com` host. It is display-only (written to the
 *               pipeline and scan history, never server-fetched here), so it is
 *               not host-locked; the requirement is a well-formed `https:` URL.
 *   - location: prefer the display `location.name`; otherwise assemble from
 *               `location.city` / `location.province`.
 *   - company:  the source carries no per-posting company name (each feed is a
 *               single tenant), so it is sourced from the portal entry name,
 *               mirroring the recruitee provider.
 *
 * Rows missing a usable title or a valid `https:` URL are dropped — an empty
 * URL would corrupt the scanner's URL-based dedup key.
 *
 * @param {any} json
 * @param {string} companyName
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parsePinpointResponse(json, companyName) {
  const postings = json?.data;
  if (!Array.isArray(postings)) return [];
  return postings
    .map(j => {
      const title = typeof j?.title === 'string' ? j.title.trim() : '';
      if (!title) return null;

      // url: require a well-formed https: URL (display-only; see doc above).
      let url = '';
      const rawUrl = typeof j?.url === 'string' ? j.url.trim() : '';
      if (rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'https:') url = parsed.href;
        } catch {
          // malformed URL → leave url = '' → dropped below
        }
      }
      if (!url) return null;

      // location: prefer the display name, else assemble from city/province.
      const loc = j?.location && typeof j.location === 'object' ? j.location : {};
      const name = typeof loc.name === 'string' ? loc.name.trim() : '';
      const city = typeof loc.city === 'string' ? loc.city.trim() : '';
      const province = typeof loc.province === 'string' ? loc.province.trim() : '';
      const location = name || [city, province].filter(Boolean).join(', ');

      return { title, url, location, company: companyName };
    })
    .filter(Boolean);
}
