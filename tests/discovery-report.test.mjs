// tests/discovery-report.test.mjs — discovery-report.mjs turns a scheduled
// scan run's already-persisted artifacts (data/scan-runs.tsv counters,
// data/scan-history.tsv candidate detail) into the human review Markdown
// report required before the scheduled discovery tasks go live. Pure
// functions (parsing, classification, rendering) are tested in-process;
// buildReport()/the CLI, which read DATA_ROOT-anchored paths fixed at module
// load time, run in a subprocess against a fresh temp data root (same
// pattern as tests/apify-jd-cache-data-root.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NODE, rmSync } from './helpers.mjs';
import {
  parseScanRunsTsv, rowsInWindow, sumScanRunRows,
  parseScanHistoryRows, resolveCandidates, classifyCandidate, bucketCandidates,
  renderReport, stripBom,
} from '../discovery-report.mjs';

const SCAN_RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_posting_age\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\tfiltered_blacklist\tfiltered_visa\tfiltered_posted_date\tfiltered_country_eligibility\n';

function scanRunsRow(overrides = {}) {
  const c = {
    timestamp: '2026-09-10T23:00:00.000Z', status: 'completed', companies: 5, boards: 0,
    found: 20, filtered_title: 3, filtered_tier: 0, filtered_location: 1, filtered_posting_age: 2,
    filtered_salary: 0, filtered_content: 0, filtered_cooldown: 0, dupes: 4, new_added: 10, errors: 0,
    filtered_blacklist: 0, filtered_visa: 0, filtered_posted_date: 1, filtered_country_eligibility: 0,
    ...overrides,
  };
  return [c.timestamp, c.status, c.companies, c.boards, c.found, c.filtered_title, c.filtered_tier,
    c.filtered_location, c.filtered_posting_age, c.filtered_salary, c.filtered_content, c.filtered_cooldown,
    c.dupes, c.new_added, c.errors, c.filtered_blacklist, c.filtered_visa, c.filtered_posted_date,
    c.filtered_country_eligibility].join('\t');
}

test('parseScanRunsTsv reads rows by header name', () => {
  const text = SCAN_RUNS_HEADER + scanRunsRow() + '\n';
  const rows = parseScanRunsTsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].found, 20);
  assert.equal(rows[0].dupes, 4);
  assert.equal(rows[0].newAdded, 10);
  assert.equal(rows[0].filteredPostedDate, 1);
});

test('parseScanRunsTsv returns [] for an empty/missing file', () => {
  assert.deepEqual(parseScanRunsTsv(''), []);
});

test('rowsInWindow keeps only rows inside [start, end]', () => {
  const text = SCAN_RUNS_HEADER
    + scanRunsRow({ timestamp: '2026-09-10T10:00:00.000Z' }) + '\n'
    + scanRunsRow({ timestamp: '2026-09-10T23:00:00.000Z' }) + '\n'
    + scanRunsRow({ timestamp: '2026-09-11T10:00:00.000Z' }) + '\n';
  const rows = parseScanRunsTsv(text);
  const inWindow = rowsInWindow(rows, '2026-09-10T20:00:00.000Z', '2026-09-11T00:00:00.000Z');
  assert.equal(inWindow.length, 1);
  assert.equal(inWindow[0].timestamp, '2026-09-10T23:00:00.000Z');
});

test('sumScanRunRows aggregates the funnel across multiple rows and separates freshness from cheap-filter rejects', () => {
  const rows = parseScanRunsTsv(
    SCAN_RUNS_HEADER
    + scanRunsRow({ found: 10, filtered_title: 2, filtered_location: 0, filtered_posted_date: 1, filtered_posting_age: 1, dupes: 1, new_added: 5 }) + '\n'
    + scanRunsRow({ found: 8, filtered_title: 1, filtered_location: 0, filtered_posted_date: 0, filtered_posting_age: 2, dupes: 2, new_added: 3 }) + '\n',
  );
  const funnel = sumScanRunRows(rows);
  assert.equal(funnel.rawJobs, 18);
  assert.equal(funnel.freshnessRejects, 4); // (1+1) + (0+2)
  assert.equal(funnel.cheapFilterRejects, 3); // 2 + 1
  assert.equal(funnel.duplicates, 3);
  assert.equal(funnel.netNew, 8);
  assert.equal(funnel.failedRuns.length, 0);
});

test('sumScanRunRows excludes failed rows from counts but reports them', () => {
  const rows = parseScanRunsTsv(
    SCAN_RUNS_HEADER
    + scanRunsRow({ status: 'failed', found: 999, new_added: 999 }) + '\n'
    + scanRunsRow({ found: 10, new_added: 5 }) + '\n',
  );
  const funnel = sumScanRunRows(rows);
  assert.equal(funnel.rawJobs, 10);
  assert.equal(funnel.netNew, 5);
  assert.equal(funnel.failedRuns.length, 1);
});

test('parseScanHistoryRows skips the header and parses the 7 core columns', () => {
  const text = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
    + 'https://x.test/1\t2026-09-10\tLinkedIn — Foo\tSolutions Engineer\tAcme\tadded\tNew York, NY\n';
  const rows = parseScanHistoryRows(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].location, 'New York, NY');
});

test('resolveCandidates picks the LAST matching row for a repeated URL', () => {
  const text = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
    + 'https://x.test/1\t2026-09-01\tOld Portal\tOld Title\tOld Co\tskipped_expired\tRemote\n'
    + 'https://x.test/1\t2026-09-10\tLinkedIn — Foo\tSolutions Engineer\tAcme\tadded\tNew York, NY\n';
  const [candidate] = resolveCandidates(text, ['https://x.test/1']);
  assert.equal(candidate.company, 'Acme');
  assert.equal(candidate.source, 'LinkedIn — Foo');
});

test('resolveCandidates marks an unresolvable URL rather than throwing', () => {
  const [candidate] = resolveCandidates('', ['https://x.test/missing']);
  assert.equal(candidate.unresolved, true);
  assert.equal(candidate.company, 'Unknown');
});

test('classifyCandidate + bucketCandidates: NYC metro passes, non-US is excluded, bare "United States" is marginal', () => {
  const nyc = classifyCandidate({ url: 'https://x.test/1', title: 'Solutions Engineer', location: 'New York, NY', company: 'Acme', source: 'q1' });
  const nonUs = classifyCandidate({ url: 'https://x.test/2', title: 'Solutions Engineer', location: 'Warsaw, Poland', company: 'Acme', source: 'q1' });
  const vague = classifyCandidate({ url: 'https://x.test/3', title: 'Solutions Engineer', location: 'United States', company: 'Acme', source: 'q1' });

  assert.equal(nyc.bucket, 'primary');
  assert.equal(nonUs.bucket, 'excluded');
  assert.equal(vague.bucket, 'needs-validation');

  const { pass, marginal, excluded } = bucketCandidates([nyc, nonUs, vague]);
  assert.deepEqual(pass.map((c) => c.url), [nyc.url]);
  assert.deepEqual(marginal.map((c) => c.url), [vague.url]);
  assert.deepEqual(excluded.map((c) => c.url), [nonUs.url]);
});

test('renderReport: excluded candidates are never listed in PASS/MARGINAL tables, only counted', () => {
  const md = renderReport({
    kind: 'linkedin', date: '2026-09-10', runStartedAt: 'a', runFinishedAt: 'b', sinceDays: 2, modelUsed: null,
    funnel: { rawJobs: 10, freshnessRejects: 1, duplicates: 2, cheapFilterRejects: 3, netNew: 4 },
    pass: [{ company: 'Acme', title: 'Solutions Engineer', url: 'https://x.test/1', location: 'New York, NY', tier: 5, bucket: 'primary', source: 'LinkedIn — Foo', why: 'NYC metro — actionable' }],
    marginal: [],
    excludedCount: 3,
    notes: [],
    cohort: null,
    generatedAt: '2026-09-10T23:00:00.000Z',
  });
  assert.match(md, /# Discovery Report — LinkedIn Discovery — 2026-09-10/);
  assert.match(md, /\| Acme \| Solutions Engineer \|/);
  assert.match(md, /3 net-new posting\(s\) excluded from review as non-US\/noise/);
  assert.doesNotMatch(md, /Warsaw/);
});

test('renderReport: empty PASS/MARGINAL tables print "_None this run._" rather than an empty table', () => {
  const md = renderReport({
    kind: 'linkedin', date: '2026-09-10', runStartedAt: 'a', runFinishedAt: 'b', sinceDays: 2, modelUsed: null,
    funnel: { rawJobs: 0, freshnessRejects: 0, duplicates: 0, cheapFilterRejects: 0, netNew: 0 },
    pass: [], marginal: [], excludedCount: 0, notes: [], cohort: null, generatedAt: '2026-09-10T23:00:00.000Z',
  });
  assert.match(md, /_None this run\._/);
});

test('renderReport: top100 kind includes the Employer Coverage section; linkedin kind does not', () => {
  const base = {
    date: '2026-09-10', runStartedAt: 'a', runFinishedAt: 'b', sinceDays: null, modelUsed: 'claude-sonnet-5',
    funnel: { rawJobs: 0, freshnessRejects: 0, duplicates: 0, cheapFilterRejects: 0, netNew: 0 },
    pass: [], marginal: [], excludedCount: 0, notes: [], generatedAt: '2026-09-10T23:00:00.000Z',
  };
  const top100Md = renderReport({
    ...base, kind: 'top100',
    cohort: { providerBacked: ['Manufacturo'], handoffAttempted: ['Siemens Digital Industries Software'], blockedUnresolved: [{ name: 'CubeFabs', reason: 'Playwright timeout' }] },
  });
  assert.match(top100Md, /## 6\. Top-100 Employer Coverage/);
  assert.match(top100Md, /Provider-backed, completed: 1/);
  assert.match(top100Md, /CubeFabs — Playwright timeout/);

  const linkedinMd = renderReport({ ...base, kind: 'linkedin', cohort: null });
  assert.doesNotMatch(linkedinMd, /Top-100 Employer Coverage/);
});

// ── buildReport() / CLI — subprocess against a fresh temp data root ────

function freshDataRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'co-discovery-report-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
}

function runCli(args, dataRoot) {
  try {
    const out = execFileSync(NODE, [join(ROOT, 'discovery-report.mjs'), ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
    });
    return { out, exitCode: 0 };
  } catch (err) {
    return { out: (err.stdout || '') + (err.stderr || ''), exitCode: err.status };
  }
}

test('stripBom removes a leading UTF-8 BOM (PowerShell -Encoding utf8 writes one)', () => {
  assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('CLI: end-to-end writes reports/discovery/{date}_{kind}.md from scan-runs.tsv + scan-history.tsv', () => {
  const dataRoot = freshDataRoot();
  try {
    writeFileSync(join(dataRoot, 'data', 'scan-runs.tsv'), SCAN_RUNS_HEADER
      + scanRunsRow({ timestamp: '2026-09-10T21:00:00.000Z', found: 10, new_added: 1, dupes: 0, filtered_title: 0, filtered_posted_date: 0, filtered_posting_age: 0, filtered_location: 0 }) + '\n');
    writeFileSync(join(dataRoot, 'data', 'scan-history.tsv'),
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
      + 'https://x.test/1\t2026-09-10\tLinkedIn — Solution Consultant Manufacturing\tSolutions Engineer\tAcme\tadded\tNew York, NY\n');

    const payload = {
      kind: 'linkedin',
      date: '2026-09-10',
      runStartedAt: '2026-09-10T20:59:00.000Z',
      runFinishedAt: '2026-09-10T21:05:00.000Z',
      sinceDays: 2,
      receipts: [{ added_urls: ['https://x.test/1'], errors: [] }],
      notes: [],
    };
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(payload));

    const { out, exitCode } = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${out}`);
    const receipt = JSON.parse(out.trim());
    const expectedPath = join(dataRoot, 'reports', 'discovery', '2026-09-10_linkedin.md');
    assert.equal(receipt.path, expectedPath);
    assert.ok(existsSync(expectedPath));

    const md = readFileSync(expectedPath, 'utf-8');
    assert.match(md, /# Discovery Report — LinkedIn Discovery — 2026-09-10/);
    assert.match(md, /\| Acme \| Solutions Engineer \|/);
    assert.match(md, /Tier 5 — Primary \(actionable\)/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI: --payload missing runStartedAt fails loudly rather than writing a report', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify({ kind: 'linkedin', date: '2026-09-10', receipts: [] }));
    const { exitCode } = runCli(['--payload', payloadPath], dataRoot);
    assert.notEqual(exitCode, 0);
    assert.equal(existsSync(join(dataRoot, 'reports')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
