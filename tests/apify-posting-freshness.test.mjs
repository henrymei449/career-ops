// tests/apify-posting-freshness.test.mjs — a LinkedIn posting weeks
// old passed a `--since 1` scan as "genuinely net-new," because
// plugins/apify/index.mjs never extracted a postedAt from the actor's
// dataset item onto the normalized Job object. scan.mjs's own age/date
// filters (buildPostingAgeFilter, buildPostedDateFilter) already treat a
// missing postedAt as "always passes" — by design, for providers that
// genuinely have no date. The bug was that EVERY apify-sourced job was
// missing postedAt unconditionally, regardless of what the actor returned,
// so `--since` was silently a no-op for the whole provider.
//
// This file tests two things kept deliberately separate:
//   1. parsePostedAt() / normalizeItem() — turning a raw actor field into a
//      correct epoch-ms Job.postedAt (or leaving it unset, never guessed).
//   2. That a populated Job.postedAt, fed into scan.mjs's EXISTING central
//      buildPostingAgeFilter, produces the freshness behavior the bug
//      report asked for. This does not retest buildPostingAgeFilter's own
//      logic (see its own coverage elsewhere) — it proves the apify path
//      now actually feeds it real data.
//
// Net-new-to-CareerOps (scan-history/pipeline/tracker dedup) is a completely
// separate downstream concern (scan.mjs's seenUrls/applications.md/
// pipeline.md checks) and is intentionally not exercised here — a job must
// pass the freshness gate on its own merits regardless of whether it has
// ever been seen before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const { parsePostedAt, normalizeItem, isFieldSpec } =
  await import(pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href);
const { buildPostingAgeFilter } =
  await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── parsePostedAt ────────────────────────────────────────────────────────

test('parsePostedAt: YYYY-MM-DD date string parses to UTC midnight epoch ms', () => {
  assert.equal(parsePostedAt('2026-08-20'), Date.parse('2026-08-20T00:00:00.000Z'));
});

test('parsePostedAt: full ISO timestamp string parses directly', () => {
  assert.equal(parsePostedAt('2026-08-20T14:03:00Z'), Date.parse('2026-08-20T14:03:00Z'));
});

test('parsePostedAt: numeric epoch ms passes through unchanged', () => {
  const ms = Date.parse('2026-08-20T00:00:00Z');
  assert.equal(parsePostedAt(ms), ms);
});

test('parsePostedAt: numeric epoch seconds is converted to ms', () => {
  const ms = Date.parse('2026-08-20T00:00:00Z');
  const seconds = ms / 1000;
  assert.equal(parsePostedAt(seconds), ms);
});

test('parsePostedAt: numeric-string epoch (ms and seconds) is converted the same way as a number', () => {
  const ms = Date.parse('2026-08-20T00:00:00Z');
  assert.equal(parsePostedAt(String(ms)), ms);
  assert.equal(parsePostedAt(String(ms / 1000)), ms);
});

test('parsePostedAt: never guesses — returns undefined for missing/empty/garbage input', () => {
  assert.equal(parsePostedAt(undefined), undefined);
  assert.equal(parsePostedAt(null), undefined);
  assert.equal(parsePostedAt(''), undefined);
  assert.equal(parsePostedAt('not a date'), undefined);
  assert.equal(parsePostedAt(NaN), undefined);
  assert.equal(parsePostedAt(Infinity), undefined);
});

// ── normalizeItem: field_map.postedAt wiring ────────────────────────────────

test('normalizeItem: maps field_map.postedAt through parsePostedAt onto Job.postedAt', () => {
  const item = { title: 'Sales Engineer', link: 'https://x.example/1', companyName: 'Acme', location: 'US', postedAt: '2026-08-20' };
  const fieldMap = { title: 'title', url: 'link', company: 'companyName', location: 'location', postedAt: 'postedAt' };
  const job = normalizeItem(item, fieldMap, {});
  assert.equal(job.postedAt, Date.parse('2026-08-20T00:00:00.000Z'));
});

test('normalizeItem: without field_map.postedAt, Job.postedAt is left unset (pre-fix, provider-wide behavior for entries that opt out)', () => {
  const item = { title: 'Sales Engineer', link: 'https://x.example/1', postedAt: '2026-08-20' };
  const fieldMap = { title: 'title', url: 'link' };
  const job = normalizeItem(item, fieldMap, {});
  assert.equal('postedAt' in job, false);
});

test('normalizeItem: field_map.postedAt present but raw value unparseable leaves Job.postedAt unset, not fabricated', () => {
  const item = { title: 'Sales Engineer', link: 'https://x.example/1', postedAt: 'sometime recently' };
  const fieldMap = { title: 'title', url: 'link', postedAt: 'postedAt' };
  const job = normalizeItem(item, fieldMap, {});
  assert.equal('postedAt' in job, false);
});

test('isFieldSpec accepts field_map.postedAt as a bare string or an ordered fallback list', () => {
  assert.equal(isFieldSpec('postedAt'), true);
  assert.equal(isFieldSpec(['postedAt', 'postedAtTimestamp']), true);
});

// ── End-to-end: apify-sourced postedAt through scan.mjs's real age filter ──
// This is the actual bug scenario: a job normalized by THIS plugin, aged by
// THE central filter scan.mjs already ships. Six cases from the bug report,
// #4 being the one that actually failed before this fix (Tristar AI).

function jobFromActorItem(rawPostedAt) {
  const item = { title: 'Sales Engineer', link: 'https://linkedin.example/jobs/view/1', postedAt: rawPostedAt };
  const fieldMap = { title: 'title', url: 'link', postedAt: 'postedAt' };
  return normalizeItem(item, fieldMap, {});
}

test('freshness case 1: posted 6 hours ago + --since 1 → eligible', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const postedIso = new Date(now - 6 * HOUR_MS).toISOString();
  const job = jobFromActorItem(postedIso);
  const filter = buildPostingAgeFilter(1, now);
  assert.equal(filter(job.postedAt), true);
});

test('freshness case 2: posted 23 hours ago + --since 1 → eligible', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const postedIso = new Date(now - 23 * HOUR_MS).toISOString();
  const job = jobFromActorItem(postedIso);
  const filter = buildPostingAgeFilter(1, now);
  assert.equal(filter(job.postedAt), true);
});

test('freshness case 3: posted 3 days ago + --since 1 → excluded', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const postedIso = new Date(now - 3 * DAY_MS).toISOString();
  const job = jobFromActorItem(postedIso);
  const filter = buildPostingAgeFilter(1, now);
  assert.equal(filter(job.postedAt), false);
});

test('freshness case 4 (the reported bug — Tristar AI): posted 3 weeks ago, never seen before + --since 1 → excluded; net-new does not override staleness', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const postedIso = new Date(now - 21 * DAY_MS).toISOString();
  const job = jobFromActorItem(postedIso);
  const filter = buildPostingAgeFilter(1, now);
  // "Never seen before" is a dedupe/history fact, not a filter input — the
  // freshness gate must reject this on posting age alone, before dedupe is
  // ever consulted. This is exactly what let the 3-week-old Tristar AI
  // posting through pre-fix: it was net-new to scan-history, and with
  // postedAt always unset, buildPostingAgeFilter's "no date = pass"
  // fallback let it through regardless of --since.
  assert.equal(filter(job.postedAt), false);
});

test('freshness case 5: a genuine repost — actor-reported postedAt updated to within the window — is eligible even though the underlying role is old', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  // The mechanism does not special-case "reposts": it trusts whatever
  // postedAt the source currently reports for the listing. A real repost
  // that bumps the source's own postedAt is indistinguishable, by design,
  // from a brand-new posting — and correctly passes.
  const repostedIso = new Date(now - 2 * HOUR_MS).toISOString();
  const job = jobFromActorItem(repostedIso);
  const filter = buildPostingAgeFilter(1, now);
  assert.equal(filter(job.postedAt), true);
});

test('regression proof: the pre-fix field_map (no postedAt key) reproduces the reported bug even when the actor DID return a 3-week-old date', () => {
  // This is the exact shape portals.yml's LinkedIn entries had before this fix:
  // title/url/company/location/description only. Even though the raw actor
  // item below carries a real, stale postedAt, the OLD field_map never reads
  // it — proving the bug was in the mapping, not in buildPostingAgeFilter or
  // in the actor's data.
  const now = Date.parse('2026-09-09T12:00:00Z');
  const staleIso = new Date(now - 21 * DAY_MS).toISOString();
  const item = { title: 'Sales Engineer', link: 'https://linkedin.example/jobs/view/1', companyName: 'Tristar AI', location: 'United States', postedAt: staleIso };
  const preFixFieldMap = { title: 'title', url: 'link', company: 'companyName', location: 'location', description: 'descriptionText' };
  const job = normalizeItem(item, preFixFieldMap, {});
  assert.equal('postedAt' in job, false, 'pre-fix field_map never extracts postedAt at all');
  const filter = buildPostingAgeFilter(1, now);
  assert.equal(filter(job.postedAt), true, 'pre-fix: a 3-week-old posting silently passes --since 1');
});

test('freshness case 6: posting date unavailable from the source → passes (documented "do not penalize missing data" policy), never asserted as "posted in last 24h"', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const job = jobFromActorItem(undefined); // actor supplied no postedAt at all
  assert.equal('postedAt' in job, false);
  const filter = buildPostingAgeFilter(1, now);
  // Passes the filter (documented policy: unknown age is not penalized) —
  // but this is a distinct, weaker claim than "confirmed posted within 24h."
  // Callers/report authors must not conflate the two.
  assert.equal(filter(job.postedAt), true);
});
