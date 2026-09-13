// output/location-tier.mjs — location-tier classifier for the targeted-company
// dry-run CSV export, and (via classifyStructuredWorkplace below) scan.mjs's
// structured-workplace-metadata gate for actors that return real
// remote/onsite/hybrid fields (currently: curious_coder/linkedin-jobs-scraper
// via plugins/apify). Not part of career-ops' core `location_filter`
// (portals.yml's own text-substring config, still evaluated separately and
// unchanged in scan.mjs) — this module supplies the NYC-actionability
// judgment both consumers need, built and tested on its own so it can be
// corrected without touching title filters, scoring, providers, or any
// in-scope profile/CV content.
//
// Canonical policy (2026-09-07, per user directive): tiers reflect actionable
// geography for Henry (NYC-based), not raw US-vs-non-US. Tier 3 means "needs
// location validation" — it is a separate low-confidence bucket, never
// equivalent to a resolved Tier 4/5 role. Unknown/missing location is NEVER
// inferred from company headquarters.

// NYC metro: five boroughs, Nassau/western Long Island, Westchester, and
// realistically commutable northern/central NJ / southern CT. Bare "new york"
// (not just "new york city") matches deliberately: ATS location fields in
// this dataset write it as the CITY segment of "City, ST" / "Country, ST,
// City" ("New York, NY", "United States, NY, New York"), which is
// unambiguous. This does not distinguish an upstate "Rochester, New York"
// mention — not a case seen in this dataset — from the city; tighten if one
// turns up.
const NYC_METRO_RE = /new york city|\bnew york\b|manhattan|\bbrooklyn\b|\bqueens\b|\bbronx\b|staten island|\bnyc\b|nassau county|long island|westchester/i;
const NJ_COMMUTABLE_RE = /new jersey|\bnj\b|\bnewark\b|jersey city|hoboken|hudson county|bergen county|essex county|union county/i;
const CT_COMMUTABLE_RE = /fairfield county|\bstamford\b|\bgreenwich\b|\bnorwalk\b|southern connecticut/i;

const US_STATE_ABBR = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']);

// Non-US country/region names actually needed to disambiguate this dataset's
// free-text ATS location fields. Deliberately a short, explicit list (not a
// gazetteer) — a 2-letter USPS match ("MI") is meaningless once one of these
// is present ("Italy, MI, Segrate" is Milano, not Michigan).
const NON_US_COUNTRY_RE = /\bitaly\b|\bcanada\b|\bontario\b|\bquebec\b|\baustralia\b|\bjapan\b|\btaiwan\b|saudi arabia|\buruguay\b|\bcolombia\b|\bindia\b|\bpoland\b|\bromania\b|united kingdom|\bgermany\b|\bchina\b|\bmexico\b|\bbrazil\b|\bsingapore\b|\bireland\b|netherlands|\bspain\b|\bfrance\b/i;

// Bare city names (no state/country label in the source string) known from
// this dataset to be outside the US.
const KNOWN_NON_US_CITIES = [
  'warsaw', 'cluj napoca', 'bucharest', 'bengaluru', 'hsinchu', 'tokyo', 'riyadh', 'montevideo', 'bogota', 'ottawa',
  // Added from real reverse-ATS captures classifying as Tier 3 (needs
  // validation) instead of Tier 1 (excluded) -- confirmed via a real
  // semantic-recall sample: "NOIDA" (Cadence) and "Toronto, ON, CAN"
  // (Autodesk, where "ON"/"CAN" abbreviations don't match the full-word
  // country regex) both slipped past the classifier undetected.
  'toronto', 'noida', 'zhubei', 'belo horizonte',
];

// Bare city names known to be US, with no state/country token in the source
// string — needed so a plain "SAN JOSE" / "Kalamazoo" resolves without a
// state suffix. Extend as new cases turn up; never used to override an
// explicit non-US signal (isNonUs() runs first).
const KNOWN_US_CITIES = ['san jose', 'chicago', 'atlanta', 'kalamazoo', 'davenport', 'memphis', 'beverly'];

const US_COUNTRY_RE = /united states|\bu\.?s\.?a\.?\b/i;
const REMOTE_RE = /\bremote\b/i;

function isBareUnitedStates(loc) {
  const t = String(loc || '').trim().toLowerCase();
  return t === 'united states' || t === 'us' || t === 'usa' || t === 'u.s.' || t === 'u.s.a.';
}

function isVagueOrMissing(loc) {
  const t = String(loc || '').trim().toLowerCase();
  return t === '' || t === 'n/a' || /^\d+\s+locations?$/i.test(t);
}

function isNonUs(text) {
  if (NON_US_COUNTRY_RE.test(text)) return true;
  const lower = text.toLowerCase();
  return KNOWN_NON_US_CITIES.some((c) => lower.includes(c));
}

function isNycMetro(text) {
  return NYC_METRO_RE.test(text) || NJ_COMMUTABLE_RE.test(text) || CT_COMMUTABLE_RE.test(text);
}

function hasExplicitUsSignal(loc, urlHint) {
  const text = `${loc} ${urlHint}`;
  if (US_COUNTRY_RE.test(text)) return true;
  const abbrevMatches = text.match(/\b([A-Z]{2})\b/g);
  if (abbrevMatches && abbrevMatches.some((a) => US_STATE_ABBR.has(a))) return true;
  const lower = text.toLowerCase();
  return KNOWN_US_CITIES.some((c) => lower.includes(c));
}

/**
 * Classify one job's geography against the canonical NYC-actionability policy.
 *
 * @param {{location?: string, title?: string, urlHint?: string}} job -
 *   `location` is the ATS-provided display string; `urlHint` is text already
 *   recovered from the job's own URL path (e.g. Workday's
 *   `/job/{Location-Slug}/` segment) — pure local string parsing, never a
 *   network fetch. `title` is checked for a "Remote" marker, since some ATSs
 *   state remoteness there instead of in location.
 * @returns {{tier: number, usRelevant: 'TRUE'|'FALSE'|'UNKNOWN', remoteUS: boolean,
 *   nycMetro: boolean, needsValidation: boolean, actionable: boolean, bucket: string}}
 */
export function classifyLocation({ location = '', title = '', urlHint = '' } = {}) {
  const loc = String(location || '');
  const text = `${loc} ${urlHint}`;
  const remote = REMOTE_RE.test(text) || REMOTE_RE.test(title);

  // Non-US is always Tier 1, unconditionally — checked first so no later
  // rule (remote, vague-string fallback) can accidentally rescue it.
  if (isNonUs(text)) {
    return { tier: 1, usRelevant: 'FALSE', remoteUS: false, nycMetro: false, needsValidation: false, actionable: false, bucket: 'excluded' };
  }

  if (isNycMetro(text)) {
    return { tier: 5, usRelevant: 'TRUE', remoteUS: remote, nycMetro: true, needsValidation: false, actionable: true, bucket: 'primary' };
  }

  // "Fully remote anywhere in the United States" — requires an explicit US
  // signal alongside "remote", not just the absence of a foreign one (a bare
  // "Remote" with zero other clues could be remote-from-anywhere and stays
  // Tier 3 / needs-validation instead of being assumed US).
  if (remote && US_COUNTRY_RE.test(text)) {
    return { tier: 5, usRelevant: 'TRUE', remoteUS: true, nycMetro: false, needsValidation: false, actionable: true, bucket: 'primary' };
  }

  // Bare "United States"/"US" or a genuinely vague/missing location (N/A,
  // "N Locations" with no resolved place) — needs validation, never inferred
  // favorably. Checked before the general US-signal branch so a BARE country
  // token doesn't fall through to Tier 2 as if it were a specific place.
  if (isBareUnitedStates(loc) || isVagueOrMissing(loc)) {
    return { tier: 3, usRelevant: 'UNKNOWN', remoteUS: false, nycMetro: false, needsValidation: true, actionable: false, bucket: 'needs-validation' };
  }

  // A specific, resolvable US place that isn't NYC metro — confirmed Tier 2.
  if (hasExplicitUsSignal(loc, urlHint)) {
    return { tier: 2, usRelevant: 'TRUE', remoteUS: false, nycMetro: false, needsValidation: false, actionable: true, bucket: 'location-friction' };
  }

  // No US signal, no non-US signal, not a recognized vague form (e.g. free
  // text this classifier doesn't recognize) — unknown, not favorable.
  return { tier: 3, usRelevant: 'UNKNOWN', remoteUS: false, nycMetro: false, needsValidation: true, actionable: false, bucket: 'needs-validation' };
}

// ── Actual CareerOps geography policy (2026-09-13) ─────────────────────────
//
// An opportunity is actionable ONLY if it is (1) confirmed Remote U.S., or
// (2) onsite/hybrid inside the EXISTING approved NYC-compatible geography
// (classifyLocation's nycMetro boundaries, unchanged, never broadened here).
// Everything else is REJECT. There is no more "lower-priority US geography"
// concept — a confirmed onsite/hybrid US posting outside NYC used to be
// permissively passed through (portals.yml's location_filter is unconfigured
// in production, so it defaulted to "all locations pass") or surfaced as a
// MARGINAL report row; neither of those is a real decision under this
// policy. classifyLocation's numeric `tier` field (1-5) is kept ONLY as
// legacy metadata for its original consumer (the targeted-company dry-run
// CSV export) and any other exporter that reads it — it MUST NOT be branched
// on here or anywhere in this policy. Decisions below read only the
// semantic `bucket` field (itself derived from the same tier boundaries,
// just not the ranked-priority number) and the `remoteUS`/`nycMetro` flags.
//
// Four explicit decision states (never inferred from an absent field):
//   REMOTE_US        — confirmed remote, US-eligible. Physical job/company
//                       location outside NYC never matters for this state.
//   NYC_COMPATIBLE   — onsite/hybrid inside the existing NYC-actionable
//                       geography (classifyLocation bucket 'primary' via
//                       nycMetro, NOT via its remoteUS branch — that's
//                       REMOTE_US instead, see classifyLocationFallback).
//   UNKNOWN          — evidence genuinely cannot establish REMOTE_US,
//                       NYC_COMPATIBLE, or REJECT (e.g. bare "United
//                       States", absent/conflicting workplace metadata).
//                       A real, testable return value of these pure
//                       functions — but see classifyGeography() below and
//                       scan.mjs's own wiring: an UNKNOWN that survives
//                       BOTH classification stages is never treated as
//                       accepted by the pipeline, exactly like REJECT.
//   REJECT           — clearly non-US, OR a confirmed onsite/hybrid US
//                       location outside NYC-compatible geography (no
//                       exceptions for "still pretty good" geography).
//
// curious_coder/linkedin-jobs-scraper returns `workRemoteAllowed` (boolean)
// and `workplaceTypes` (string/array, e.g. "Remote"/"On-site"/"Hybrid") per
// job — real, actor-native signal, never inferred from JD text. Every other
// provider, and any LinkedIn job the actor didn't tag, leaves both fields
// unset on the job object (see plugins/apify/index.mjs's normalizeItem), so
// classifyStructuredWorkplace() below is UNKNOWN for those — a strict
// deferral to classifyLocationFallback(), never a fabricated decision.
const WORKPLACE_REMOTE_RE = /remote/i;
const WORKPLACE_ONSITE_RE = /on[\s-]?site/i;
const WORKPLACE_HYBRID_RE = /hybrid/i;

function normalizeWorkplaceTypes(value) {
  if (Array.isArray(value)) return value.map(v => String(v || ''));
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

/**
 * Stage 1 — structured actor metadata, when present. Returns UNKNOWN (never
 * REJECT) whenever the job carries no workRemoteAllowed/workplaceTypes
 * signal at all, or a conflicting one (e.g. both Remote and On-site
 * listed) — UNKNOWN means "defer to classifyLocationFallback," nothing more.
 *
 * @param {{location?: string, title?: string, urlHint?: string,
 *   workRemoteAllowed?: boolean, workplaceTypes?: string|string[]}} job
 * @returns {{state: 'REMOTE_US'|'NYC_COMPATIBLE'|'REJECT'|'UNKNOWN', reason: string}}
 */
export function classifyStructuredWorkplace(job = {}) {
  const types = normalizeWorkplaceTypes(job.workplaceTypes);
  const remoteAllowed = job.workRemoteAllowed === true;
  const hasRemoteSignal = remoteAllowed || types.some(t => WORKPLACE_REMOTE_RE.test(t));
  const hasOnsiteOrHybridSignal = types.some(t => WORKPLACE_ONSITE_RE.test(t) || WORKPLACE_HYBRID_RE.test(t));

  if (!hasRemoteSignal && !hasOnsiteOrHybridSignal) {
    return { state: 'UNKNOWN', reason: 'no-structured-workplace-signal' };
  }
  if (hasRemoteSignal && hasOnsiteOrHybridSignal) {
    return { state: 'UNKNOWN', reason: 'conflicting-workplace-signals' };
  }

  // Non-US is checked here, same as classifyLocation's own ordering (#2789-
  // era policy comment above), so a "Remote" tag on a clearly non-US posting
  // can never rescue it — but ONLY once we already know the job carries a
  // real structured workplace signal (never a bare location-only check,
  // which is classifyLocationFallback's job, not this function's).
  const location = classifyLocation({ location: job.location, title: job.title, urlHint: job.urlHint });
  if (location.bucket === 'excluded') {
    return { state: 'REJECT', reason: 'non-us-location' };
  }
  if (hasRemoteSignal) {
    return { state: 'REMOTE_US', reason: 'structured-remote' };
  }
  // hasOnsiteOrHybridSignal, mutually exclusive with hasRemoteSignal above.
  return location.bucket === 'primary'
    ? { state: 'NYC_COMPATIBLE', reason: 'structured-onsite-hybrid-nyc-actionable' }
    : { state: 'REJECT', reason: 'structured-onsite-hybrid-outside-nyc' };
}

/**
 * Stage 2 — the "fallback location/geography validation" that runs ONLY
 * when classifyStructuredWorkplace() returned UNKNOWN. Bare-location
 * classification via the EXISTING classifyLocation() boundaries (unchanged,
 * never broadened) — no numeric-tier branching, per the policy note above.
 *
 * Mapping (bucket -> state), exhaustive:
 *   'excluded'          -> REJECT (clearly non-US)
 *   'primary', remoteUS -> REMOTE_US ("Remote - United States"-shaped text)
 *   'primary', nycMetro -> NYC_COMPATIBLE (a plain NYC-metro/commutable city)
 *   'location-friction' -> REJECT (confirmed US, but outside NYC-compatible
 *                          geography, and no remote signal at either stage —
 *                          this is the actual policy change: there is no
 *                          more "confirmed US, lower priority" pass-through)
 *   'needs-validation'  -> UNKNOWN (bare "United States", vague strings —
 *                          evidence genuinely insufficient either way)
 *
 * @returns {{state: 'REMOTE_US'|'NYC_COMPATIBLE'|'REJECT'|'UNKNOWN', reason: string}}
 */
export function classifyLocationFallback(job = {}) {
  const location = classifyLocation({ location: job.location, title: job.title, urlHint: job.urlHint });
  switch (location.bucket) {
    case 'excluded':
      return { state: 'REJECT', reason: 'non-us-location' };
    case 'primary':
      return location.remoteUS
        ? { state: 'REMOTE_US', reason: 'location-tier-remote-us-text' }
        : { state: 'NYC_COMPATIBLE', reason: 'location-tier-nyc-metro' };
    case 'location-friction':
      return { state: 'REJECT', reason: 'location-tier-us-non-nyc' };
    case 'needs-validation':
    default:
      return { state: 'UNKNOWN', reason: 'location-tier-needs-validation' };
  }
}

/**
 * The combined gate scan.mjs actually calls: stage 1, then (only if stage 1
 * is genuinely UNKNOWN) stage 2. The return value can still be UNKNOWN (see
 * the module note above) — scan.mjs's own wiring is what ensures an UNKNOWN
 * final state is never treated as accepted, exactly like REJECT.
 *
 * @returns {{state: 'REMOTE_US'|'NYC_COMPATIBLE'|'REJECT'|'UNKNOWN', reason: string}}
 */
export function classifyGeography(job = {}) {
  const structured = classifyStructuredWorkplace(job);
  if (structured.state !== 'UNKNOWN') return structured;
  return classifyLocationFallback(job);
}

// Pure local string parsing of a Workday job URL's `/job/{Location-Slug}/`
// path segment — no network call. Mirrors scan.mjs's own locationHintFromUrl.
export function workdayUrlHint(url) {
  const m = String(url || '').match(/\/job\/([^/]+)\//);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).replace(/-/g, ' '); } catch { return m[1].replace(/-/g, ' '); }
}
