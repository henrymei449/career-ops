#!/usr/bin/env node
/**
 * append-pipeline-entry.mjs — locked-append CLI for job offers discovered
 * OUTSIDE scan.mjs's own provider loop.
 *
 * scan.mjs's Level 0/2 providers write through appendToPipeline() /
 * appendToScanHistory(), which take pipeline-lock.mjs's cross-process lock
 * before touching data/pipeline.md or data/scan-history.tsv. A company with
 * no configured provider (see modes/scan.md's Level 1/3 Playwright/WebSearch
 * fallback) has historically been discovered by an agent hand-editing those
 * two files with Read/Edit — which bypasses that lock entirely. Two writers
 * doing that at once (a scheduled scan.mjs run overlapping an agent's
 * handoff pass) can silently drop one side's rows the same way an unlocked
 * appendFileSync would.
 *
 * This CLI closes that gap: it takes a JSON batch of offers and writes them
 * through the exact same locked, exported functions scan.mjs uses, applying
 * the same URL-dedup check scan.mjs's own dedup snapshot uses before writing
 * anything.
 *
 * Usage:
 *   node append-pipeline-entry.mjs --payload offers.json
 *   node append-pipeline-entry.mjs --payload offers.json --json
 *   node append-pipeline-entry.mjs --json <<'JSON'   # or --payload -
 *   [{ "url": "...", ... }]
 *   JSON
 *
 * offers.json shape: either a bare array, or { "offers": [...] }. Each
 * offer:
 *   {
 *     "url": "https://...",        // required; http(s) or "local:jds/..."
 *     "title": "...",              // required
 *     "company": "...",            // required
 *     "location": "...",           // optional
 *     "source": "...",             // optional; the scan-history "portal"
 *                                  // column — label your discovery method,
 *                                  // e.g. "Top100 Handoff — WebSearch"
 *     "postedAt": "YYYY-MM-DD",    // optional ISO date
 *     "description": "...",       // optional; feeds the cross-listing
 *                                  // fingerprint the same way a provider's
 *                                  // JD body does
 *     "note": "..."                // optional
 *   }
 *
 * Prints a JSON receipt (careerops.append.receipt@1) to stdout: added count,
 * the URLs actually written, and which inputs were skipped as duplicates or
 * invalid. Never overwrites or reorders existing rows — additive only.
 */
import { readFileSync } from 'fs';
import {
  appendToPipeline,
  appendToScanHistory,
  loadDedupSnapshot,
  normalizeUrlForDedup,
} from './scan.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

const KNOWN_FLAGS = ['--payload', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--payload'];

const USAGE = `Usage:
  node append-pipeline-entry.mjs --payload <file.json> [--json]
  node append-pipeline-entry.mjs [--json] < offers.json   # or --payload -

  --payload <file>  JSON file: a bare array of offers, or { "offers": [...] }.
                     Omit (or pass "-") to read the same JSON from stdin --
                     for a caller with Bash but no Write tool.
  --json             emit the receipt as a single compact JSON line

Each offer: { url, title, company, location?, source?, postedAt?, description?, note? }
url must start with "http://", "https://", or "local:".
postedAt (if given) must be an ISO date "YYYY-MM-DD".

Writes through scan.mjs's locked appendToPipeline()/appendToScanHistory() —
never hand-edits data/pipeline.md or data/scan-history.tsv directly — and
skips any URL already present in scan-history.tsv, pipeline.md, or
applications.md (the same dedup snapshot scan.mjs itself uses).`;

const URL_RE = /^(https?:\/\/|local:)/i;

// PowerShell's `-Encoding utf8` (PS 5.1) writes a UTF-8 byte-order mark,
// which JSON.parse rejects outright — strip it defensively since this CLI's
// payload is routinely produced by the Windows wrapper scripts.
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {unknown} raw
 * @returns {{ok: true, offer: object} | {ok: false, reason: string}}
 */
export function normalizeOfferInput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const company = typeof raw.company === 'string' ? raw.company.trim() : '';
  if (!url || !URL_RE.test(url)) return { ok: false, reason: `missing/invalid url: ${JSON.stringify(raw.url)}` };
  if (!title) return { ok: false, reason: 'missing title' };
  if (!company) return { ok: false, reason: 'missing company' };

  const offer = { url, title, company };
  if (typeof raw.location === 'string') offer.location = raw.location;
  if (typeof raw.source === 'string' && raw.source.trim()) offer.source = raw.source.trim();
  if (typeof raw.note === 'string' && raw.note.trim()) offer.note = raw.note.trim();
  if (typeof raw.description === 'string' && raw.description.trim()) offer.description = raw.description;

  if (raw.postedAt != null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw.postedAt).trim());
    if (!m) return { ok: false, reason: `postedAt must be YYYY-MM-DD, got ${JSON.stringify(raw.postedAt)}` };
    const ms = Date.parse(`${m[0]}T00:00:00Z`);
    if (Number.isFinite(ms)) offer.postedAt = ms;
  }

  return { ok: true, offer };
}

/**
 * @param {unknown[]} rawOffers
 * @param {{today?: string}} [opts]
 */
export async function appendOffers(rawOffers, { today = localToday() } = {}) {
  const snapshot = loadDedupSnapshot();
  const toAdd = [];
  const skippedDuplicate = [];
  const skippedInvalid = [];

  for (const raw of rawOffers) {
    const result = normalizeOfferInput(raw);
    if (!result.ok) {
      skippedInvalid.push({ input: raw, reason: result.reason });
      continue;
    }
    const { offer } = result;
    const key = normalizeUrlForDedup(offer.url);
    if (snapshot.seen.has(key)) {
      skippedDuplicate.push(offer.url);
      continue;
    }
    // Guard within THIS batch too — loadDedupSnapshot() is a snapshot taken
    // once before the loop, so two offers in the same payload sharing a URL
    // would otherwise both pass the check above.
    if (toAdd.some((o) => normalizeUrlForDedup(o.url) === key)) {
      skippedDuplicate.push(offer.url);
      continue;
    }
    toAdd.push(offer);
  }

  if (toAdd.length > 0) {
    await appendToPipeline(toAdd);
    await appendToScanHistory(toAdd, today, 'added');
  }

  return {
    added: toAdd.length,
    added_urls: toAdd.map((o) => o.url),
    skipped_duplicate: skippedDuplicate,
    skipped_invalid: skippedInvalid,
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const payloadPath = flagValue(args, '--payload');
  let raw;
  if (!payloadPath || payloadPath === '-') {
    // No file-write access needed for a caller that can pipe (e.g. an
    // agent with Bash but no Write tool) -- read the payload from stdin.
    try {
      raw = readFileSync(0, 'utf-8');
    } catch (err) {
      console.error(`Error: --payload <file> was omitted and stdin could not be read: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    if (!raw.trim()) {
      console.error(`Error: --payload <file> is required (or pipe JSON via stdin)\n\n${USAGE}`);
      process.exit(1);
    }
  } else {
    try {
      raw = readFileSync(payloadPath, 'utf-8');
    } catch (err) {
      console.error(`Error: could not read ${payloadPath}: ${err.message}`);
      process.exit(1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    console.error(`Error: could not parse payload JSON: ${err.message}`);
    process.exit(1);
  }

  const offers = Array.isArray(parsed) ? parsed : parsed?.offers;
  if (!Array.isArray(offers)) {
    console.error('Error: payload must be a JSON array of offers, or { "offers": [...] }.');
    process.exit(1);
  }

  appendOffers(offers)
    .then((result) => {
      const receipt = { version: 'careerops.append.receipt@1', ...result };
      console.log(args.includes('--json') ? JSON.stringify(receipt) : JSON.stringify(receipt, null, 2));
      process.exit(result.skipped_invalid.length > 0 ? 2 : 0);
    })
    .catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}
