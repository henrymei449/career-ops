// tests/structured-workplace-gate.test.mjs — scan.mjs's wiring of
// location-tier.mjs's classifyGeography() (2026-09-13 "Actual CareerOps
// geography policy": actionable ONLY if REMOTE_US or NYC_COMPATIBLE, both
// structured-actor-metadata-derived (stage 1) and bare-location-derived
// (stage 2, the classifyLocation-based fallback that REPLACED the old
// permissive location_filter() pass-through at this position). The pure
// classification logic itself — all 11 user-specified cases across
// classifyStructuredWorkplace/classifyLocationFallback/classifyGeography —
// is exhaustively covered by tests/location-tier.test.mjs; this file proves
// the separate thing those pure-function tests can't: that scan.mjs wires
// the verdict in correctly, upstream of every downstream filter, dedup, and
// the pipeline write, so neither REJECT nor a still-UNKNOWN final state can
// ever reach newOffers.push() (and therefore never reach the LLM evaluation
// stage, which only ever runs on pipeline.md entries in a separate mode).
//
// Test cases 1-9 (state-by-state correctness) live in
// tests/location-tier.test.mjs. This file covers cases 10 and 11 with REAL
// subprocess scan.mjs runs (local-parser fixture, no network, no LLM) for
// the bare-location/fallback path — providers/local-parser.mjs's
// normalizeParserJob strictly whitelists title/url/company/location and
// drops any extra field, so it can carry a bare `location` through end to
// end but not workRemoteAllowed/workplaceTypes (stage 1's structured
// signal) — those stage-1-only cases stay as pure-function coverage in
// location-tier.test.mjs, plus the source-position wiring assertions below.
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
const SCAN_SRC = readFileSync(SCAN, 'utf-8');
const NODE = process.execPath;

// ── Source-position wiring assertions ──────────────────────────────────────

test('scan.mjs imports classifyGeography from location-tier.mjs', () => {
  assert.match(SCAN_SRC, /import\s*\{\s*classifyGeography\s*\}\s*from\s*'\.\/location-tier\.mjs';/);
});

test('a non-(REMOTE_US|NYC_COMPATIBLE) geography state is an unconditional continue', () => {
  const gateIdx = SCAN_SRC.indexOf('const geography = classifyGeography(job);');
  assert.notEqual(gateIdx, -1, 'gate call site not found');
  const block = SCAN_SRC.slice(gateIdx, gateIdx + 300);
  assert.match(block, /if\s*\(geography\.state !== 'REMOTE_US' && geography\.state !== 'NYC_COMPATIBLE'\)\s*\{\s*totalFilteredLocation\+\+;\s*continue;\s*\}/);
});

test('the gate runs strictly before every downstream filter, dedup check, and the newOffers push', () => {
  const gateIdx = SCAN_SRC.indexOf('const geography = classifyGeography(job);');
  const downstreamMarkers = [
    'postingAgeFilter(job.postedAt)',
    'postedDateFilter(job.postedAt)',
    'salaryFilter(job.salary)',
    'contentFilter(job.description',
    'countryEligibilityFilter(job.description)',
    'seenCompanyRoles.has(key)', // dedup
    'newOffers.push({', // final pipeline write
  ];
  for (const marker of downstreamMarkers) {
    const idx = SCAN_SRC.indexOf(marker);
    assert.notEqual(idx, -1, `marker not found in scan.mjs: ${marker}`);
    assert.ok(gateIdx < idx, `gate (index ${gateIdx}) must appear before "${marker}" (index ${idx}) — geography must be upstream of it`);
  }
});

test('the gate runs strictly after title_filter (title_filter is never weakened or bypassed)', () => {
  const titleFilterIdx = SCAN_SRC.indexOf("if (!titleFilter(job.title)) {");
  const gateIdx = SCAN_SRC.indexOf('const geography = classifyGeography(job);');
  assert.notEqual(titleFilterIdx, -1);
  assert.notEqual(gateIdx, -1);
  assert.ok(titleFilterIdx < gateIdx, 'title_filter must still run first — this change must never reorder it');
});

test('the old location_filter() call no longer runs at this gate position (superseded by classifyGeography, per the 2026-09-13 policy)', () => {
  const gateIdx = SCAN_SRC.indexOf('const geography = classifyGeography(job);');
  const nextStageIdx = SCAN_SRC.indexOf('postingAgeFilter(job.postedAt)');
  const between = SCAN_SRC.slice(gateIdx, nextStageIdx);
  assert.doesNotMatch(between, /locationFilter\(job\.location/, 'location_filter() must not be called again between the geography gate and the next stage');
});

test('location_filter() itself is NOT removed from scan.mjs — still built and still used by Lane B (runRecallEligibilityChecks)', () => {
  assert.match(SCAN_SRC, /const locationFilter = buildLocationFilter\(config\.location_filter\);/);
  assert.match(SCAN_SRC, /runRecallEligibilityChecks\(job, \{ skipTiers, locationFilter, postingAgeFilter, postedDateFilter, salaryFilter \}\)/);
});

test('plugins/apify/index.mjs field_map validation and normalizeItem both know about workRemoteAllowed/workplaceTypes', () => {
  const apifySrc = readFileSync(join(ROOT, 'plugins', 'apify', 'index.mjs'), 'utf-8');
  assert.match(apifySrc, /entry\.field_map\.workRemoteAllowed/);
  assert.match(apifySrc, /entry\.field_map\.workplaceTypes/);
  assert.match(apifySrc, /out\.workRemoteAllowed = raw/);
  assert.match(apifySrc, /out\.workplaceTypes = raw/);
});

// ── Real subprocess integration (local-only, no network, no LLM) ──────────
// Covers the bare-location / stage-2-fallback path end to end, proving
// cases 10 and 11 against the REAL scan.mjs, not just source inspection.

function workspace(locations) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-geography-gate-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');

  const jobs = locations.map((loc, i) => ({
    title: 'Solutions Consultant Manufacturing',
    url: `https://careers.example.com/acme/req-${i}`,
    location: loc,
  }));

  const portals = [
    'tracked_companies:',
    '  - name: Acme',
    '    careers_url: https://careers.example.com/acme',
    '    scan_method: local_parser',
    '    enabled: true',
    '    parser:',
    '      command: node',
    `      script: ${JSON.stringify(`test-fixtures/geography-gate-parser-${root.split(/[\\/]/).pop()}.mjs`)}`,
    'title_filter:',
    '  positive: ["Solutions Consultant"]',
    '  negative: []',
    'job_boards: []',
    '',
  ].join('\n');

  // providers/local-parser.mjs refuses a script outside the project root, so
  // the fixture parser has to actually live in-repo — write it under
  // test-fixtures/ (cleaned up in the test's `finally`), not in the temp dir.
  const fixtureRel = `test-fixtures/geography-gate-parser-${root.split(/[\\/]/).pop()}.mjs`;
  const fixtureAbs = join(ROOT, fixtureRel);
  writeFileSync(fixtureAbs, `console.log(${JSON.stringify(JSON.stringify(jobs))});\n`);

  writeFileSync(join(root, 'portals.yml'), portals);
  return { root, fixtureAbs };
}

function runScan(root) {
  return spawnSync(NODE, [SCAN, '--json'], {
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

test('11. a definitive REJECT (bare Chicago, IL, no structured metadata) never reaches newOffers.push() / pipeline.md', () => {
  const { root, fixtureAbs } = workspace(['Chicago, IL']);
  try {
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 0, 'a confirmed non-NYC US location with no remote signal must be rejected, not added');
    const pipelineText = existsSync(join(root, 'data', 'pipeline.md'))
      ? readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8')
      : '';
    assert.doesNotMatch(pipelineText, /Solutions Consultant Manufacturing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureAbs, { force: true });
  }
});

test('10. a genuinely UNKNOWN geography (bare "United States", insufficient evidence) cannot silently reach the accepted pipeline', () => {
  const { root, fixtureAbs } = workspace(['United States']);
  try {
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 0, 'UNKNOWN must never be silently treated as accepted');
    const pipelineText = existsSync(join(root, 'data', 'pipeline.md'))
      ? readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8')
      : '';
    assert.doesNotMatch(pipelineText, /Solutions Consultant Manufacturing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureAbs, { force: true });
  }
});

test('control: NYC_COMPATIBLE (bare "New York, NY") still reaches the pipeline as before — the gate is not over-tightened', () => {
  const { root, fixtureAbs } = workspace(['New York, NY']);
  try {
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 1, 'an NYC-actionable posting must still reach the pipeline');
    const pipelineText = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8');
    assert.match(pipelineText, /Solutions Consultant Manufacturing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureAbs, { force: true });
  }
});

test('control: "Remote - United States" text (stage-2 REMOTE_US, no structured metadata) still reaches the pipeline', () => {
  const { root, fixtureAbs } = workspace(['Remote - United States']);
  try {
    const result = runScan(root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.added, 1);
    const pipelineText = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8');
    assert.match(pipelineText, /Solutions Consultant Manufacturing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fixtureAbs, { force: true });
  }
});
