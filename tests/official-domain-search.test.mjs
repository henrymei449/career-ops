import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiteQuery, inScope, canonicalizeJobUrl, classifyJobUrl, collectCandidates, extractJobFields,
} from '../lib/official-domain-search.mjs';

const ADP = {
  host: 'myjobs.adp.com', pathPrefix: '/advantestcareers', keepParams: ['reqId'],
  jobPathRe: /\/cx\/job-details\?.*reqId=\d+/i,
};

test('buildSiteQuery scopes to host + path prefix', () => {
  assert.equal(buildSiteQuery(ADP, 'engineer'), 'site:myjobs.adp.com/advantestcareers engineer');
});

test('inScope: exact host and tenant path prefix only', () => {
  assert.ok(inScope('https://myjobs.adp.com/advantestcareers/cx/job-details?reqId=1', ADP));
  assert.ok(!inScope('https://myjobs.adp.com/ftdcareers?cid=1', ADP), 'other ADP tenant');
  assert.ok(!inScope('https://evil.example/advantestcareers', ADP));
  assert.ok(!inScope('https://sub.myjobs.adp.com/advantestcareers', ADP));
  assert.ok(!inScope('ftp://myjobs.adp.com/advantestcareers', ADP));
  assert.ok(!inScope('not a url', ADP));
});

test('canonicalizeJobUrl keeps only allowlisted params', () => {
  const a = canonicalizeJobUrl('https://MYJOBS.adp.com/advantestcareers/cx/job-details?__tx_annotation=false&rb=INDEED&reqId=5001&c=2168307#x', ADP);
  const b = canonicalizeJobUrl('https://myjobs.adp.com/advantestcareers/cx/job-details/?reqId=5001', ADP);
  assert.equal(a, 'https://myjobs.adp.com/advantestcareers/cx/job-details?reqId=5001');
  assert.equal(a, b);
  assert.equal(canonicalizeJobUrl('javascript:alert(1)', ADP), '');
});

test('classifyJobUrl: job shape vs landing/document/generic-title', () => {
  const ok = 'https://myjobs.adp.com/advantestcareers/cx/job-details?reqId=5001';
  assert.equal(classifyJobUrl(ok, ADP, 'Lead Application Engineer - Careers - ADP').likelyJob, true);
  assert.equal(classifyJobUrl('https://myjobs.adp.com/advantestcareers?c=1', ADP).likelyJob, false);
  assert.equal(classifyJobUrl(ok, ADP, 'Career Site - ADP').reason, 'generic-title');
  assert.equal(classifyJobUrl('https://myjobs.adp.com/advantestcareers/x.pdf', ADP).reason, 'document');
});

test('collectCandidates: caps per query, dedupes across queries, drops out-of-scope, no fetch', async () => {
  const mk = (id, extra = '') => ({ title: `Job ${id}`, url: `https://myjobs.adp.com/advantestcareers/cx/job-details?${extra}reqId=${id}` });
  const calls = [];
  const search = async (q) => {
    calls.push(q);
    return [mk(1), mk(1, 'rb=INDEED&'), mk(2), { title: 'x', url: 'https://myjobs.adp.com/ftdcareers?cid=1' }, mk(3)];
  };
  const { stats, candidates } = await collectCandidates({ search, profile: ADP, terms: ['a', 'b'], maxPerQuery: 4, maxUnique: 100 });
  assert.equal(calls.length, 2);
  assert.equal(stats.resultsReturned, 8, 'sliced to maxPerQuery=4 per query');
  assert.equal(stats.outOfScope, 2);
  assert.equal(candidates.length, 2, 'reqIds 1 and 2 only (3 is past the per-query cap)');
  assert.ok(stats.duplicatesRemoved >= 2);
  assert.equal(stats.coverageTruncated, false);
});

test('collectCandidates: unique cap stops further queries and flags truncation', async () => {
  let n = 0;
  const search = async () => Array.from({ length: 5 }, () => ({ title: 't', url: `https://myjobs.adp.com/advantestcareers/cx/job-details?reqId=${++n}` }));
  const { stats, candidates } = await collectCandidates({ search, profile: ADP, terms: ['a', 'b', 'c', 'd'], maxPerQuery: 5, maxUnique: 7 });
  assert.equal(candidates.length, 7);
  assert.equal(stats.coverageTruncated, true);
  assert.ok(stats.queries <= 2, 'no queries issued after the cap');
});

test('extractJobFields: JSON-LD JobPosting, title fallback, never infers location', () => {
  const ld = '<script type="application/ld+json">{"@type":"JobPosting","title":"Applications Engineer","jobLocation":{"address":{"addressLocality":"Austin","addressRegion":"TX"}}}</script>';
  assert.deepEqual(extractJobFields(ld), { title: 'Applications Engineer', location: 'Austin, TX', confidence: 'high', method: 'json-ld' });
  const ldNoLoc = '<script type="application/ld+json">{"@type":"JobPosting","title":"X"}</script>';
  assert.equal(extractJobFields(ldNoLoc).location, 'unavailable');
  const plain = extractJobFields('<html><title>Careers</title><h1>Field Engineer &amp; Support</h1></html>');
  assert.equal(plain.title, 'Field Engineer & Support');
  assert.equal(plain.location, 'unavailable');
  assert.equal(plain.confidence, 'low');
  assert.equal(extractJobFields('<html></html>').confidence, 'none');
});

const WD = {
  host: 'wd1.myworkdaysite.com', pathPrefix: '/recruiting/onto', keepParams: [],
  jobPathRe: /\/onto_careers\/(job\/|details\/)/i, reqIdRe: /_(r-\d+)/i,
  stripPathSuffixRe: /\/apply$/i, lowercasePath: true, preferRe: /\/job\//i,
};

test('workday profile: /apply, path case and /details/ collapse to one requisition', async () => {
  assert.equal(
    canonicalizeJobUrl('https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Hillsboro-OR/Sr-Dir_R-5248/apply', WD),
    'https://wd1.myworkdaysite.com/recruiting/onto/onto_careers/job/hillsboro-or/sr-dir_r-5248');
  assert.equal(classifyJobUrl('https://wd1.myworkdaysite.com/recruiting/onto/onto_careers/details/accountant-3_r-5025-1', WD, 'Search for Jobs').likelyJob, true);
  const search = async () => [
    { title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/onto_careers/details/accountant-3_r-5025-1' },
    { title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Accountant-3_R-5025' },
    { title: 'a', url: 'https://wd1.myworkdaysite.com/recruiting/onto/ONTO_Careers/job/Milpitas-CA/Accountant-3_R-5025/apply' },
  ];
  const { candidates, stats } = await collectCandidates({ search, profile: WD, terms: ['x'] });
  assert.equal(candidates.length, 1);
  assert.equal(stats.duplicatesRemoved, 2);
  assert.match(candidates[0].canonicalUrl, /\/job\/milpitas-ca\/accountant-3_r-5025$/, 'the /job/ form is preferred over /details/');
});

test('buildSiteQuery honours queryScope/queryExtra without loosening inScope', () => {
  const H = { host: 'www.horiba.com', queryScope: 'horiba.com', queryExtra: '"job-specification"', jobPathRe: /x/ };
  assert.equal(buildSiteQuery(H, 'engineer'), 'site:horiba.com "job-specification" engineer');
  assert.ok(inScope('https://www.horiba.com/int/company/career/job-specification/action/show/Job/a-1', H));
  assert.ok(!inScope('https://shop.horiba.com/x', H), 'other HORIBA host stays out of scope');
});
