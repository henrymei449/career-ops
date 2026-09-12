#!/usr/bin/env node
/**
 * recall-store.mjs — read/write/lock helpers for the Lane B holding pen,
 * data/recall-candidates.jsonl.
 *
 * JSONL, not TSV: title-filter rejects can carry a provider-supplied JD
 * description (arbitrary multiline text) so a promoted candidate gets the
 * same content/fingerprint behavior Lane A already has. The only existing
 * TSV serializers in this codebase (sanitizeTsvField/normalizeScanScalar in
 * scan.mjs) collapse newlines/tabs to spaces by design — correct for short
 * fields like title/company/location, unsafe for a multi-paragraph JD body.
 * No safe multiline-round-trip TSV serializer exists here to reuse, so this
 * uses JSON.stringify/parse per line instead — no new dependency, no
 * escaping logic to get wrong.
 *
 * Locking reuses pipeline-lock.mjs's existing generic withPipelineLock (the
 * same primitive appendToPipeline/appendToScanHistory already use, pointed
 * at a different path) rather than any new lock mechanism.
 */
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { atomicWriteFile, normalizeUrlForDedup } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';

const DATA_ROOT = getCareerOpsRoot();
export const RECALL_CANDIDATES_PATH = process.env.CAREER_OPS_RECALL_CANDIDATES || join(DATA_ROOT, 'data/recall-candidates.jsonl');

export const DISCOVERY_LANES = ['keyword', 'semantic_recall', 'manual', 'external_handoff', 'unknown'];

// A crashed/killed recall-relevance.mjs run must not permanently strand a
// row in 'in_flight' — 30 minutes is comfortably above one batch's expected
// LLM round-trip, so a genuinely still-running process is never reclaimed
// out from under itself.
export const STALE_IN_FLIGHT_MS = 30 * 60 * 1000;

/**
 * @param {string} [filePath]
 * @returns {object[]}
 */
export function readRecallCandidates(filePath = RECALL_CANDIDATES_PATH) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf-8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A malformed line (partial write, manual edit) is skipped rather than
      // aborting the whole read — one bad row must not hide every other one.
    }
  }
  return rows;
}

/**
 * @param {object[]} rows
 * @param {string} [filePath]
 */
export function writeRecallCandidatesUnlocked(rows, filePath = RECALL_CANDIDATES_PATH) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  atomicWriteFile(filePath, text);
}

/**
 * @param {string} filePath
 * @param {(rows: object[]) => object[] | Promise<object[]>} fn - receives the
 *   current rows, returns the rows to persist (same array or a new one).
 */
export async function withRecallLock(filePath, fn) {
  return withPipelineLock(filePath, async () => {
    const rows = readRecallCandidates(filePath);
    const result = await fn(rows);
    if (result !== undefined) writeRecallCandidatesUnlocked(result, filePath);
    return result;
  });
}

/**
 * Capture-side write: append a title-filter reject that survived structural
 * eligibility, unless a candidate for the same normalized URL already
 * exists (any status) — capture happens once per URL, ever, not once per
 * scan run.
 *
 * @param {{url: string, title: string, company: string, location?: string, postedAt?: number, firstSeenAt?: number, source?: string, description?: string, discoveryLane?: string}} candidate
 * @param {string} [filePath]
 * @returns {Promise<boolean>} true if newly added, false if already present
 */
export async function appendRecallCandidateIfNew(candidate, filePath = RECALL_CANDIDATES_PATH) {
  const key = normalizeUrlForDedup(candidate.url);
  let added = false;
  await withRecallLock(filePath, (rows) => {
    if (rows.some((r) => normalizeUrlForDedup(r.url) === key)) {
      return rows; // already known — no-op write (still fine, just unchanged)
    }
    added = true;
    rows.push({
      url: candidate.url,
      title: candidate.title,
      company: candidate.company,
      location: candidate.location ?? '',
      posted_at: candidate.postedAt ?? null,
      first_seen_at: candidate.firstSeenAt ?? null,
      source: candidate.source ?? '',
      description: candidate.description ?? null,
      captured_at: localToday(),
      status: 'pending',
      confidence: null,
      reason: null,
      evaluated_at: null,
      claimed_at: null,
      claim_token: null,
    });
    return rows;
  });
  return added;
}

/**
 * Selection for one recall-relevance.mjs run. Deterministic, NOT
 * provider-iteration-order: sorts by freshness (posted_at, falling back to
 * first_seen_at, unknown-dated last), applies per-company and per-source
 * caps, then takes up to `cap` — with URL as a stable tie-break so ties
 * never depend on file order. Rows already 'in_flight' but stale (older
 * than STALE_IN_FLIGHT_MS) are treated as pending again — minimal recovery
 * for a killed process, no separate queue/infrastructure.
 *
 * @param {object[]} rows
 * @param {{cap: number, perCompanyCap?: number, perSourceCap?: number, now?: number}} opts
 * @returns {object[]} the rows selected (still plain objects — caller marks them)
 */
export function selectForEvaluation(rows, { cap, perCompanyCap = 5, perSourceCap = 15, now = Date.now() } = {}) {
  const eligible = rows.filter((r) => {
    if (r.status === 'pending') return true;
    if (r.status === 'in_flight' && r.claimed_at) {
      const claimedMs = Date.parse(r.claimed_at);
      return Number.isFinite(claimedMs) && (now - claimedMs) > STALE_IN_FLIGHT_MS;
    }
    return false;
  });

  const freshnessKey = (r) => {
    const iso = r.posted_at || r.first_seen_at;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : -Infinity; // undated sorts last (oldest)
  };

  const sorted = [...eligible].sort((a, b) => {
    const diff = freshnessKey(b) - freshnessKey(a); // newest first
    if (diff !== 0) return diff;
    return String(a.url).localeCompare(String(b.url)); // stable tie-break
  });

  const perCompanyCount = new Map();
  const perSourceCount = new Map();
  const selected = [];
  for (const row of sorted) {
    if (selected.length >= cap) break;
    const companyKey = (row.company || '').toLowerCase();
    const sourceKey = (row.source || '').toLowerCase();
    const companyCount = perCompanyCount.get(companyKey) || 0;
    const sourceCount = perSourceCount.get(sourceKey) || 0;
    if (companyCount >= perCompanyCap || sourceCount >= perSourceCap) continue;
    selected.push(row);
    perCompanyCount.set(companyKey, companyCount + 1);
    perSourceCount.set(sourceKey, sourceCount + 1);
  }
  return selected;
}

/**
 * Claim step (inside a lock): mark the given URLs 'in_flight' with a fresh
 * claim_token, return the token map so the caller can commit against it
 * later without re-reading identity out of thin air.
 *
 * @param {object[]} rows - full current rows (mutated in place and returned)
 * @param {string[]} urls
 * @returns {Map<string,string>} url -> claim_token
 */
export function claimRows(rows, urls) {
  const urlSet = new Set(urls);
  const tokens = new Map();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (!urlSet.has(row.url)) continue;
    const token = randomUUID();
    row.status = 'in_flight';
    row.claimed_at = now;
    row.claim_token = token;
    tokens.set(row.url, token);
  }
  return tokens;
}

/**
 * Commit step (inside a lock): write a verdict onto the row matching both
 * url AND claim_token — if the token no longer matches (another process
 * already reclaimed this row as stale and re-claimed it), skip rather than
 * clobber the newer claim. Minimal safety, not a full queue.
 *
 * @param {object[]} rows
 * @param {{url: string, claimToken: string, status: string, confidence?: string, reason?: string}} verdict
 * @returns {boolean} true if applied
 */
export function commitVerdict(rows, { url, claimToken, status, confidence = null, reason = null }) {
  const row = rows.find((r) => r.url === url);
  if (!row || row.claim_token !== claimToken) return false;
  row.status = status;
  row.confidence = confidence;
  row.reason = reason;
  row.evaluated_at = new Date().toISOString();
  row.claimed_at = null;
  row.claim_token = null;
  return true;
}
