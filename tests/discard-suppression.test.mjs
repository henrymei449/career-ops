// tests/discard-suppression.test.mjs — the four required cases for
// data/discard.log's suppression semantics, plus the scan.mjs wiring that
// makes an explicit (SKIP_COMPANY) marker actually filter postings.
//
// Danger being fixed: a discard.log reason that merely NAMES a company in
// passing ("SKIP per user decision (skip Deloitte) -- 5+ yrs Siemens
// Opcenter specifically required; ...") must never be read -- by code, or by
// an agent skimming the log for context -- as a standing "skip this whole
// company" policy. Every existing entry is a per-requisition judgment.
// Company-wide suppression now requires the literal `(SKIP_COMPANY)` marker,
// which no pre-existing entry has, so old rows are safe by construction with
// no data migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync as _rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  extractCompanyWideSkip, buildSuppressionIndexFromText, isSuppressed,
} from '../discard-suppression.mjs';

const rmSync = (target, opts = {}) => _rmSync(target, { maxRetries: 10, retryDelay: 100, ...opts });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scan.mjs');
const NODE = process.execPath;

const DELOITTE_REQ_A = 'https://apply.deloitte.com/en_US/careers/JobDetail/req-A/351743';
const DELOITTE_REQ_B = 'https://apply.deloitte.com/en_US/careers/JobDetail/req-B/999999';

// ── extractCompanyWideSkip ──────────────────────────────────────────────

test('extractCompanyWideSkip: old-style "(skip Company)" phrasing (no marker) is never recognized', () => {
  assert.equal(extractCompanyWideSkip('SKIP per user decision (skip Deloitte) -- 5+ yrs Siemens Opcenter specifically required'), null);
  assert.equal(extractCompanyWideSkip('SKIP per user decision (skip PTC) -- Arena PLM/QMS data migration'), null);
  assert.equal(extractCompanyWideSkip('too senior, not a fit'), null);
});

test('extractCompanyWideSkip: recognizes the explicit marker and extracts the company name', () => {
  assert.equal(extractCompanyWideSkip('(SKIP_COMPANY) Deloitte -- candidate decision, never apply here again'), 'Deloitte');
  assert.equal(extractCompanyWideSkip('(SKIP_COMPANY) Aras'), 'Aras');
});

// ── Required case 1: role-level skip never suppresses a sibling req ─────

test('REQUIRED 1: a skipped Deloitte req does not suppress a different Deloitte req', () => {
  const log = [
    `2026-09-09T17:24:32Z\t${DELOITTE_REQ_A}\tSKIP per user decision (skip Deloitte) -- 5+ yrs Siemens Opcenter specifically required; 50% travel`,
  ].join('\n');
  const index = buildSuppressionIndexFromText(log);

  const reqA = isSuppressed({ url: DELOITTE_REQ_A, company: 'Deloitte' }, index);
  assert.equal(reqA.suppressed, true);
  assert.equal(reqA.scope, 'url'); // exact req only

  const reqB = isSuppressed({ url: DELOITTE_REQ_B, company: 'Deloitte' }, index);
  assert.equal(reqB.suppressed, false, 'a different Deloitte req must not be suppressed by an unrelated per-req skip');
});

// ── Required case 2: explicit marker suppresses the whole company ───────

test('REQUIRED 2: (SKIP_COMPANY) Deloitte suppresses every Deloitte role, including ones never seen before', () => {
  const log = `2026-09-09T17:24:32Z\t${DELOITTE_REQ_A}\t(SKIP_COMPANY) Deloitte -- candidate decision, do not resurface this employer`;
  const index = buildSuppressionIndexFromText(log);

  const reqA = isSuppressed({ url: DELOITTE_REQ_A, company: 'Deloitte' }, index);
  assert.equal(reqA.suppressed, true);

  const reqB = isSuppressed({ url: DELOITTE_REQ_B, company: 'Deloitte' }, index);
  assert.equal(reqB.suppressed, true, 'a never-before-seen Deloitte req must also be suppressed once the company-wide marker is set');
  assert.equal(reqB.scope, 'company');

  // Company match is case/whitespace-insensitive via normalizeCompany, same
  // as blacklist.md matching -- not a NEW leniency, just consistency.
  const reqC = isSuppressed({ url: 'https://apply.deloitte.com/req-C', company: '  DELOITTE  ' }, index);
  assert.equal(reqC.suppressed, true);
});

// ── Required case 3: exact URL/req previously skipped remains suppressed ─

test('REQUIRED 3: an exact previously-skipped URL/req remains suppressed regardless of company field', () => {
  const log = `2026-09-09T17:24:32Z\t${DELOITTE_REQ_A}\tSKIP per user decision -- comp below floor`;
  const index = buildSuppressionIndexFromText(log);

  // Same URL, even with tracking params / trailing slash / different case in
  // the path — normalizeUrlForDedup is the same canonicalization scan.mjs
  // itself uses for all other dedup, so this stays consistent with "already
  // seen" elsewhere in the pipeline.
  const result = isSuppressed({ url: DELOITTE_REQ_A + '?utm_source=li', company: 'Deloitte' }, index);
  assert.equal(result.suppressed, true);
  assert.equal(result.scope, 'url');
});

// ── Required case 4: similar company names never cross-suppress ────────

test('REQUIRED 4: company-name similarity alone never triggers suppression', () => {
  const log = '2026-09-09T17:24:32Z\thttps://aras.example/req-1\t(SKIP_COMPANY) Aras -- candidate decision';
  const index = buildSuppressionIndexFromText(log);

  assert.equal(isSuppressed({ url: 'https://aras.example/req-2', company: 'Aras' }, index).suppressed, true);

  // Textually similar but a genuinely different normalizeCompany() key.
  for (const other of ['Arastech', 'Aras Consulting Group', 'ARASOFT', 'Ara']) {
    const result = isSuppressed({ url: 'https://other.example/req-x', company: other }, index);
    assert.equal(result.suppressed, false, `"${other}" must not be suppressed by an "Aras" company-wide marker`);
  }
});

// ── Edge cases ────────────────────────────────────────────────────────

test('buildSuppressionIndexFromText: empty/whitespace-only log yields empty indexes', () => {
  const index = buildSuppressionIndexFromText('');
  assert.equal(index.urlIndex.size, 0);
  assert.equal(index.companyIndex.size, 0);
});

test('isSuppressed: an offer with no discard.log history at all is never suppressed', () => {
  const index = buildSuppressionIndexFromText(`2026-09-09T17:24:32Z\thttps://other.example/req\t(SKIP_COMPANY) SomeOtherCo`);
  const result = isSuppressed({ url: 'https://unrelated.example/req', company: 'Unrelated Co' }, index);
  assert.equal(result.suppressed, false);
});

test('first company-wide marker for a given company wins (stable, does not flip on a later contradicting line)', () => {
  const log = [
    '2026-09-01T00:00:00Z\thttps://a.example/1\t(SKIP_COMPANY) Deloitte -- first',
    '2026-09-05T00:00:00Z\thttps://a.example/2\tSKIP per user decision -- unrelated, no marker',
  ].join('\n');
  const index = buildSuppressionIndexFromText(log);
  assert.equal(index.companyIndex.get('deloitte').reason.includes('first'), true);
});

// ── scan.mjs wiring: an explicit marker actually filters postings ───────

// providers/local-parser.mjs refuses a parser script outside the project
// root (path traversal guard), so the fixture must be a real in-repo file
// (test-fixtures/discard-suppression-parser.mjs) referenced by a REPO-
// RELATIVE path, not an absolute temp path.
const FIXTURE_PARSER_REL = 'test-fixtures/discard-suppression-parser.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-discard-suppress-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');

  const portals = [
    'tracked_companies:',
    '  - name: Deloitte',
    '    careers_url: https://careers.example.com/deloitte',
    '    scan_method: local_parser',
    '    enabled: true',
    '    parser:',
    '      command: node',
    `      script: ${JSON.stringify(FIXTURE_PARSER_REL)}`,
    'job_boards: []',
    '',
  ].join('\n');
  writeFileSync(join(root, 'portals.yml'), portals);
  return root;
}

function runScan(root) {
  return spawnSync(NODE, [SCAN, '--dry-run', '--json'], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('scan.mjs wiring: a discard.log entry WITHOUT the marker does not filter a Deloitte posting', () => {
  const root = workspace();
  try {
    writeFileSync(join(root, 'data', 'discard.log'),
      '2026-09-09T17:24:32Z\thttps://apply.deloitte.com/some/other/req\tSKIP per user decision (skip Deloitte) -- comp below floor\n');
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 1, 'an unrelated old-style discard.log entry must not filter a new Deloitte posting');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan.mjs wiring: a discard.log entry WITH (SKIP_COMPANY) filters every posting from that company', () => {
  const root = workspace();
  try {
    writeFileSync(join(root, 'data', 'discard.log'),
      '2026-09-09T17:24:32Z\thttps://apply.deloitte.com/some/other/req\t(SKIP_COMPANY) Deloitte -- candidate decision\n');
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 0, 'the (SKIP_COMPANY) marker must filter the new Deloitte posting too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scan.mjs wiring: no discard.log at all behaves exactly as before (byte-identical opt-in)', () => {
  const root = workspace();
  try {
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
