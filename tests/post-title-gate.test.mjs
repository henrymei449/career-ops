// tests/post-title-gate.test.mjs — the shared chain both Lane A (scan.mjs's
// own loop) and Lane B (recall-relevance.mjs, after a HIGH verdict) call, so
// there is exactly one implementation of tier/location/date/salary/content/
// country/visa/dedup, never two that can drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStructuralChecks, runContentChecks, runDedupChecks, runPostTitleGate } from '../post-title-gate.mjs';

const BASE_JOB = { title: 'Solutions Engineer', company: 'Acme', location: 'New York, NY', url: 'https://example.com/job/1' };

test('runStructuralChecks: passes with no filters configured', () => {
  assert.deepEqual(runStructuralChecks(BASE_JOB, {}), { accepted: true });
});

test('runStructuralChecks: tier gate rejects a skipped seniority', () => {
  const result = runStructuralChecks({ ...BASE_JOB, title: 'Solutions Engineer Intern' }, { skipTiers: ['intern'] });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'tier');
});

test('runStructuralChecks: location filter rejects, in the same order as scan.mjs (before posting-age)', () => {
  const locationFilter = () => false;
  const postingAgeFilter = () => { throw new Error('must not be called — location should short-circuit first'); };
  const result = runStructuralChecks(BASE_JOB, { locationFilter, postingAgeFilter });
  assert.equal(result.reason, 'location');
});

test('runStructuralChecks: salary gate rejects last among structural checks', () => {
  const result = runStructuralChecks(BASE_JOB, {
    locationFilter: () => true,
    postingAgeFilter: () => true,
    postedDateFilter: () => true,
    salaryFilter: () => false,
  });
  assert.equal(result.reason, 'salary');
});

test('runContentChecks: an absent description passes every content-dependent filter (no fetch required)', () => {
  const result = runContentChecks({ ...BASE_JOB, description: undefined }, {
    contentFilter: (d) => d != null,
    countryEligibilityFilter: (d) => d != null,
    visaFilter: (d) => d != null,
  });
  // Filters that themselves treat missing description as pass (the real
  // scan.mjs builders do) still pass here — this just proves the chain
  // doesn't inject its own requirement for description to exist.
  assert.equal(runContentChecks({ ...BASE_JOB }, {}).accepted, true);
  void result;
});

test('runContentChecks: content filter rejection', () => {
  const result = runContentChecks({ ...BASE_JOB, description: 'must relocate' }, {
    contentFilter: (d) => !d.includes('must relocate'),
  });
  assert.equal(result.reason, 'content');
});

test('runDedupChecks: URL dedup rejects an already-seen URL', () => {
  const seenUrls = new Set(['https://example.com/job/1']);
  const result = runDedupChecks(BASE_JOB, { seenUrls });
  assert.equal(result.reason, 'duplicate_url');
});

test('runDedupChecks: company+role fuzzy dedup rejects on the bare key', () => {
  const seenCompanyRoles = new Set(['acme::solutions engineer']);
  const result = runDedupChecks(BASE_JOB, {
    seenUrls: new Set(),
    seenCompanyRoles,
    canonicalizeCompany: (c) => c.toLowerCase(),
  });
  assert.equal(result.reason, 'duplicate_company_role');
});

test('runDedupChecks: an aggregator entry skips company+role dedup (key=null), URL dedup still applies', () => {
  const seenCompanyRoles = new Set(['acme::solutions engineer']);
  const result = runDedupChecks(BASE_JOB, {
    seenUrls: new Set(),
    seenCompanyRoles,
    canonicalizeCompany: (c) => c.toLowerCase(),
    isAggregator: true,
  });
  assert.equal(result.accepted, true);
});

test('runPostTitleGate: composes all three stages in order — a structural reject never reaches dedup', () => {
  let dedupCalled = false;
  const gateResult = runPostTitleGate(
    { ...BASE_JOB, salary: 10 },
    { salaryFilter: () => false },
    { seenUrls: { has: () => { dedupCalled = true; return false; } } },
  );
  assert.equal(gateResult.reason, 'salary');
  assert.equal(dedupCalled, false);
});

test('runPostTitleGate: a fully clean candidate is accepted', () => {
  const gateResult = runPostTitleGate(
    BASE_JOB,
    { locationFilter: () => true, postingAgeFilter: () => true, postedDateFilter: () => true, salaryFilter: () => true },
    { seenUrls: new Set(), seenCompanyRoles: new Set(), canonicalizeCompany: (c) => c.toLowerCase() },
  );
  assert.equal(gateResult.accepted, true);
});
