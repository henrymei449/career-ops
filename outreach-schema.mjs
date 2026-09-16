// outreach-schema.mjs — pure data/validation/heuristic functions for the
// Pass 2 outreach lifecycle (APPLIED -> outreach decision -> contact
// discovery -> human selection). No filesystem access here, mirroring
// review-schema.mjs's split: outreach.mjs (the lifecycle/CLI/state layer)
// and its tests both depend on one definition of "what a valid outreach
// record is" and "how a raw search result becomes a candidate."
//
// Kept as a genuinely separate dimension from review-schema.mjs's
// FIT_DECISIONS/EXECUTION_STATUSES per the task's core design principle:
// fit decision, application execution, and outreach never collapse into one
// status field.

import { normalizeCompany } from './tracker-utils.mjs';
import { PERSONA_FAMILIES, classifyRoleFamily } from './lib/outreach-personas.mjs';

export { classifyRoleFamily };

export const OUTREACH_DECISIONS = ['PENDING', 'REQUIRED', 'OPTIONAL', 'WAIVED'];
export const OUTREACH_STATUSES = ['NOT_STARTED', 'SEARCH_REQUIRED', 'CANDIDATES_FOUND', 'CONTACTS_SELECTED', 'COMPLETE'];
export const LANES = ['RECRUITING', 'FUNCTIONAL'];

// Decision -> initial status mapping (the outreach decision semantics from
// the task spec). Absence must never mean WAIVED — every call site that
// creates an outreach record uses freshOutreach(), whose decision is always
// the explicit sentinel 'PENDING', never inferred.
export const DECISION_INITIAL_STATUS = {
  REQUIRED: 'SEARCH_REQUIRED',
  OPTIONAL: 'NOT_STARTED',
  WAIVED: 'COMPLETE',
};

const MAX_CANDIDATES_PER_LANE = 3;

/**
 * Fresh outreach sub-object for a job that has just been marked APPLIED.
 * decision is always the explicit PENDING sentinel — never null/undefined —
 * so "not yet decided" is never confused with "decided nothing is needed."
 */
export function freshOutreach() {
  return {
    decision: 'PENDING',
    status: 'NOT_STARTED',
    candidates: [],
    selected_contacts: [],
  };
}

/**
 * Structural validation for an outreach sub-object. Returns a flat list of
 * human-readable errors; [] means valid.
 *
 * @param {object} outreach
 * @returns {string[]}
 */
export function validateOutreach(outreach) {
  const errors = [];
  if (!outreach || typeof outreach !== 'object') return ['outreach is not an object'];
  if (!OUTREACH_DECISIONS.includes(outreach.decision)) errors.push(`invalid outreach.decision: ${outreach.decision}`);
  if (!OUTREACH_STATUSES.includes(outreach.status)) errors.push(`invalid outreach.status: ${outreach.status}`);
  if (!Array.isArray(outreach.candidates)) errors.push('outreach.candidates is not an array');
  if (!Array.isArray(outreach.selected_contacts)) errors.push('outreach.selected_contacts is not an array');
  (outreach.candidates || []).forEach((c, i) => {
    const cErrors = validateCandidate(c);
    cErrors.forEach((e) => errors.push(`candidates[${i}]: ${e}`));
  });
  return errors;
}

/**
 * Structural validation for one candidate record. No email/phone fields are
 * ever expected — enrichment is explicitly out of scope for this MVP.
 */
export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== 'object') return ['candidate is not an object'];
  if (!candidate.candidate_id) errors.push('missing candidate_id');
  if (!candidate.name) errors.push('missing name');
  if (!LANES.includes(candidate.lane)) errors.push(`invalid lane: ${candidate.lane}`);
  if (typeof candidate.score !== 'number') errors.push('score is not a number');
  return errors;
}

// ── Query generation ────────────────────────────────────────────────────

/**
 * Chunk an array into groups of `size`, joined with ' OR ' inside quotes —
 * mirrors the task spec's example queries, which group 2 title variants per
 * query rather than issuing one query per title.
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function titleGroupClause(titles) {
  return `(${titles.map((t) => `"${t}"`).join(' OR ')})`;
}

/**
 * Build public-web people-search queries for a company + persona family.
 * Returns an array of {lane, query} — never executes anything; outreach.mjs
 * hands each query to an injected search provider.
 *
 * @param {{company: string, persona: string}} opts - persona is a key of
 *   PERSONA_FAMILIES (e.g. from classifyRoleFamily).
 * @returns {{lane: 'RECRUITING'|'FUNCTIONAL', query: string}[]}
 */
export function buildDiscoveryQueries({ company, persona }) {
  const family = PERSONA_FAMILIES[persona] || PERSONA_FAMILIES.GENERIC_TECHNICAL_COMMERCIAL;
  const companyClause = `"${String(company ?? '').trim()}"`;
  const queries = [];
  for (const group of chunk(family.recruiting, 2)) {
    queries.push({ lane: 'RECRUITING', query: `site:linkedin.com/in ${companyClause} ${titleGroupClause(group)}` });
  }
  for (const group of chunk(family.functional, 2)) {
    queries.push({ lane: 'FUNCTIONAL', query: `site:linkedin.com/in ${companyClause} ${titleGroupClause(group)}` });
  }
  return queries;
}

// ── Candidate normalization ─────────────────────────────────────────────

const FORMER_RE = /\b(former|ex-|alumni|alumnus|previously at|past employee)\b/i;

/**
 * Parse a "Name - Title - Company | LinkedIn" style search-result title into
 * its parts. Deliberately tolerant of fewer segments — a raw result with
 * just "Name | LinkedIn" still yields a name, with title/company left blank
 * for the caller's context to fill in.
 *
 * @param {string} rawTitle
 * @returns {{name: string, title: string, company: string}}
 */
export function parseSearchResultTitle(rawTitle) {
  const segments = String(rawTitle ?? '')
    .split(/\s+[-|]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^linkedin$/i.test(s));
  return {
    name: segments[0] || '',
    title: segments[1] || '',
    company: segments[2] || '',
  };
}

/**
 * Normalize one raw search-result item into a candidate record, or null if
 * it is deterministically not a usable candidate (not a personal profile
 * URL, or a clear "former employee" signal). Wrong-company rejection is
 * intentionally conservative: only rejects when the parsed title names a
 * DIFFERENT specific company than the target — an unparseable/blank company
 * is left for ranking to treat as low-confidence, not rejected outright.
 *
 * @param {{title?: string, url?: string, snippet?: string}} raw
 * @param {{company: string, lane: 'RECRUITING'|'FUNCTIONAL'}} context
 * @returns {object|null}
 */
export function normalizeCandidate(raw, { company, lane }) {
  const url = String(raw?.url ?? '').trim();
  if (!/linkedin\.com\/in\//i.test(url)) return null;

  const text = `${raw?.title ?? ''} ${raw?.snippet ?? ''}`;
  if (FORMER_RE.test(text)) return null;

  const parsed = parseSearchResultTitle(raw?.title ?? '');
  if (!parsed.name) return null;

  const targetKey = normalizeCompany(company);
  const parsedKey = normalizeCompany(parsed.company);
  if (parsedKey && targetKey && parsedKey !== targetKey) return null;

  const cleanUrl = url.split('?')[0].replace(/\/+$/, '');
  return {
    candidate_id: candidateId(cleanUrl || parsed.name + company),
    name: parsed.name,
    title: parsed.title || '',
    company: parsed.company || company || '',
    linkedin_url: cleanUrl,
    lane,
    source: 'WEB_SEARCH',
    score: 0, // filled in by rankCandidates
  };
}

/** Short, stable local id derived from the candidate's identity string. */
export function candidateId(identity) {
  let h = 0;
  const s = String(identity ?? '');
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `cand-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Dedup candidates by linkedin_url (falling back to name+company). */
export function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = c.linkedin_url || `${normalizeCompany(c.name)}::${normalizeCompany(c.company)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── Ranking ──────────────────────────────────────────────────────────────

const RECRUITER_RE = /recruit|talent acquisition|talent partner/i;
const SENIOR_FUNCTIONAL_RE = /director|head|principal|lead|manager|vp\b/i;

/**
 * Transparent, additive scoring heuristic (0-100, capped). Never a black
 * box: every point added corresponds to one signal from the task's own
 * ranking table. The operator still chooses the actual contacts — this only
 * orders the candidates so the top 3 per lane are worth showing.
 *
 * @param {object} candidate - A normalizeCandidate() output.
 * @param {{company: string, persona: string}} context
 * @returns {number}
 */
export function scoreCandidate(candidate, { company, persona }) {
  let score = 0;
  const companyMatches = normalizeCompany(candidate.company) === normalizeCompany(company);
  score += companyMatches ? 40 : (candidate.company ? 0 : 10);

  const family = PERSONA_FAMILIES[persona] || PERSONA_FAMILIES.GENERIC_TECHNICAL_COMMERCIAL;
  const laneTitles = candidate.lane === 'RECRUITING' ? family.recruiting : family.functional;
  const titleLower = candidate.title.toLowerCase();
  if (laneTitles.some((t) => titleLower.includes(t.toLowerCase()))) score += 35;

  if (candidate.lane === 'RECRUITING' && RECRUITER_RE.test(candidate.title)) score += 15;
  if (candidate.lane === 'FUNCTIONAL' && SENIOR_FUNCTIONAL_RE.test(candidate.title)) score += 10;

  return Math.min(100, score);
}

/**
 * Score, sort (descending, stable), and cap candidates to
 * MAX_CANDIDATES_PER_LANE per lane. Returns a flat array (recruiting first,
 * then functional) ready to persist as outreach.candidates.
 *
 * @param {object[]} candidates - Deduped normalizeCandidate() outputs.
 * @param {{company: string, persona: string}} context
 * @returns {object[]}
 */
export function rankCandidates(candidates, context) {
  const scored = candidates.map((c) => ({ ...c, score: scoreCandidate(c, context) }));
  const byLane = (lane) => scored
    .filter((c) => c.lane === lane)
    .map((c, i) => ({ c, i })) // stable sort: keep original order as tiebreaker
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .slice(0, MAX_CANDIDATES_PER_LANE)
    .map(({ c }) => c);
  return [...byLane('RECRUITING'), ...byLane('FUNCTIONAL')];
}
