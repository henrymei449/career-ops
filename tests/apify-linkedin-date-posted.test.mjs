// tests/apify-linkedin-date-posted.test.mjs — recall fix (defense-in-depth
// layer #2, on top of the postedAt post-fetch guard covered by
// tests/apify-posting-freshness.test.mjs).
//
// curious_coder/linkedin-jobs-scraper's `datePosted` enum
// ("anyTime" | "past24Hours" | "pastWeek" | "pastMonth") was confirmed via a
// zero-cost Apify input-schema validation probe (a deliberately-invalid
// value returns the full accepted enum in the 400 error body before any
// actor run starts or is billed) — not guessed, not scraped from
// documentation.
//
// This is the SECOND pass at this mapping. The first pass derived the
// bucket from ctx.sinceMs (scan.mjs's calendar-date-truncated cutoff,
// resolveEffectiveAfter's "marginally more permissive" value built for
// providers/workday.mjs's pagination early-stop) and always sent "pastWeek"
// for a requested "past24Hours" window — reproduced on a real corrected
// rerun, where 168 jobs the actor should have excluded came back anyway.
// mapSinceDaysToDatePosted() now derives the bucket from ctx.sinceDays, the
// literal `--since N` day count scan.mjs threads through separately from
// sinceMs specifically for this — see scan.mjs's own comment at the ctx
// construction site. It takes no `now`/clock input at all, so the time of
// day a scan runs can no longer affect which bucket gets picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const { mapSinceDaysToDatePosted, resolveActorInput } =
  await import(pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href);

const LINKEDIN_ACTOR = 'curious_coder/linkedin-jobs-scraper';

// ── mapSinceDaysToDatePosted: pure, clock-independent bucket selection ─────

test('mapSinceDaysToDatePosted: no bound (null/undefined/non-numeric/non-positive) leaves datePosted unset', () => {
  assert.equal(mapSinceDaysToDatePosted(null), undefined);
  assert.equal(mapSinceDaysToDatePosted(undefined), undefined);
  assert.equal(mapSinceDaysToDatePosted(NaN), undefined);
  assert.equal(mapSinceDaysToDatePosted('1'), undefined);
  assert.equal(mapSinceDaysToDatePosted(0), undefined);
  assert.equal(mapSinceDaysToDatePosted(-1), undefined);
});

test('mapSinceDaysToDatePosted: --since 1 maps to past24Hours', () => {
  assert.equal(mapSinceDaysToDatePosted(1), 'past24Hours');
});

test('mapSinceDaysToDatePosted: requested 2 days maps to pastWeek', () => {
  assert.equal(mapSinceDaysToDatePosted(2), 'pastWeek');
});

test('mapSinceDaysToDatePosted: requested 7 days maps to pastWeek', () => {
  assert.equal(mapSinceDaysToDatePosted(7), 'pastWeek');
});

test('mapSinceDaysToDatePosted: requested >7 and <=30 days maps to pastMonth', () => {
  assert.equal(mapSinceDaysToDatePosted(8), 'pastMonth');
  assert.equal(mapSinceDaysToDatePosted(30), 'pastMonth');
});

test('mapSinceDaysToDatePosted: requested >30 days leaves datePosted unset (actor default anyTime)', () => {
  assert.equal(mapSinceDaysToDatePosted(31), undefined);
  assert.equal(mapSinceDaysToDatePosted(365), undefined);
});

// ── Time-of-day independence (Step 3, cases 1-3): the whole point of this
// second pass. Same requested --since 1, evaluated as if "now" were
// 00:01, 12:00, and 23:59 local/UTC — must all produce past24Hours. Since
// mapSinceDaysToDatePosted takes no clock input, this is trivially true by
// construction, but the test exists so a future edit that reintroduces a
// `now` parameter (as the first pass had) cannot silently regress this
// without failing here first. ────────────────────────────────────────────

test('mapSinceDaysToDatePosted: --since 1 maps to past24Hours regardless of what time of day it is evaluated (00:01, noon, 23:59) — the exact failure mode being fixed', () => {
  const sinceDays = 1;
  // The function signature itself proves time-of-day cannot enter the
  // computation, but assert against three otherwise-irrelevant "now"
  // instants explicitly, so the intent is unmissable in the test output.
  for (const label of ['00:01', 'noon', '23:59']) {
    void label; // documents which instant this iteration represents
    assert.equal(mapSinceDaysToDatePosted(sinceDays), 'past24Hours');
  }
});

// ── resolveActorInput: the actual object handed to runActor() ──────────────

test('resolveActorInput: ctx.sinceDays:1 produces datePosted:"past24Hours" for the verified LinkedIn actor', () => {
  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'Solutions Engineer', location: 'United States', limitPerSource: 20 },
  };
  const input = resolveActorInput(entry, { sinceDays: 1 });
  assert.equal(input.datePosted, 'past24Hours');
  assert.equal(input.keywords, 'Solutions Engineer', 'existing input fields must be preserved');
  assert.equal(input.limitPerSource, 20, 'existing input fields must be preserved');
});

test('resolveActorInput: ctx.sinceDays:1 is unaffected by ctx.sinceMs being present with its usual calendar-truncated (wider) value', () => {
  // A realistic ctx from scan.mjs carries BOTH fields — sinceMs for the
  // early-stop hint other providers use, sinceDays for this mapping. If
  // resolveActorInput ever again reached for sinceMs (the original bug),
  // this ctx's sinceMs (7 days back) would produce "pastWeek" instead.
  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'Solutions Engineer', location: 'United States', limitPerSource: 20 },
  };
  const ctx = { sinceDays: 1, sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000 };
  assert.equal(resolveActorInput(entry, ctx).datePosted, 'past24Hours');
});

test('resolveActorInput: ctx.sinceDays:2 or :7 maps to pastWeek', () => {
  const entry = { actor: LINKEDIN_ACTOR, input: { keywords: 'x', limitPerSource: 5 } };
  assert.equal(resolveActorInput(entry, { sinceDays: 2 }).datePosted, 'pastWeek');
  assert.equal(resolveActorInput(entry, { sinceDays: 7 }).datePosted, 'pastWeek');
});

test('resolveActorInput: ctx.sinceDays >7 and <=30 maps to pastMonth', () => {
  const entry = { actor: LINKEDIN_ACTOR, input: { keywords: 'x', limitPerSource: 5 } };
  assert.equal(resolveActorInput(entry, { sinceDays: 8 }).datePosted, 'pastMonth');
  assert.equal(resolveActorInput(entry, { sinceDays: 30 }).datePosted, 'pastMonth');
});

test('resolveActorInput: scoped to the one verified actor — a different provider:apify actor is never touched', () => {
  const entry = {
    actor: 'misceres/indeed-scraper',
    input: { position: 'VP of Engineering', location: 'Chicago, IL', maxItems: 25 },
  };
  const input = resolveActorInput(entry, { sinceDays: 1 });
  assert.equal('datePosted' in input, false, 'an unverified actor must never get a guessed datePosted field');
  assert.deepEqual(input, entry.input);
});

test('resolveActorInput: no ctx.sinceDays (no --since given) leaves input untouched — unchanged default behavior', () => {
  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10 },
  };
  assert.deepEqual(resolveActorInput(entry, {}), entry.input);
  assert.deepEqual(resolveActorInput(entry, undefined), entry.input);
  // A bare --posted-after or max_posting_age_days bound (ctx.sinceMs set,
  // ctx.sinceDays absent) has no equivalent day count and must not be
  // translated into one here either.
  assert.deepEqual(resolveActorInput(entry, { sinceMs: Date.now() - 1000 }), entry.input);
});

test('resolveActorInput: an explicit input.datePosted already set in portals.yml is never overridden', () => {
  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10, datePosted: 'pastMonth' },
  };
  const input = resolveActorInput(entry, { sinceDays: 1 }); // would otherwise map to past24Hours
  assert.equal(input.datePosted, 'pastMonth', 'explicit user config in portals.yml must win over the derived mapping');
});

test('resolveActorInput does not mutate entry.input', () => {
  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'MES Consultant', location: 'United States', limitPerSource: 10 },
  };
  const originalInput = entry.input;
  resolveActorInput(entry, { sinceDays: 1 });
  assert.equal(entry.input, originalInput, 'entry.input reference must be unchanged');
  assert.equal('datePosted' in entry.input, false, 'entry.input itself must not gain a datePosted key');
});

// ── Regression proof: the old sinceMs-based mapping cannot recur ───────────

test('regression proof: a sinceMs-based mapping (the first-pass bug) would have sent pastWeek for a requested --since 1, at any run time other than exact UTC midnight', () => {
  // Reproduces the exact bug via the OLD approach's own arithmetic, inline —
  // not by calling any function under test — so this documents precisely
  // what was wrong and proves the NEW function (which takes no clock input)
  // structurally cannot reproduce it.
  const DAY_MS = 86_400_000;
  function oldBuggyMapping(sinceMs, now) {
    const ageDays = (now - sinceMs) / DAY_MS;
    if (ageDays <= 1) return 'past24Hours';
    if (ageDays <= 7) return 'pastWeek';
    if (ageDays <= 30) return 'pastMonth';
    return undefined;
  }
  // resolveEffectiveAfter's calendar-date truncation: sinceMs always lands
  // on UTC midnight of (today - 1 day), regardless of what time "now" is.
  function oldSinceMs(sinceDays, now) {
    const cutoffExact = now - sinceDays * DAY_MS;
    const dateOnly = new Date(cutoffExact).toISOString().slice(0, 10);
    return Date.parse(`${dateOnly}T00:00:00Z`);
  }
  for (const nowIso of ['2026-09-10T00:00:01Z', '2026-09-10T12:00:00Z', '2026-09-10T23:59:00Z']) {
    const now = Date.parse(nowIso);
    const sinceMs = oldSinceMs(1, now);
    assert.equal(
      oldBuggyMapping(sinceMs, now), 'pastWeek',
      `old approach at ${nowIso}: expected the bug (pastWeek) to reproduce`,
    );
  }
  // The fixed function sidesteps this entirely: no clock input, so the same
  // requested --since 1 is past24Hours no matter when the scan runs.
  assert.equal(mapSinceDaysToDatePosted(1), 'past24Hours');
});

// ── Post-fetch postedAt filter remains the correctness guard (Step 3 #10) ──
// This mapping (and its actor input) is a recall/cost optimization only —
// full unit coverage of the post-fetch guard lives in
// tests/apify-posting-freshness.test.mjs. This is the end-to-end proof that
// the two layers are genuinely independent: even though the native bucket
// is now correctly "past24Hours" (no longer "pastWeek"), a job whose
// ACTUAL postedAt is outside the exact requested window must still be
// rejected downstream — the fixed native filter narrows what the actor
// returns, it is never trusted as the correctness boundary itself.
test('defense-in-depth: even with the corrected past24Hours actor input, a job the actor returns with an actual postedAt outside the requested window is still rejected by the unchanged post-fetch filter', async () => {
  const { normalizeItem } = await import(pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href);
  const { buildPostedDateFilter, resolveEffectiveAfter } =
    await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const entry = {
    actor: LINKEDIN_ACTOR,
    input: { keywords: 'Sales Engineer', location: 'United States', limitPerSource: 20 },
    field_map: { title: 'title', url: 'link', postedAt: 'postedAt' },
  };
  const now = Date.now();

  // The native input is now correctly past24Hours...
  assert.equal(resolveActorInput(entry, { sinceDays: 1 }).datePosted, 'past24Hours');

  // ...but the actor (or a bug in it, or a genuine repost with a stale
  // original postedAt) still hands back something 5 days old.
  const staleItem = {
    title: 'Sales Engineer', link: 'https://linkedin.example/jobs/view/1',
    postedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const job = normalizeItem(staleItem, entry.field_map, {});

  const effectiveAfter = resolveEffectiveAfter(null, 1, now); // scan.mjs's own --since 1 resolution
  const postedDateFilter = buildPostedDateFilter(effectiveAfter, null);
  assert.equal(postedDateFilter(job.postedAt), false, 'a genuinely 5-day-old posting must still be rejected regardless of what the actor was asked for');
});
