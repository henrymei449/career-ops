// output/location-tier.mjs — location-tier classifier for the targeted-company
// dry-run CSV export ONLY. Not part of career-ops' core location_filter
// (portals.yml, scan.mjs) — a separate, standalone heuristic for one custom
// export, built and tested on its own so it can be corrected without touching
// title filters, scoring, providers, or any in-scope profile/CV content.
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
const KNOWN_NON_US_CITIES = ['warsaw', 'cluj napoca', 'bucharest', 'bengaluru', 'hsinchu', 'tokyo', 'riyadh', 'montevideo', 'bogota', 'ottawa'];

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

// Pure local string parsing of a Workday job URL's `/job/{Location-Slug}/`
// path segment — no network call. Mirrors scan.mjs's own locationHintFromUrl.
export function workdayUrlHint(url) {
  const m = String(url || '').match(/\/job\/([^/]+)\//);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).replace(/-/g, ' '); } catch { return m[1].replace(/-/g, ' '); }
}
