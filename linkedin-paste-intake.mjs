#!/usr/bin/env node
/**
 * linkedin-paste-intake.mjs — manual LinkedIn search-results paste -> the
 * NORMAL Review batch.
 *
 * The operator selects-all on one or more LinkedIn job-search result pages,
 * pastes them (together) into the Review tab's paste box with the search
 * query and capture time, and gets an import receipt. This module is parse +
 * routing only — every qualification decision is an EXISTING contract:
 *
 *   identity / dedupe   review-schema.mjs computeJobKey (url-first, else the
 *                       scanner's company+role+location key), checked against
 *                       durable state + open/finalized/processed batches
 *                       (adhoc-intake.mjs findExistingJob + a company/role/
 *                       location index over the same files).
 *   application history durable APPLIED / NOT_APPLYING records, the tracker
 *                       (data/applications.md), and LinkedIn's own "Applied"
 *                       label on the card.
 *   suppression         durable PASS (review.mjs), data/blacklist.md
 *                       (scan.mjs loadBlacklist), discard.log
 *                       (discard-suppression.mjs, URL + SKIP_COMPANY).
 *   geography           review-schema.mjs computeGateEvidence ->
 *                       location-tier.mjs classifyGeography, with the SAME
 *                       actionable set scan.mjs gates survivors on.
 *   persistence         review.mjs createBatchFromJobs (source
 *                       'linkedin_paste'): an ordinary UNREVIEWED open batch,
 *                       so PASS / Resume Gate / Apply / finalize are untouched.
 *
 * URL resolution is bounded and never invents: a survivor gets an exact job
 * URL only from (1) a LinkedIn job id present in the paste itself (plain-text
 * URL, or the clipboard's HTML flavour captured by the paste box), (2) exactly
 * one matching URL in local history (scan-history.tsv, review batches), or
 * (3) exactly one matching card from a capped number of LinkedIn guest-search
 * requests. Zero or several candidates -> the job is added with url '' and
 * flagged for manual entry (setManualJobUrl), never guessed. Two cards that
 * carry DIFFERENT LinkedIn job ids are never merged, whatever their titles.
 *
 * Usage:
 *   node linkedin-paste-intake.mjs parse <file>          # parse only, JSON (no writes)
 *   node linkedin-paste-intake.mjs import <file> --query "..." [--captured-at ISO] [--dry-run]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import { normalizeUrl } from './url-key.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { atomicWriteFile, normalizeRoleForDedup, normalizeLocationForDedup, parseBlacklist } from './scan.mjs';
import { buildSuppressionIndexFromText, isSuppressed as isDiscardSuppressed } from './discard-suppression.mjs';
import { computeJobKey, computeGateEvidence, validateBatch } from './review-schema.mjs';
import { createBatchFromJobs, readJson, reviewPaths, defaultState } from './review.mjs';
import { findExistingJob } from './adhoc-intake.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';

const DATA_ROOT = getCareerOpsRoot();

export const BATCH_SOURCE = 'linkedin_paste';

// Same actionable set scan.mjs gates survivors on (see its geography gate:
// `geography.state !== 'REMOTE_US' && geography.state !== 'NYC_COMPATIBLE'`).
export const GEOGRAPHY_ACTIONABLE = ['REMOTE_US', 'NYC_COMPATIBLE'];

// Tracker statuses that mean "an application was sent" (templates/states.yml).
const TRACKER_APPLIED_STATES = new Set(['applied', 'responded', 'interview', 'offer', 'hired', 'rejected']);

// ── Parsing ────────────────────────────────────────────────────────────────

const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' ');
const US_STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico'];
const CA_PROVINCES = ['on', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe', 'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick', 'newfoundland and labrador', 'prince edward island'];
const COUNTRIES = ['united states', 'usa', 'canada', 'mexico', 'united kingdom', 'england', 'scotland', 'ireland', 'germany', 'france', 'netherlands', 'belgium', 'spain', 'portugal', 'italy', 'switzerland', 'austria', 'sweden', 'norway', 'denmark', 'finland', 'poland', 'czechia', 'romania', 'india', 'singapore', 'japan', 'china', 'australia', 'new zealand', 'brazil', 'argentina', 'colombia', 'chile', 'israel', 'united arab emirates', 'sri lanka', 'philippines', 'south africa', 'emea', 'apac', 'latam', 'americas', 'europe', 'north america'];
const PLACE_TAILS = new Set([...US_STATES.map((s) => s.toLowerCase()), ...US_STATE_NAMES, ...CA_PROVINCES, ...COUNTRIES]);
const AREA_RE = /\b(?:metropolitan area|metro area|bay area|metroplex|area)$|^greater\s+\S/i;
const ARRANGEMENT_SUFFIX_RE = /\s*\((remote|hybrid|on[- ]?site)\)\s*$/i;
const ARRANGEMENT_LINE_RE = /^(remote|hybrid|on[- ]?site)$/i;

const AGE_RE = /^(?:(?:re)?posted\s+(?:on\s+)?)?(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?\s+ago\b/i;
const AGE_TODAY_RE = /^(?:(?:re)?posted\s+)?(?:just now|today|moments ago)$/i;
const COMP_RE = /^\$\s?\d|^(?:USD|CA\$|C\$)\s?\d|\d(?:[.,]\d+)?\s?[Kk]?\/(?:yr|hr|year|hour|mo)\b/;
const LABEL_RE = /^(saved|viewed|applied)\b/i;
const VERIFICATION_RE = /^(.*?)\s+with verification$/i;
const JOB_ID_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#\s]*?-)?(\d{6,})|[?&]currentJobId=(\d{6,})/i;

// LinkedIn page chrome that can sit between (or inside) cards. Never a card
// field; only matters because it must not be mistaken for a title/company.
const NOISE_RE = /^(?:promoted|easy apply|actively reviewing applicants|be an early applicant|·|•|\d+ (?:applicants?|connections?|alumni).*|over \d+ applicants|.*\bwork(?:s)? here$|your profile matches.*|how you match|see how you compare.*|show all|show more|show less|set alert|jobs? search|search results|jobs you may be interested in|top job picks for you|recommended for you|are these results helpful\??|your feedback helps.*|\d[\d,]* results?|page \d+.*|next|previous|prev|…|\.\.\.|\d{1,3}|dismiss .*|hide .*|save|share|apply|message|about the job|about the company|premium|try premium.*|linkedin|home|my network|jobs|messaging|notifications|me|for business|skip to (?:search|main content)|\d+ benefits?|in network|verified|medical, vision, dental.*|401\(k\).*)$/i;

function cleanLine(raw) {
  return decodeEntities(String(raw).replace(/<[^>]*>/g, ' '))
    .replace(/[​-‍﻿]/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split "Dallas, TX (Remote)" -> {place: 'Dallas, TX', arrangement: 'Remote'} when it reads as a location line, else null. */
export function parseLocationLine(line) {
  const text = String(line || '').trim();
  if (!text || text.length > 90 || /\$|\bago\b|\bapplicants?\b|·|https?:/i.test(text)) return null;
  const m = ARRANGEMENT_SUFFIX_RE.exec(text);
  const arrangement = m ? normalizeArrangement(m[1]) : '';
  const place = m ? text.slice(0, m.index).trim() : text;
  if (!place) return arrangement ? { place: '', arrangement } : null;
  const lower = place.toLowerCase();
  const segments = lower.split(',').map((s) => s.trim()).filter(Boolean);
  const tail = segments[segments.length - 1] || '';
  const looksPlace = (segments.length >= 2 && PLACE_TAILS.has(tail))
    || COUNTRIES.includes(lower)
    || AREA_RE.test(place)
    || US_STATE_NAMES.includes(lower);
  if (!looksPlace) return null;
  return { place, arrangement };
}

function normalizeArrangement(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'remote') return 'Remote';
  if (v === 'hybrid') return 'Hybrid';
  if (/^on[- ]?site$/.test(v)) return 'On-site';
  return '';
}

function isFieldLine(line) {
  return !!(parseLocationLine(line) || AGE_RE.test(line) || AGE_TODAY_RE.test(line) || COMP_RE.test(line)
    || LABEL_RE.test(line) || NOISE_RE.test(line) || ARRANGEMENT_LINE_RE.test(line) || JOB_ID_RE.test(line));
}

/** "3 days ago" relative to capturedAt -> YYYY-MM-DD (approximate by construction; the raw text is kept too). */
export function postedDateFromAge(ageText, capturedAt) {
  const base = new Date(capturedAt);
  if (Number.isNaN(base.getTime())) return '';
  if (AGE_TODAY_RE.test(ageText)) return base.toISOString().slice(0, 10);
  const m = AGE_RE.exec(ageText);
  if (!m) return '';
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unitDays = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
  const d = new Date(base.getTime() - n * unitDays * 86400000);
  return d.toISOString().slice(0, 10);
}

export function linkedinJobIdFrom(text) {
  const m = JOB_ID_RE.exec(String(text || ''));
  return m ? (m[1] || m[2]) : '';
}

export function linkedinJobUrl(jobId) {
  return jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '';
}

/**
 * Parse pasted LinkedIn result pages into cards. Location-anchored: a card is
 * a (title, company, location) triple of consecutive content lines, which is
 * the one shape every result card has; everything after the location up to
 * the next card is metadata (compensation, age, labels, a job URL).
 *
 * @param {string} text - raw paste (one or many pages; HTML tags/entities tolerated).
 * @param {{capturedAt?: string, htmlLinks?: Array<{url: string, text?: string}>}} [opts]
 * @returns {{cards: object[], lines: number}}
 */
export function parseLinkedInPaste(text, { capturedAt = new Date().toISOString(), htmlLinks = [] } = {}) {
  const raw = String(text ?? '').replace(/\r/g, '').replace(/<\/(?:li|div|p|h\d)>|<br\s*\/?>/gi, '\n').split('\n');
  const lines = [];
  for (const r of raw) {
    const line = cleanLine(r);
    if (!line) continue;
    // "Title with verification" repeats the title line above it: drop it.
    const v = VERIFICATION_RE.exec(line);
    if (v && lines.length && lines[lines.length - 1] === v[1].trim()) continue;
    if (v) { lines.push(v[1].trim()); continue; }
    // Collapse a line repeated back-to-back (LinkedIn renders the title twice).
    if (lines.length && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }

  const anchors = [];
  for (let i = 2; i < lines.length; i++) {
    const loc = parseLocationLine(lines[i]);
    if (!loc) continue;
    const company = lines[i - 1];
    const title = lines[i - 2];
    if (/^Posted\s+\d+\s+(?:hours?|days?|weeks?|months?)\s+ago/i.test(title)) continue;
    if (isFieldLine(company) || isFieldLine(title)) continue;
    if (anchors.length && anchors[anchors.length - 1].i >= i - 2) continue; // overlaps previous card
    anchors.push({ i, title, company, loc });
  }

  const cards = anchors.map((a, n) => {
    const end = n + 1 < anchors.length ? anchors[n + 1].i - 2 : lines.length;
    const meta = lines.slice(a.i + 1, end);
    const card = {
      title: a.title,
      company: a.company,
      location: a.loc.place,
      arrangement: a.loc.arrangement,
      compensation: '',
      posting_age: '',
      posted_date: '',
      labels: [],
      linkedin_job_id: linkedinJobIdFrom(a.title),
    };
    for (const m of meta) {
      if (!card.compensation && COMP_RE.test(m)) { card.compensation = m.split(/\s+·\s+/)[0].trim(); continue; }
      if (!card.posting_age && (AGE_RE.test(m) || AGE_TODAY_RE.test(m))) {
        card.posting_age = m;
        card.posted_date = postedDateFromAge(m, capturedAt);
        continue;
      }
      const label = LABEL_RE.exec(m);
      if (label) {
        const l = label[1][0].toUpperCase() + label[1].slice(1).toLowerCase();
        if (!card.labels.includes(l)) card.labels.push(l);
        continue;
      }
      if (!card.arrangement && ARRANGEMENT_LINE_RE.test(m)) { card.arrangement = normalizeArrangement(m); continue; }
      const id = linkedinJobIdFrom(m);
      if (id && !card.linkedin_job_id) card.linkedin_job_id = id;
    }
    return card;
  });

  attachHtmlLinkIds(cards, htmlLinks);
  return { cards, lines: lines.length };
}

/**
 * The paste box also captures the clipboard's text/html flavour and sends the
 * job links it contains as {url, text}. A link's id is attached only to the
 * ONE card whose normalized title equals the link text; a title shared by two
 * cards (or two different ids for one title) stays unresolved.
 */
function attachHtmlLinkIds(cards, htmlLinks) {
  if (!Array.isArray(htmlLinks) || htmlLinks.length === 0) return;
  const idsByTitle = new Map();
  for (const link of htmlLinks) {
    const id = linkedinJobIdFrom(link?.url);
    const t = normalizeRoleForDedup(cleanLine(VERIFICATION_RE.exec(cleanLine(link?.text || ''))?.[1] || link?.text || ''));
    if (!id || !t) continue;
    if (!idsByTitle.has(t)) idsByTitle.set(t, new Set());
    idsByTitle.get(t).add(id);
  }
  const cardsByTitle = new Map();
  for (const c of cards) {
    const t = normalizeRoleForDedup(c.title);
    cardsByTitle.set(t, (cardsByTitle.get(t) || 0) + 1);
  }
  for (const c of cards) {
    if (c.linkedin_job_id) continue;
    const t = normalizeRoleForDedup(c.title);
    const ids = idsByTitle.get(t);
    if (ids && ids.size === 1 && cardsByTitle.get(t) === 1) {
      c.linkedin_job_id = [...ids][0];
      c.id_source = 'paste_html';
    }
  }
}

// ── Identity helpers ─────────────────────────────────────────────────────

function identityOf({ company, title, location }) {
  return {
    company: normalizeCompany(company || ''),
    role: normalizeRoleForDedup(title || ''),
    place: normalizeLocationForDedup(location || ''),
  };
}

function crKeyFor(card) {
  return computeJobKey({ company: card.company, title: card.title, location: card.location });
}

function jobIdOfUrl(url) {
  return /linkedin\.com/i.test(String(url || '')) ? linkedinJobIdFrom(url) : '';
}

/**
 * One pass over every record the Review lifecycle already knows about —
 * durable state + open/finalized/processed batches — as company/role/place
 * identities. Durable records keep no location, so a url-keyed record takes
 * it from the batch that produced it; a cr-keyed record's location is the
 * key's own `@@` component.
 */
export function buildKnownJobIndex({ root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  const records = [];
  const batchJobs = new Map();
  for (const [dir, where] of [[p.open, 'open'], [p.finalized, 'finalized'], [p.processed, 'processed']]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const b = readJson(path.join(dir, f), null);
      for (const j of b?.jobs || []) {
        if (!j.job_key) continue;
        batchJobs.set(j.job_key, j);
        if (where !== 'processed') {
          records.push({ job_key: j.job_key, where, batch_id: b.batch_id, company: j.company, title: j.title, url: j.url || '', location: j.location || '', state: j.review?.final_decision ? 'REVIEWED_PENDING_FINALIZE' : 'UNREVIEWED' });
        }
      }
    }
  }
  const state = readJson(p.statePath, defaultState());
  for (const [key, d] of Object.entries(state.jobs || {})) {
    const fromBatch = batchJobs.get(key);
    const keyPlace = key.startsWith('cr:') && key.includes('@@') ? key.slice(key.indexOf('@@') + 2) : '';
    let st = 'DECIDED';
    if (d.fit_decision === 'PASS') st = 'PASS';
    else if (d.execution_status === 'APPLIED') st = 'APPLIED';
    else if (d.execution_status === 'NOT_APPLYING') st = 'NOT_APPLYING';
    else if (d.execution_status === 'READY_TO_APPLY') st = 'READY_TO_APPLY';
    else if (d.fit_decision === 'INVESTIGATE') st = 'INVESTIGATE';
    records.push({ job_key: key, where: 'durable', batch_id: d.batch_id || '', company: d.company, title: d.title, url: d.url || '', location: fromBatch?.location || '', keyPlace, state: st });
  }
  return records.map((r) => {
    const id = identityOf(r);
    return { ...r, ...id, place: id.place || r.keyPlace || '', linkedin_job_id: jobIdOfUrl(r.url) };
  });
}

/** Application-history rows from the tracker (company + normalized role). */
export function loadTrackerApplications(trackerPath) {
  if (!trackerPath || !existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf-8').replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const out = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    if (!TRACKER_APPLIED_STATES.has(String(row.status || '').trim().toLowerCase())) continue;
    out.push({ num: row.num, company: normalizeCompany(row.company), role: normalizeRoleForDedup(row.role), status: row.status });
  }
  return out;
}

function distinctRequisition(a, b) {
  return !!(a.linkedin_job_id && b.linkedin_job_id && a.linkedin_job_id !== b.linkedin_job_id);
}

// ── Bounded URL resolution ───────────────────────────────────────────────

function parseScanHistory(text) {
  const out = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n').slice(1)) {
    const c = line.split('\t');
    if (!/^https?:\/\//.test(c[0] || '')) continue;
    out.push({ url: c[0], title: c[3] || '', company: c[4] || '', location: c[6] || '' });
  }
  return out;
}

function externalUrlFromLocalJd(ref, root) {
  if (!String(ref || '').startsWith('local:')) return ref;
  const rel = String(ref).slice('local:'.length).replace(/[\\/]+/g, path.sep);
  const file = path.resolve(root, rel);
  if (!existsSync(file)) return '';
  const head = readFileSync(file, 'utf8').slice(0, 3000);
  const raw = /^url:\s*["']?([^\r\n"']+)/mi.exec(head)?.[1]?.trim() || '';
  return /^https?:\/\//i.test(raw) ? raw : '';
}

/**
 * Local-evidence resolver: scan-history.tsv + every review batch/durable
 * record. Resolves only when exactly ONE distinct http(s) URL exists for the
 * same company + role + place.
 */
export function localHistoryResolver({ root = DATA_ROOT, scanHistoryPath, knownIndex } = {}) {
  const shPath = scanHistoryPath || path.join(root, 'data', 'scan-history.tsv');
  const rows = existsSync(shPath) ? parseScanHistory(readFileSync(shPath, 'utf-8')) : [];
  const pool = [
    ...rows.map((r) => ({ url: externalUrlFromLocalJd(r.url, root), ...identityOf(r) })),
    ...(knownIndex || []).filter((r) => /^https?:\/\//.test(r.url)).map((r) => ({ url: r.url, company: r.company, role: r.role, place: r.place })),
  ];
  return {
    name: 'local_history',
    async resolve(card) {
      const id = identityOf(card);
      if (!id.company || !id.role || !id.place) return { status: 'unresolved' };
      const urls = new Set(pool.filter((r) => r.company === id.company && r.role === id.role && r.place === id.place).map((r) => normalizeUrl(r.url)).filter(Boolean));
      if (urls.size === 1) return { status: 'resolved', url: [...urls][0] };
      if (urls.size > 1) return { status: 'ambiguous', candidates: [...urls].slice(0, 5) };
      return { status: 'unresolved' };
    },
  };
}

/** Parse LinkedIn guest search HTML into {url, title, company, location} cards. */
export function parseGuestSearchHtml(html) {
  const out = [];
  const chunks = String(html || '').split(/<li\b/i).slice(1);
  const pick = (chunk, cls) => {
    const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</(?:h3|h4|span|a)>`, 'i').exec(chunk);
    return m ? cleanLine(m[1]) : '';
  };
  for (const chunk of chunks) {
    const href = /href="([^"]*\/jobs\/view\/[^"]*)"/i.exec(chunk)?.[1] || '';
    const id = linkedinJobIdFrom(decodeEntities(href)) || /data-entity-urn="urn:li:jobPosting:(\d+)"/i.exec(chunk)?.[1] || '';
    if (!id) continue;
    out.push({ url: linkedinJobUrl(id), linkedin_job_id: id, title: pick(chunk, 'base-search-card__title'), company: pick(chunk, 'base-search-card__subtitle'), location: pick(chunk, 'job-search-card__location') });
  }
  return out;
}

/**
 * Network resolver: LinkedIn's public guest search, one request per
 * unresolved card, hard-capped at `maxRequests` per import and `timeoutMs`
 * per request. Resolves only on exactly one card with the same company,
 * role AND place.
 */
export function linkedinGuestSearchResolver({ fetchImpl = globalThis.fetch, maxRequests = 10, timeoutMs = 8000 } = {}) {
  let used = 0;
  return {
    name: 'linkedin_search',
    get used() { return used; },
    async resolve(card) {
      if (used >= maxRequests) return { status: 'skipped', reason: `lookup budget of ${maxRequests} request(s) used` };
      used += 1;
      const q = new URLSearchParams({ keywords: `${card.title} ${card.company}`, location: card.location || '', start: '0' });
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${q}`;
      let html;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}` };
        html = await res.text();
      } catch (e) {
        return { status: 'error', reason: String(e?.message || e).slice(0, 120) };
      }
      const id = identityOf(card);
      const hits = parseGuestSearchHtml(html).filter((c) => {
        const cid = identityOf(c);
        return cid.company === id.company && cid.role === id.role && cid.place === id.place;
      });
      const ids = new Set(hits.map((h) => h.linkedin_job_id));
      if (ids.size === 1) return { status: 'resolved', url: linkedinJobUrl([...ids][0]) };
      if (ids.size > 1) return { status: 'ambiguous', candidates: [...ids].slice(0, 5).map(linkedinJobUrl) };
      return { status: 'unresolved' };
    },
  };
}

// ── Import ───────────────────────────────────────────────────────────────

/**
 * Parse -> dedupe/history/suppression/geography -> URL resolution -> one
 * normal open Review batch. Returns the receipt; writes nothing when
 * `dryRun` or when there are no survivors (besides the receipt log line).
 *
 * @param {{text: string, search_query?: string, captured_at?: string, html_links?: Array}} input
 * @param {{root?: string, resolvers?: object[], resolveOnline?: boolean, fetchImpl?: Function, maxLookups?: number, dryRun?: boolean, trackerPath?: string, now?: () => string}} [opts]
 */
export async function importLinkedInPaste(input = {}, opts = {}) {
  const { root = DATA_ROOT, dryRun = false, resolveOnline = false, fetchImpl, maxLookups = 10 } = opts;
  const now = opts.now || (() => new Date().toISOString());
  const text = String(input.text || '');
  if (!text.trim()) throw new Error('paste text is required');
  const capturedAt = validIso(input.captured_at) || now();
  const searchQuery = String(input.search_query || '').trim();

  const { cards } = parseLinkedInPaste(text, { capturedAt, htmlLinks: input.html_links || [] });
  const receiptId = `lip-${createHash('sha256').update(`${capturedAt}\n${searchQuery}\n${text}`).digest('hex').slice(0, 12)}`;
  const items = [];
  const record = (card, outcome, reason, detail = '', extra = {}) => items.push({
    company: card.company, title: card.title, location: card.location, arrangement: card.arrangement,
    compensation: card.compensation, posting_age: card.posting_age, labels: card.labels,
    linkedin_job_id: card.linkedin_job_id || '', outcome, reason, detail, ...extra,
  });

  const known = buildKnownJobIndex({ root });
  const tracker = loadTrackerApplications(opts.trackerPath || resolveTrackerPath(root));
  const blacklistPath = path.join(root, 'data', 'blacklist.md');
  const blacklist = existsSync(blacklistPath) ? parseBlacklist(readFileSync(blacklistPath, 'utf-8')) : new Map();
  const discardPath = path.join(root, 'data', 'discard.log');
  const discardIndex = buildSuppressionIndexFromText(existsSync(discardPath) ? readFileSync(discardPath, 'utf-8') : '');

  // 1. In-paste duplicates: same company/role/place (or same job id); distinct
  //    LinkedIn job ids are always kept apart.
  const unique = [];
  for (const card of cards) {
    const id = identityOf(card);
    const twin = unique.find((u) => {
      if (card.linkedin_job_id && u.card.linkedin_job_id) return card.linkedin_job_id === u.card.linkedin_job_id;
      return u.id.company === id.company && u.id.role === id.role && u.id.place === id.place;
    });
    if (twin) {
      // Merge label/metadata evidence into the kept card (e.g. "Applied" on the second copy).
      for (const l of card.labels) if (!twin.card.labels.includes(l)) twin.card.labels.push(l);
      twin.card.compensation ||= card.compensation;
      twin.card.posting_age ||= card.posting_age;
      twin.card.posted_date ||= card.posted_date;
      twin.card.linkedin_job_id ||= card.linkedin_job_id;
      record(card, 'duplicate', 'duplicate_in_paste', 'same card appears more than once in this paste');
      continue;
    }
    unique.push({ card, id });
  }

  // 2. History, suppression, geography — in that order, first hit wins.
  const survivors = [];
  for (const { card, id } of unique) {
    const url = linkedinJobUrl(card.linkedin_job_id);
    const keys = new Set([crKeyFor(card), url ? computeJobKey({ url }) : ''].filter(Boolean));

    if (card.labels.includes('Applied')) { record(card, 'excluded', 'already_applied', 'LinkedIn shows this job as Applied'); continue; }

    const appliedHit = known.find((r) => (r.state === 'APPLIED' || r.state === 'NOT_APPLYING') && r.company === id.company && r.role === id.role && !distinctRequisition(r, card));
    if (appliedHit) { record(card, 'excluded', 'already_applied', `${appliedHit.state} in review state (${appliedHit.job_key})`, { matched_job_key: appliedHit.job_key }); continue; }
    const trackerHit = tracker.find((t) => t.company === id.company && t.role === id.role);
    if (trackerHit) { record(card, 'excluded', 'already_applied', `tracker row #${trackerHit.num} (${trackerHit.status})`); continue; }

    const exact = known.find((r) => keys.has(r.job_key)
      || (!distinctRequisition(r, card) && r.company === id.company && r.role === id.role && r.place && r.place === id.place));
    if (exact) {
      if (exact.state === 'PASS') record(card, 'excluded', 'suppressed_pass', `already PASSed (${exact.job_key})`, { matched_job_key: exact.job_key });
      else record(card, 'duplicate', 'already_known', `${exact.state}${exact.batch_id ? ` in ${exact.batch_id}` : ''}`, { matched_job_key: exact.job_key, batch_id: exact.batch_id || null });
      continue;
    }

    const bl = blacklist.get(normalizeCompany(card.company));
    if (bl) { record(card, 'excluded', 'blacklist', `data/blacklist.md${bl.reason ? `: ${bl.reason}` : ''}`); continue; }
    const ds = isDiscardSuppressed({ url, company: card.company }, discardIndex);
    if (ds.suppressed) { record(card, 'excluded', 'discard_suppressed', `discard.log (${ds.scope})`); continue; }

    const job = toSurvivorJob(card, { searchQuery, capturedAt, receiptId });
    const geography = computeGateEvidence(job).geography;
    if (!GEOGRAPHY_ACTIONABLE.includes(geography.state)) { record(card, 'excluded', 'geography', `${geography.state}: ${geography.reason}`); continue; }
    survivors.push({ card, job, geography });
  }

  // 3. Bounded URL resolution for survivors only.
  const resolvers = opts.resolvers || [
    localHistoryResolver({ root, knownIndex: known }),
    ...(resolveOnline ? [linkedinGuestSearchResolver({ fetchImpl, maxRequests: maxLookups })] : []),
  ];
  const toAdd = [];
  for (const s of survivors) {
    let resolution = s.card.linkedin_job_id ? { status: 'resolved', via: s.card.id_source || 'paste_text', url: linkedinJobUrl(s.card.linkedin_job_id) } : null;
    const attempts = [];
    for (const r of resolution ? [] : resolvers) {
      const out = await r.resolve(s.card);
      attempts.push({ via: r.name, status: out.status, ...(out.reason ? { reason: out.reason } : {}), ...(out.candidates ? { candidates: out.candidates } : {}) });
      if (out.status === 'resolved') { resolution = { status: 'resolved', via: r.name, url: out.url }; break; }
    }
    if (!resolution) resolution = { status: attempts.some((a) => a.status === 'ambiguous') ? 'ambiguous' : 'unresolved', via: null, url: '' };

    // A resolved URL is a second identity: re-check it against everything known.
    if (resolution.url) {
      const urlKey = computeJobKey({ url: resolution.url });
      const hit = findExistingJob(urlKey, { root });
      const clash = known.find((r) => r.job_key === urlKey) || toAdd.find((t) => computeJobKey({ url: t.job.url }) === urlKey);
      if (hit || clash) {
        const st = hit?.state || clash?.state || 'UNREVIEWED';
        if (st === 'PASS') record(s.card, 'excluded', 'suppressed_pass', `already PASSed (${urlKey})`, { matched_job_key: urlKey });
        else if (st === 'APPLIED' || st === 'NOT_APPLYING') record(s.card, 'excluded', 'already_applied', `${st} (${urlKey})`, { matched_job_key: urlKey });
        else record(s.card, 'duplicate', 'already_known', `${st} (${urlKey})`, { matched_job_key: urlKey });
        continue;
      }
      s.job.url = resolution.url;
    }
    s.job.intake.url_resolution = { status: resolution.status, via: resolution.via, attempts };
    toAdd.push(s);
  }

  // 4. One normal open Review batch.
  let batchId = null;
  if (toAdd.length && !dryRun) {
    const created = createBatchFromJobs(toAdd.map((s) => s.job), { root, source: BATCH_SOURCE });
    batchId = created.batchId;
    const byKey = new Map(created.batch.jobs.map((j) => [j.job_key, j]));
    for (const s of toAdd) {
      const key = computeJobKey(s.job);
      const j = byKey.get(key);
      record(s.card, 'added', s.job.url ? 'added' : 'added_unresolved_url', s.job.url ? `url via ${s.job.intake.url_resolution.via}` : 'no exact job URL — enter it on the Review card', {
        job_key: key, batch_id: batchId, url: s.job.url || '', url_status: s.job.intake.url_resolution.status, geography: j?.gates?.geography?.state || s.geography.state,
      });
    }
  } else {
    for (const s of toAdd) {
      record(s.card, dryRun ? 'would_add' : 'added', s.job.url ? 'added' : 'added_unresolved_url', '', { job_key: computeJobKey(s.job), url: s.job.url || '', url_status: s.job.intake.url_resolution.status, geography: s.geography.state });
    }
  }

  const count = (pred) => items.filter(pred).length;
  const receipt = {
    receipt_id: receiptId,
    captured_at: capturedAt,
    imported_at: now(),
    search_query: searchQuery,
    dry_run: !!dryRun,
    batch_id: batchId,
    counts: {
      parsed: cards.length,
      duplicate: count((i) => i.outcome === 'duplicate'),
      excluded: count((i) => i.outcome === 'excluded'),
      unresolved: count((i) => (i.outcome === 'added' || i.outcome === 'would_add') && !i.url),
      added: count((i) => i.outcome === 'added' || i.outcome === 'would_add'),
    },
    items,
  };
  if (!dryRun) appendReceiptLog(receipt, { root });
  return receipt;
}

function validIso(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function toSurvivorJob(card, { searchQuery, capturedAt, receiptId }) {
  return {
    url: '',
    company: card.company,
    title: card.title,
    location: card.location,
    // Structured workplace signal, the same field shape the LinkedIn scan
    // actors hand classifyGeography (classifyStructuredWorkplace).
    workplaceTypes: card.arrangement ? [card.arrangement] : [],
    compensation: card.compensation || null,
    postedAt: card.posted_date || '',
    source: BATCH_SOURCE,
    intake: {
      kind: BATCH_SOURCE,
      receipt_id: receiptId,
      search_query: searchQuery,
      captured_at: capturedAt,
      arrangement: card.arrangement || '',
      posting_age: card.posting_age || '',
      labels: card.labels,
      linkedin_job_id: card.linkedin_job_id || '',
      cr_key: crKeyFor(card),
    },
  };
}

function appendReceiptLog(receipt, { root }) {
  const file = path.join(root, 'data', 'linkedin-paste-imports.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  const { items, ...head } = receipt;
  appendFileSync(file, JSON.stringify({ ...head, items: items.map((i) => ({ company: i.company, title: i.title, location: i.location, outcome: i.outcome, reason: i.reason, job_key: i.job_key || null })) }) + '\n');
}

// ── Manual URL entry for an unresolved card ──────────────────────────────

/**
 * Attach an exact job URL to one UNREVIEWED, undecided job in an open batch
 * (the "flagged for manual entry" path). The job's identity becomes the URL
 * key; its original company/role/location key is kept in intake.cr_key. If
 * that URL already belongs to any other known job, nothing changes and the
 * clash is reported — two records are never merged here.
 */
export async function setManualJobUrl(batchId, jobKey, rawUrl, { root = DATA_ROOT } = {}) {
  let url;
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    const id = /linkedin\.com$/i.test(u.hostname) ? linkedinJobIdFrom(u.href) : '';
    url = id ? linkedinJobUrl(id) : u.href;
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  const newKey = computeJobKey({ url });
  if (!newKey) throw new Error('could not derive a job identity from this URL');
  const existing = findExistingJob(newKey, { root });
  if (existing) return { outcome: 'conflict', job_key: newKey, state: existing.state, batch_id: existing.batch_id || null, summary: existing.summary };

  const openPath = path.join(reviewPaths(root).open, `${batchId}.json`);
  return withPipelineLock(openPath, async () => {
    const batch = readJson(openPath, null);
    if (!batch) throw new Error(`no open batch ${batchId}`);
    const job = batch.jobs.find((j) => j.job_key === jobKey);
    if (!job) throw new Error(`${jobKey} is not in open batch ${batchId}`);
    if (job.review.status !== 'UNREVIEWED' || job.review.proposed_decision || job.review.final_decision) {
      throw new Error('only an unreviewed, undecided job can have its URL set');
    }
    if (job.url) throw new Error('this job already has a URL');
    job.url = url;
    job.job_key = newKey;
    job.intake = { ...(job.intake || {}), cr_key: job.intake?.cr_key || jobKey, url_resolution: { ...(job.intake?.url_resolution || {}), status: 'resolved', via: 'manual', set_at: new Date().toISOString() } };
    const errors = validateBatch(batch, 'proposed');
    if (errors.length) throw new Error(`batch would be invalid: ${errors.join('; ')}`);
    atomicWriteFile(openPath, JSON.stringify(batch, null, 2) + '\n');
    return { outcome: 'updated', batch_id: batchId, old_job_key: jobKey, job_key: newKey, url };
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const [cmd, file] = argv;
  if ((cmd === 'parse' || cmd === 'import') && file) {
    const text = readFileSync(file, 'utf-8');
    const capturedAt = flagValue(argv, '--captured-at') || undefined;
    if (cmd === 'parse') {
      console.log(JSON.stringify(parseLinkedInPaste(text, { capturedAt }), null, 2));
      return;
    }
    // A paste is discovery input only. Keep the parse/pre-gate receipt in
    // memory, then hand every row to the same qualification orchestrator used
    // by the UI; only its PASS survivors may create a Review batch.
    const discoveryReceipt = await importLinkedInPaste(
      { text, search_query: flagValue(argv, '--query') || '', captured_at: capturedAt },
      { dryRun: true, resolveOnline: false },
    );
    const { qualifyLinkedInReceipt } = await import('./linkedin-qualification.mjs');
    const result = await qualifyLinkedInReceipt(discoveryReceipt, {
      root: DATA_ROOT,
      dryRun: argv.includes('--dry-run'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Usage:
  node linkedin-paste-intake.mjs parse <file> [--captured-at ISO]
  node linkedin-paste-intake.mjs import <file> --query "..." [--captured-at ISO] [--dry-run]`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`linkedin-paste-intake.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
