// tests/recall-capture.test.mjs — scan.mjs's Lane B wiring: title-filter
// rejects that pass no-fetch eligibility get captured (only behind
// --capture-recall-rejects, default off); Lane A's own accepted rows get an
// explicit discovery_lane=keyword note (always, not opt-in — required so no
// downstream consumer ever has to infer provenance from absence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rmSync } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = join(ROOT, 'scan.mjs');
const NODE = process.execPath;
const FIXTURE_PARSER_REL = 'test-fixtures/recall-capture-parser.mjs';

function workspace({ titleFilter }) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-recall-capture-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');

  const portals = [
    'tracked_companies:',
    '  - name: Acme',
    '    careers_url: https://careers.example.com/acme',
    '    scan_method: local_parser',
    '    enabled: true',
    '    parser:',
    '      command: node',
    `      script: ${JSON.stringify(FIXTURE_PARSER_REL)}`,
    'title_filter:',
    `  positive: [${titleFilter.positive.map((s) => JSON.stringify(s)).join(', ')}]`,
    '  negative: []',
    'job_boards: []',
    '',
  ].join('\n');
  writeFileSync(join(root, 'portals.yml'), portals);
  return root;
}

function runScan(root, extraArgs = [], { dryRun = true } = {}) {
  const args = dryRun ? ['--dry-run', '--json', ...extraArgs] : ['--json', ...extraArgs];
  return spawnSync(NODE, [SCAN, ...args], {
    cwd: root,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_PORTALS: join(root, 'portals.yml'),
      CAREER_OPS_PROFILE: join(root, 'config', 'profile.yml'),
      CAREER_OPS_PIPELINE: join(root, 'data', 'pipeline.md'),
      CAREER_OPS_SCAN_HISTORY: join(root, 'data', 'scan-history.tsv'),
      CAREER_OPS_RECALL_CANDIDATES: join(root, 'data', 'recall-candidates.jsonl'),
    },
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('--dry-run never writes the recall holding pen, even with the capture flag on (dry-run means zero writes)', () => {
  const root = workspace({ titleFilter: { positive: ['Solutions Engineer'] } });
  try {
    const result = runScan(root, ['--capture-recall-rejects']); // dryRun defaults true
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'data', 'recall-candidates.jsonl')), false, 'dry-run must not write anything, capture included');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture flag OFF (default, real run): a title-filter reject is not captured, and behaves exactly as before', () => {
  const root = workspace({ titleFilter: { positive: ['Solutions Engineer'] } }); // "Customer Deployment Lead" fails this
  try {
    const result = runScan(root, [], { dryRun: false }); // no --capture-recall-rejects
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 0);
    assert.equal(receipt.filtered, 1);
    assert.equal(existsSync(join(root, 'data', 'recall-candidates.jsonl')), false, 'no capture without the opt-in flag');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture flag ON (real run): a title-filter reject that passes no-fetch eligibility IS captured', () => {
  const root = workspace({ titleFilter: { positive: ['Solutions Engineer'] } });
  try {
    const result = runScan(root, ['--capture-recall-rejects'], { dryRun: false });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 0, 'capture must not add the reject to the normal pipeline');

    const jsonlPath = join(root, 'data', 'recall-candidates.jsonl');
    assert.equal(existsSync(jsonlPath), true);
    const rows = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Customer Deployment Lead');
    assert.equal(rows[0].company, 'Acme');
    assert.equal(rows[0].status, 'pending');

    // Never sent into pipeline.md itself — capture is a side channel, not a
    // second pipeline entry point (requirement: don't send rejects into the
    // normal pipeline).
    const pipelineText = existsSync(join(root, 'data', 'pipeline.md'))
      ? readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8')
      : '';
    assert.doesNotMatch(pipelineText, /Customer Deployment Lead/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lane A rows are explicitly tagged discovery_lane=keyword — never left implicit', () => {
  const root = workspace({ titleFilter: { positive: ['Customer Deployment Lead'] } }); // now it PASSES
  try {
    const result = runScan(root, [], { dryRun: false });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 1);

    const pipelineText = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8');
    assert.match(pipelineText, /discovery_lane=keyword/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture is idempotent across repeated scans of the same reject (no duplicate rows)', () => {
  const root = workspace({ titleFilter: { positive: ['Solutions Engineer'] } });
  try {
    runScan(root, ['--capture-recall-rejects'], { dryRun: false });
    runScan(root, ['--capture-recall-rejects'], { dryRun: false });
    const jsonlPath = join(root, 'data', 'recall-candidates.jsonl');
    const rows = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(rows.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
