// @ts-check
// ── Reference seed ── This bundled plugin is a stable, reviewed example. To
// extend it, publish career-ops-plugin-<id> with "supersedesBundled": true and
// your version takes precedence once installed (see docs/PLUGINS.md). Bundled
// seeds take only security/compat fixes — feature work happens in the successor repo.
//
// Apify provider plugin — runs any Apify actor and maps its dataset items to
// the {title, url, company, location, postedAt?} Job shape the scanner
// expects. All variation (which actor, what input, how to read fields) lives
// in portals.yml.
//
// Ported from the generic Apify provider contributed by @ageem23 in #693 (with
// thanks); it also homes the LinkedIn-via-Apify use case from #791/#1202. As a
// KEYED provider it lives here in plugins/ (not the zero-key providers/ dir):
// enable it in config/plugins.yml and put APIFY_TOKEN in .env. It fires ONLY on
// a portals.yml entry that sets `provider: apify` — never via auto-detection.
//
//   tracked_companies:
//     - name: "Indeed — VP Engineering (Chicago)"
//       provider: apify
//       actor: misceres/indeed-scraper
//       input: { position: "VP of Engineering", location: "Chicago, IL", maxItems: 25 }
//       field_map:
//         title:    [positionName, title]    # array = first non-empty wins
//         url:      url
//         company:  [company, companyName]
//         location: [location, formattedLocation]
//         postedAt: postedAt                 # optional — see below
//
// ── postedAt / --since ───────────────────────────────────────────────────
// `field_map.postedAt` is optional and, unlike title/url, does NOT default to
// blocking the entry if absent — a Job with no postedAt is simply undated,
// same "don't penalize missing data" convention scan.mjs already applies to
// every other provider (buildPostingAgeFilter/buildPostedDateFilter in
// scan.mjs treat a missing/non-numeric postedAt as "always passes"). When the
// underlying actor's dataset DOES expose a posting-date field, map it here so
// scan.mjs's existing central age/date filters — which is where `--since`,
// `--posted-after`/`--posted-before`, and `max_posting_age_days` are actually
// enforced — can do their job. Without this mapping, EVERY job from this
// provider is silently treated as undated and sails through any `--since`
// window regardless of true posting age (confirmed on the
// curious_coder/linkedin-jobs-scraper LinkedIn actor: its dataset items carry
// a `postedAt` field ("YYYY-MM-DD") per Apify's published input/output schema
// for that actor, but nothing here ever read it before this fix).
//
// parsePostedAt() accepts a YYYY-MM-DD string, a full ISO timestamp, or a
// numeric epoch already in ms or seconds. It returns `undefined` — never a
// guessed value — for anything it can't parse.
//
// ── ctx.sinceMs → actor-native datePosted (recall fix, defense-in-depth) ───
// The postedAt post-fetch guard above fixes CORRECTNESS (a stale job can no
// longer pass --since), but not RECALL: the actor was still being called
// with its default (unfiltered) window, so `limitPerSource` was spent on
// however many stale results came back first — a genuinely fresh posting
// past that limit could go unfetched even though it would have passed the
// post-fetch filter. Confirmed 2026-09-10 via a zero-cost Apify input-schema
// validation probe (a deliberately-invalid `datePosted` value returns the
// full accepted enum in the 400 error body, with no actor run ever started —
// no dataset-result cost incurred) that
// curious_coder/linkedin-jobs-scraper's `datePosted` accepts exactly:
//   "anyTime" | "past24Hours" | "pastWeek" | "pastMonth"
// mapSinceMsToDatePosted() below maps `ctx.sinceMs` to the SMALLEST bucket
// that still covers the requested window — i.e. it only ever widens relative
// to the exact bound, never narrows it, so it can over-fetch (mild recall
// cost, same as any bucketed filter) but never risks excluding an eligible
// fresh posting the post-fetch filter would have kept. Scoped to this ONE
// verified actor by exact match (LINKEDIN_JOBS_SCRAPER_ACTOR below) — a
// different `provider: apify` entry's actor has an unverified date-filter
// field name and enum, and must not have one guessed onto it. Never applied
// when the portals.yml entry already sets its own `input.datePosted`
// (explicit user config wins), and a no-`--since` scan leaves `input`
// untouched (actor keeps its own default, "anyTime" — unchanged behavior).
// This is purely a cost/recall optimization layered in FRONT of the
// unchanged postedAt post-fetch filter, which remains the actual correctness
// guarantee — see the header note above.
const LINKEDIN_JOBS_SCRAPER_ACTOR = 'curious_coder/linkedin-jobs-scraper';
const DATE_POSTED_BUCKETS = [
  { maxDays: 1, value: 'past24Hours' },
  { maxDays: 7, value: 'pastWeek' },
  { maxDays: 30, value: 'pastMonth' },
];

/**
 * Map scan.mjs's ctx.sinceMs (the epoch-ms floor a job's postedAt must clear)
 * to the smallest curious_coder/linkedin-jobs-scraper `datePosted` bucket
 * that still covers it. Returns undefined when sinceMs isn't a usable
 * number (no --since/--posted-after/max_posting_age_days bound in effect) —
 * callers must leave `input.datePosted` unset in that case, not default it.
 */
export function mapSinceMsToDatePosted(sinceMs, now = Date.now()) {
  if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return undefined;
  const ageDays = (now - sinceMs) / 86_400_000;
  if (ageDays <= 0) return 'past24Hours'; // a bound at/after "now" is at least as tight as 24h
  for (const bucket of DATE_POSTED_BUCKETS) {
    if (ageDays <= bucket.maxDays) return bucket.value;
  }
  return 'anyTime';
}

/**
 * The actual `input` object fetch() hands to runActor() — entry.input plus,
 * only for the one verified actor and only when the entry doesn't already
 * set its own datePosted, the ctx.sinceMs-derived bucket. Exported and
 * side-effect-free (never mutates entry.input) specifically so this mapping
 * is testable without touching the network — see
 * tests/apify-linkedin-date-posted.test.mjs.
 */
export function resolveActorInput(entry, ctx) {
  const input = entry.input || {};
  if (entry.actor !== LINKEDIN_JOBS_SCRAPER_ACTOR || input.datePosted != null) return input;
  const datePosted = mapSinceMsToDatePosted(ctx?.sinceMs);
  return datePosted ? { ...input, datePosted } : input;
}

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { hasToken, runActor } from './_apify.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

// This used to be the bare relative path 'jds', resolved against
// process.cwd() by mkdirSync/join/writeFileSync below. That happens to match
// DATA_ROOT when scan.mjs is run with the repo root as cwd AND the data root
// IS the repo root (the common single-checkout case this was written
// against) — but silently diverges the moment CAREER_OPS_ROOT/
// CAREER_OPS_DATA_DIR points somewhere else (e.g. a synced Drive folder),
// same as scan.mjs itself resolves PORTALS_PATH/SCAN_HISTORY_PATH/
// PIPELINE_PATH. Reuse scan.mjs's own resolver rather than reimplementing
// the CAREER_OPS_ROOT/CAREER_OPS_DATA_DIR/.career-ops-data precedence here a
// second time — two independent implementations of the same lookup is how
// they drift.
//
// JDS_REL is the relative form every consumer of `local:{path}` expects and
// resolves against DATA_ROOT itself (scan.mjs's `local:` reader, outcome.mjs's
// `local:(jds\/[^\s|)]+)` regex, jd-capture.mjs's report-number lookup,
// pipeline.md entries). Only JDS_DIR (the absolute filesystem location this
// module actually writes to) changes below — the STORED reference
// stays the bare relative `jds/{filename}` string it always was, or every one
// of those consumers breaks.
export const JDS_REL = 'jds';
export const JDS_DIR = join(getCareerOpsRoot(), JDS_REL);
const MIN_JD_BODY_CHARS = 50;

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// A valid field_map entry is a single key ('positionName') or an ordered list
// of fallback keys (['positionName', 'title']). Reject any other shape at
// config-load time with a clear error instead of crashing mid-scan.
export function isFieldSpec(spec) {
  if (typeof spec === 'string') return true;
  if (Array.isArray(spec) && spec.length > 0 && spec.every(s => typeof s === 'string')) return true;
  return false;
}

function pickField(item, spec) {
  const keys = Array.isArray(spec) ? spec : [spec];
  for (const k of keys) {
    const v = getPath(item, k);
    if (v != null && v !== '') return v;
  }
  return '';
}

const ALLOWED_DEFAULT_KEYS = new Set(['title', 'url', 'company', 'location']);

// Parse a raw postedAt-like value from an actor's dataset item into epoch ms.
// Accepts:
//   - a numeric epoch already in ms (>= 1e12 — no genuine posting date is
//     ever earlier than roughly the year 2001 expressed in ms) or in seconds
//     (a smaller finite number, converted to ms)
//   - a numeric string ('1731020400' / '1731020400000') — same rule as above
//   - a date/timestamp string parseable by Date.parse ('2026-08-20',
//     '2026-08-20T14:03:00Z', etc.)
// Returns `undefined` for null/empty/unparseable input — never a guessed or
// fabricated date. Callers must treat `undefined` as "unknown," not "stale"
// or "fresh" (see scan.mjs's buildPostingAgeFilter: a missing postedAt always
// passes the age filter, it is never assumed to be within any window).
export function parsePostedAt(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value < 1e12 ? value * 1000 : value;
  }
  const str = String(value).trim();
  if (str === '') return undefined;
  if (/^\d+$/.test(str)) return parsePostedAt(Number(str));
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : undefined;
}

// Actors return URLs from arbitrary external sites — treat them as untrusted.
// Reject anything that isn't https so javascript:/data:/file:/http: URLs can't
// end up clickable in pipeline.md or in the JD-cache filename hash.
export function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  const hash = createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
  return `jd-${hash}`;
}

function yamlEscape(str) {
  const s = String(str ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Lightweight HTML → text for actor description fields (enough for downstream
// snippet extraction and full evaluation, not a full parser).
export function htmlToText(s) {
  const raw = String(s || '');
  if (!raw || !/[<&]/.test(raw)) return raw.trim();
  let cleaned = raw
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n');
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/<[^>]+>/g, '');
  } while (cleaned !== prev);
  return cleaned
    // Decode &amp; LAST so `&amp;#60;` round-trips to `&#60;` not `<`.
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Write jds/{slug}-{hash}.md and return its relative path. The URL-derived hash
// keeps two distinct postings sharing a company+title from colliding. Atomic
// (flag:'wx') against the 10-worker TOCTOU race; any FS failure returns null so
// the caller falls back to the remote URL.
export function saveJd(normalized, descriptionBody, sourceLabel) {
  let relPath = null;
  try {
    mkdirSync(JDS_DIR, { recursive: true });
    const baseSlug = slugify(`${normalized.company}-${normalized.title}`);
    const urlHash = createHash('sha1')
      .update(String(normalized.url || `${normalized.company}-${normalized.title}`))
      .digest('hex')
      .slice(0, 10);
    const filename = `${baseSlug}-${urlHash}.md`;
    const filepath = join(JDS_DIR, filename);
    relPath = `${JDS_REL}/${filename}`;
    if (existsSync(filepath)) return relPath;
    const today = new Date().toISOString().slice(0, 10);
    const content = `---
title: ${yamlEscape(normalized.title)}
company: ${yamlEscape(normalized.company)}
url: ${yamlEscape(normalized.url)}
location: ${yamlEscape(normalized.location)}
scraped: "${today}"
source: ${sourceLabel}
---

# ${normalized.title} — ${normalized.company}

${descriptionBody}
`;
    writeFileSync(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    return relPath;
  } catch (err) {
    if (err?.code === 'EEXIST' && relPath) return relPath;
    console.warn(`apify: JD cache write failed for ${normalized.title} (${err.code || err.name}: ${err.message}); falling back to remote URL`);
    return null;
  }
}

export function normalizeItem(item, fieldMap, defaults) {
  const out = {
    title: String(pickField(item, fieldMap.title) || ''),
    url: String(pickField(item, fieldMap.url) || ''),
    company: fieldMap.company ? String(pickField(item, fieldMap.company) || '') : '',
    location: fieldMap.location ? String(pickField(item, fieldMap.location) || '') : '',
  };
  // Optional — absent field_map.postedAt (or an unparseable raw value) leaves
  // out.postedAt unset entirely, so scan.mjs's central age/date filters see
  // it as "no date supplied" (their existing, shared "don't penalize missing
  // data" behavior) rather than a fabricated 0/NaN that could read as ancient.
  if (fieldMap.postedAt) {
    const parsed = parsePostedAt(pickField(item, fieldMap.postedAt));
    if (parsed !== undefined) out.postedAt = parsed;
  }
  for (const [k, v] of Object.entries(defaults || {})) {
    if (!ALLOWED_DEFAULT_KEYS.has(k)) continue;
    if (!out[k]) out[k] = String(v);
  }
  return out;
}

/** The keyed provider hook. Reads APIFY_TOKEN from the plugin's scoped ctx.env. */
export default {
  provider: {
    id: 'apify',
    // Keyed providers never auto-detect (the engine also forces this to null).
    detect() { return null; },

    async fetch(entry, ctx) {
      const token = ctx?.env?.APIFY_TOKEN || process.env.APIFY_TOKEN;
      if (!hasToken(token)) {
        throw new Error('APIFY_TOKEN not set — enable apify in config/plugins.yml and add the token to .env');
      }
      if (!entry.actor) {
        throw new Error(`apify: entry ${entry.name} missing 'actor' (e.g. misceres/indeed-scraper)`);
      }
      if (
        !entry.field_map ||
        !isFieldSpec(entry.field_map.title) ||
        !isFieldSpec(entry.field_map.url) ||
        (entry.field_map.company != null && !isFieldSpec(entry.field_map.company)) ||
        (entry.field_map.location != null && !isFieldSpec(entry.field_map.location)) ||
        (entry.field_map.description != null && !isFieldSpec(entry.field_map.description)) ||
        (entry.field_map.postedAt != null && !isFieldSpec(entry.field_map.postedAt))
      ) {
        throw new Error(
          `apify: entry ${entry.name} has invalid field_map. Each of title, url, company, ` +
          `location, description, postedAt must be a string or a non-empty array of strings. title and url are required.`
        );
      }

      const opts = { token };
      if (entry.timeout_ms != null) opts.timeoutMs = entry.timeout_ms;

      const items = await runActor(entry.actor, resolveActorInput(entry, ctx), opts);

      const useLocalJd = entry.field_map.description != null;
      const sourceLabel = String(entry.actor || 'apify').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

      return items
        .map(item => {
          const normalized = normalizeItem(item, entry.field_map, entry.defaults);
          if (!normalized.title || !normalized.url) return null;
          if (!isHttpsUrl(normalized.url)) return null;
          if (!useLocalJd) return normalized;
          const descriptionBody = htmlToText(pickField(item, entry.field_map.description));
          if (!descriptionBody || descriptionBody.length < MIN_JD_BODY_CHARS) {
            return normalized;
          }
          const remoteUrl = normalized.url;
          const jdPath = saveJd(normalized, descriptionBody, sourceLabel);
          if (jdPath === null) return normalized;
          normalized.url = `local:${jdPath}`;
          normalized._remote_url = remoteUrl;
          return normalized;
        })
        .filter(j => j && j.title && j.url);
    },
  },
};
