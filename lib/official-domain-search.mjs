// lib/official-domain-search.mjs — isolated, query-first fallback method for
// companies with no provider-backed scan (method-validation only; NOT wired
// into scan.mjs, source-run.mjs, review, reports, or any scheduler).
//
// Pipeline: domain-restricted queries -> scope filter -> canonicalize ->
// dedupe -> lightweight URL/title screen -> (caller) sample-fetch -> extract.
//
// Deliberately NOT here: crawling, pagination, link traversal, inventory
// enumeration, title/geography filtering. The searcher is injected
// (`(query) => Promise<[{title,url,snippet}]>`, the same shape as
// lib/outreach-search-serper.mjs's serperSearch), so this module owns only
// bounding, scoping, canonicalization and screening.

import { normalizeUrl } from '../url-key.mjs';

/**
 * @typedef {object} DomainProfile
 * @property {string} host              exact official/ATS host, lowercase
 * @property {string} [pathPrefix]      required path prefix ('/recruiting/onto'); tenant scope on shared ATS hosts
 * @property {string[]} [keepParams]    ONLY these query params survive canonicalization (functional ids); default: none
 * @property {RegExp} jobPathRe         path(+query) shape of an individual posting
 * @property {RegExp} [nonJobPathRe]    path shapes that are never a posting
 * @property {RegExp} [reqIdRe]         capture group 1 = requisition id; when set, dedupe is by id (case-insensitive), not URL
 * @property {RegExp} [stripPathSuffixRe] trailing path segment removed before canonicalizing (e.g. /apply)
 * @property {boolean} [lowercasePath]  lowercase the path (only for ATSes whose paths are case-insensitive)
 * @property {RegExp} [preferRe]        when two URLs share a requisition id, the one matching this is kept
 * @property {string} [queryScope]      site: scope used in the QUERY only (default host+pathPrefix); lets a query span locale paths while inScope() still enforces the host
 * @property {boolean} [requireJsonLd] page is live only if a schema.org JobPosting payload is present (Workday shells carry none)
 * @property {boolean} [bodyLocation]   allow the conservative body-text location extractor when no structured location exists
 * @property {string} [queryExtra]      literal marker added to every query (e.g. '"job-specification"') to steer results to posting pages
 */

/** `site:` query for a profile + term. */
export function buildSiteQuery(profile, term) {
  const scope = profile.queryScope || (profile.host + (profile.pathPrefix || ''));
  return `site:${scope} ${profile.queryExtra ? profile.queryExtra + ' ' : ''}${term}`;
}

/** Dedupe key: the requisition id when the profile defines one and it is present, else the canonical URL. */
export function dedupeKey(canonicalUrl, profile) {
  if (profile.reqIdRe) {
    const m = profile.reqIdRe.exec(canonicalUrl);
    if (m && m[1]) return `req:${m[1].toLowerCase()}`;
  }
  return canonicalUrl;
}

/** True when the URL is https?, on exactly profile.host, under pathPrefix. */
export function inScope(rawUrl, profile) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.hostname.toLowerCase() !== profile.host.toLowerCase()) return false;
  const prefix = (profile.pathPrefix || '').toLowerCase();
  return !prefix || u.pathname.toLowerCase().startsWith(prefix);
}

/**
 * Allowlist canonicalization: https, lowercase host, no fragment, no trailing
 * slash, and only `keepParams` query params (sorted). Tracking/analytics
 * params (ADP's __tx_annotation/rb/prc/c/d/sor, utm_*, ...) vanish by not
 * being on the allowlist. Returns '' for an unusable URL.
 */
export function canonicalizeJobUrl(rawUrl, profile) {
  let u;
  try { u = new URL(rawUrl); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const keep = new Set((profile.keepParams || []).map((p) => p.toLowerCase()));
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => keep.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const q = kept.length ? '?' + kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  let path = u.pathname.replace(/\/+$/, '');
  if (profile.stripPathSuffixRe) path = path.replace(profile.stripPathSuffixRe, '');
  if (profile.lowercasePath) path = path.toLowerCase();
  return `https://${u.hostname.toLowerCase()}${path}${q}`;
}

// Search-result titles that name a landing/listing page, not a posting.
const GENERIC_TITLE_RE = /^(career site|careers?|jobs?|open positions|search jobs|job search|home)(\s*[-–|]\s*(careers?|adp|adp myjobs|career site))*$/i;

/**
 * Lightweight screen from URL + search-result title only (no fetch).
 * @returns {{likelyJob: boolean, reason: string}}
 */
export function classifyJobUrl(rawUrl, profile, title = '') {
  let u;
  try { u = new URL(rawUrl); } catch { return { likelyJob: false, reason: 'unparseable' }; }
  const pathAndQuery = u.pathname + u.search;
  if (/\.(pdf|docx?|pptx?|xlsx?|zip)$/i.test(u.pathname)) return { likelyJob: false, reason: 'document' };
  if (profile.nonJobPathRe && profile.nonJobPathRe.test(pathAndQuery)) return { likelyJob: false, reason: 'non-job-path' };
  if (!profile.jobPathRe.test(pathAndQuery)) return { likelyJob: false, reason: 'no-job-url-shape' };
  if (title && GENERIC_TITLE_RE.test(title.trim())) return { likelyJob: false, reason: 'generic-title' };
  return { likelyJob: true, reason: 'job-url-shape' };
}

/**
 * Run the bounded query set. Never paginates: each query is one call, its
 * results sliced to `maxPerQuery`. Stops issuing queries once `maxUnique`
 * unique canonical in-scope URLs are held (coverageTruncated = true).
 *
 * @param {{search: (q:string)=>Promise<Array<{title?:string,url:string,snippet?:string}>>,
 *          profile: DomainProfile, terms: string[], maxPerQuery?: number, maxUnique?: number}} args
 */
export async function collectCandidates({ search, profile, terms, maxPerQuery = 20, maxUnique = 100 }) {
  const stats = {
    queries: 0, resultsReturned: 0, outOfScope: 0, unparseable: 0,
    duplicatesRemoved: 0, coverageTruncated: false,
  };
  /** @type {Map<string, {canonicalUrl:string, title:string, snippet:string, rawUrls:string[], queries:string[]}>} */
  const byCanon = new Map();

  for (const term of terms) {
    if (byCanon.size >= maxUnique) { stats.coverageTruncated = true; break; }
    const query = buildSiteQuery(profile, term);
    const results = (await search(query)).slice(0, maxPerQuery);
    stats.queries += 1;
    stats.resultsReturned += results.length;
    for (const r of results) {
      if (!inScope(r.url, profile)) { stats.outOfScope += 1; continue; }
      const canon = canonicalizeJobUrl(r.url, profile);
      if (!canon) { stats.unparseable += 1; continue; }
      const key = dedupeKey(canon, profile);
      const seen = byCanon.get(key);
      if (seen) {
        stats.duplicatesRemoved += 1;
        seen.rawUrls.push(r.url);
        if (!seen.queries.includes(term)) seen.queries.push(term);
        if (profile.preferRe && !profile.preferRe.test(seen.canonicalUrl) && profile.preferRe.test(canon)) {
          seen.canonicalUrl = canon;
          seen.title = r.title || seen.title;
        }
        continue;
      }
      if (byCanon.size >= maxUnique) { stats.coverageTruncated = true; break; }
      byCanon.set(key, { canonicalUrl: canon, title: r.title || '', snippet: r.snippet || '', rawUrls: [r.url], queries: [term] });
    }
  }

  const candidates = [...byCanon.values()].map((c) => ({ ...c, ...classifyJobUrl(c.canonicalUrl, profile, c.title) }));
  return { stats, candidates };
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function locationFromJsonLd(jp) {
  const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
  const a = loc && loc.address;
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.addressLocality, a.addressRegion, a.addressCountry && (a.addressCountry.name || a.addressCountry)]
    .filter(Boolean).join(', ');
}

/**
 * Extract company-agnostic posting fields from fetched HTML. Order:
 * schema.org JobPosting JSON-LD (high) -> og:title / <title> (low). Never
 * infers a missing location; reports 'unavailable'.
 * @returns {{title: string, location: string, confidence: 'high'|'low'|'none', method: string}}
 */
export function extractJobFields(html) {
  const blocks = [...String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1]);
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      const jp = nodes.find((n) => n && (n['@type'] === 'JobPosting' || (Array.isArray(n['@type']) && n['@type'].includes('JobPosting'))));
      if (jp && jp.title) {
        return { title: decodeEntities(String(jp.title).trim()), location: locationFromJsonLd(jp) || 'unavailable', confidence: 'high', method: 'json-ld' };
      }
    } catch { /* malformed block: try the next */ }
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const raw = (h1 && h1[1].replace(/<[^>]+>/g, '').trim()) || (og && og[1]) || (t && t[1]);
  if (raw) return { title: decodeEntities(raw.replace(/\s+/g, ' ').trim()), location: 'unavailable', confidence: 'low', method: h1 ? 'h1' : og ? 'og:title' : 'title' };
  return { title: '', location: 'unavailable', confidence: 'none', method: 'none' };
}

const DEAD_TITLE_RE = /page not found|\b404\b|not found|no longer (available|open|accepting)|(position|job|posting|requisition) (has been )?(filled|closed|expired|removed)|does not exist|access denied/i;
const GENERIC_PAGE_TITLE_RE = /^(careers( at [\w .&-]+)?|career site|job specification|search for jobs|jobs?|home|open positions)(\s*[-–|]\s*[\w .&-]+)?$/i;

const US_STATES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
const US_ABBR = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const COUNTRIES = 'Germany|France|Sweden|Japan|China|India|United Kingdom|UK|Brazil|Taiwan|Vietnam|Singapore|Korea|Italy|Spain|Netherlands|Canada|Mexico|Poland|Czech Republic|Israel|Malaysia|Thailand';
const CITY = "[A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}";

function htmlToBodyText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' | ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * Conservative location extractor for server-rendered posting pages. Order:
 * (1) an explicit "Location:" style label, (2) "in|at <City>, <US state|abbr|country>"
 * prose. Anything else -> 'unavailable'. Never uses the URL/locale path and
 * never guesses from company office geography.
 * @returns {{location: string, method: string}}
 */
export function extractLocationFromBody(html) {
  const t = htmlToBodyText(html);
  const label = new RegExp(String.raw`(?:Job |Work |Position )?Locations?\s*[:\-–]\s*(${CITY}(?:,\s*(?:${US_STATES}|${US_ABBR}|${COUNTRIES}))?)`).exec(t);
  if (label) return { location: label[1].trim(), method: 'label' };
  const prose = new RegExp(String.raw`\b(?:in|at|located in|based in)\s+(?:the\s+)?(${CITY}),\s*(${US_STATES}|${US_ABBR}|${COUNTRIES})\b`).exec(t);
  if (prose) return { location: `${prose[1].trim()}, ${prose[2]}`, method: 'body-text' };
  return { location: 'unavailable', method: 'none' };
}

/**
 * Liveness + extraction verdict for one fetched page. A page is live only when
 * it yields a real job title (and, when the profile demands it, a structured
 * JobPosting payload). Dead/stale/generic pages are never jobs or survivors.
 * @param {{status: number, html?: string}} fetched
 * @param {DomainProfile} profile
 * @returns {{live: boolean, reason: string, title: string, location: string, confidence: string, method: string}}
 */
export function assessJobPage(fetched, profile) {
  const none = (reason) => ({ live: false, reason, title: '', location: 'unavailable', confidence: 'none', method: 'none' });
  if (!fetched || fetched.status === 404 || fetched.status === 410) return none('http-404');
  if (fetched.status < 200 || fetched.status >= 300) return none(`http-${fetched.status}`);
  const html = fetched.html || '';
  const f = extractJobFields(html);
  if (profile.requireJsonLd && f.method !== 'json-ld') return none('no-job-payload');
  if (!f.title) return none('no-title');
  if (DEAD_TITLE_RE.test(f.title)) return none('dead-page-title');
  if (GENERIC_PAGE_TITLE_RE.test(f.title.trim())) return none('generic-title');
  let { location } = f;
  let method = f.method;
  if (location === 'unavailable' && profile.bodyLocation) {
    const b = extractLocationFromBody(html);
    if (b.location !== 'unavailable') { location = b.location; method = `${f.method}+${b.method}`; }
  }
  return { live: true, reason: 'live', title: f.title, location, confidence: f.confidence, method };
}

export { normalizeUrl };
