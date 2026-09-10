// tests/apify-linkedin-date-posted.test.mjs — recall fix (defense-in-depth
// layer #2, on top of the postedAt post-fetch guard already covered by
// tests/apify-posting-freshness.test.mjs).
//
// The postedAt post-fetch filter fixes CORRECTNESS: a stale job can no
// longer pass --since. It does not fix RECALL: without this, the actor was
// always called with datePosted="anyTime" (its default), so limitPerSource
// was spent on however many stale results came back first — a genuinely
// fresh posting past that limit could go unfetched even though it would
// have passed the post-fetch filter.
//
// curious_coder/linkedin-jobs-scraper's `datePosted` enum
// ("anyTime" | "past24Hours" | "pastWeek" | "pastMonth") was confirmed via a
// zero-cost Apify input-schema validation probe (a deliberately-invalid
// value returns the full accepted enum in the 400 error body before any
// actor run starts or is billed) — not guessed, not scraped from
// documentation. This file tests the ctx.sinceMs -> datePosted mapping and
// its wiring into the exact `input` object handed to runActor(), without
// mocking or touching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const { mapSinceMsToDatePosted, resolveActorInput } =
  await import(pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T12:00:00Z');

// ── mapSinceMsToDatePosted ──────────────────────────────────────────────

test('mapSinceMsToDatePosted: no bound (null/undefined/non-numeric) leaves datePosted unset', () => {
  assert.equal(mapSinceMsToDatePosted(null, NOW), undefined);
  assert.equal(mapSinceMsToDatePosted(undefined, NOW), undefined);
  assert.equal(mapSinceMsToDatePosted(NaN, NOW), undefined);
  assert.equal(mapSinceMsToDatePosted('not a number', NOW), undefined);
});

test('mapSinceMsToDatePosted: a bound at or after "now" maps to past24Hours (tightest bucket)', () => {
  assert.equal(mapSinceMsToDatePosted(NOW, NOW), 'past24Hours');
  assert.equal(mapSinceMsToDatePosted(NOW + DAY_MS, NOW), 'past24Hours');
});

test('mapSinceMsToDatePosted: a bound within 24h maps to past24Hours', () => {
  assert.equal(mapSinceMsToDatePosted(NOW - 1 * DAY_MS, NOW), 'past24Hours');
  assert.equal(mapSinceMsToDatePosted(NOW - 23 * 60 * 60 * 1000, NOW), 'past24Hours');
});

test('mapSinceMsToDatePosted: a bound between 24h and 7 days maps to pastWeek (rounds UP, never narrower than requested)', () => {
  assert.equal(mapSinceMsToDatePosted(NOW - 1.5 * DAY_MS, NOW), 'pastWeek');
  assert.equal(mapSinceMsToDatePosted(NOW - 7 * DAY_MS, NOW), 'pastWeek');
});

test('mapSinceMsToDatePosted: a bound between 7 and 30 days maps to pastMonth', () => {
  assert.equal(mapSinceMsToDatePosted(NOW - 8 * DAY_MS, NOW), 'pastMonth');
  assert.equal(mapSinceMsToDatePosted(NOW - 30 * DAY_MS, NOW), 'pastMonth');
});

test('mapSinceMsToDatePosted: a bound past 30 days maps to anyTime', () => {
  assert.equal(mapSinceMsToDatePosted(NOW - 31 * DAY_MS, NOW), 'anyTime');
  assert.equal(mapSinceMsToDatePosted(NOW - 365 * DAY_MS, NOW), 'anyTime');
});

// ── resolveActorInput: the actual object handed to runActor() ──────────────

test('resolveActorInput: ctx.sinceMs for --since 1 produces datePosted:"past24Hours" in the actor input, for the verified LinkedIn actor', () => {
  const entry = {
    actor: 'curious_coder/linkedin-jobs-scraper',
    input: { keywords: 'Solutions Engineer', location: 'United States', limitPerSource: 20 },
  };
  // resolveActorInput calls mapSinceMsToDatePosted with the real Date.now()
  // (it doesn't thread a `now` override through), so this must be relative
  // to the real wall clock, not the fixed NOW constant used above.
  const ctx = { sinceMs: Date.now() - 6 * 60 * 60 * 1000 }; // 6 hours ago, matching a --since 1 run
  const input = resolveActorInput(entry, ctx);
  assert.equal(input.datePosted, 'past24Hours');
  assert.equal(input.keywords, 'Solutions Engineer', 'existing input fields must be preserved');
  assert.equal(input.limitPerSource, 20, 'existing input fields must be preserved');
});

test('resolveActorInput: scoped to the one verified actor — a different provider:apify actor is never touched', () => {
  const entry = {
    actor: 'misceres/indeed-scraper',
    input: { position: 'VP of Engineering', location: 'Chicago, IL', maxItems: 25 },
  };
  const input = resolveActorInput(entry, { sinceMs: Date.now() - 1000 });
  assert.equal('datePosted' in input, false, 'an unverified actor must never get a guessed datePosted field');
  assert.deepEqual(input, entry.input);
});

test('resolveActorInput: no ctx.sinceMs (no --since/--posted-after/max_posting_age_days) leaves input untouched — unchanged default behavior', () => {
  const entry = {
    actor: 'curious_coder/linkedin-jobs-scraper',
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10 },
  };
  assert.deepEqual(resolveActorInput(entry, {}), entry.input);
  assert.deepEqual(resolveActorInput(entry, undefined), entry.input);
});

test('resolveActorInput: an explicit input.datePosted already set in portals.yml is never overridden', () => {
  const entry = {
    actor: 'curious_coder/linkedin-jobs-scraper',
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10, datePosted: 'pastMonth' },
  };
  const input = resolveActorInput(entry, { sinceMs: Date.now() - 1000 }); // would otherwise map to past24Hours
  assert.equal(input.datePosted, 'pastMonth', 'explicit user config in portals.yml must win over the derived mapping');
});

test('resolveActorInput does not mutate entry.input', () => {
  const entry = {
    actor: 'curious_coder/linkedin-jobs-scraper',
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10 },
  };
  const originalInput = entry.input;
  resolveActorInput(entry, { sinceMs: Date.now() - 1000 });
  assert.equal(entry.input, originalInput, 'entry.input reference must be unchanged');
  assert.equal('datePosted' in entry.input, false, 'entry.input itself must not gain a datePosted key');
});
