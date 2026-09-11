// tests/append-pipeline-entry.test.mjs — append-pipeline-entry.mjs is the
// locked-write path for job offers discovered outside scan.mjs's own
// provider loop (an agent's Playwright/WebSearch handoff pass for a company
// with no configured provider). It must write through the same
// appendToPipeline()/appendToScanHistory() lock scan.mjs itself uses, apply
// the same URL-dedup scan.mjs would, and never touch data/applications.md.
//
// Each end-to-end test runs the CLI in its own subprocess against a fresh
// temp CAREER_OPS_DATA_DIR, since scan.mjs resolves its path constants once
// at module load time — re-importing in-process would just hit the module
// cache and silently reuse the first data root (see
// tests/apify-jd-cache-data-root.test.mjs for the same pattern).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NODE, rmSync } from './helpers.mjs';
import { normalizeOfferInput, stripBom } from '../append-pipeline-entry.mjs';

const CLI = join(ROOT, 'append-pipeline-entry.mjs');

function freshDataRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'co-append-pipeline-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
}

function runCli(args, dataRoot, input) {
  try {
    const out = execFileSync(NODE, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      input,
      env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
    });
    return { out, exitCode: 0 };
  } catch (err) {
    return { out: (err.stdout || '') + (err.stderr || ''), exitCode: err.status };
  }
}

const SAMPLE_OFFER = {
  url: 'https://example.com/careers/123',
  title: 'Solutions Engineer',
  company: 'Acme Manufacturing',
  location: 'New York, NY',
  source: 'Top100 Handoff — WebSearch',
  postedAt: '2026-09-08',
  note: 'found via handoff',
};

test('normalizeOfferInput accepts a well-formed offer', () => {
  const result = normalizeOfferInput(SAMPLE_OFFER);
  assert.equal(result.ok, true);
  assert.equal(result.offer.url, SAMPLE_OFFER.url);
  assert.equal(result.offer.title, SAMPLE_OFFER.title);
  assert.equal(result.offer.company, SAMPLE_OFFER.company);
  assert.equal(typeof result.offer.postedAt, 'number');
});

test('normalizeOfferInput rejects a non-http(s)/local url', () => {
  const result = normalizeOfferInput({ ...SAMPLE_OFFER, url: 'ftp://example.com/x' });
  assert.equal(result.ok, false);
});

test('normalizeOfferInput accepts a local: reference', () => {
  const result = normalizeOfferInput({ ...SAMPLE_OFFER, url: 'local:jds/acme-solutions-engineer.md' });
  assert.equal(result.ok, true);
});

test('normalizeOfferInput rejects missing title/company', () => {
  assert.equal(normalizeOfferInput({ ...SAMPLE_OFFER, title: '' }).ok, false);
  assert.equal(normalizeOfferInput({ ...SAMPLE_OFFER, company: '' }).ok, false);
});

test('normalizeOfferInput rejects a malformed postedAt', () => {
  const result = normalizeOfferInput({ ...SAMPLE_OFFER, postedAt: '09/08/2026' });
  assert.equal(result.ok, false);
});

test('stripBom removes a leading UTF-8 BOM (PowerShell -Encoding utf8 writes one)', () => {
  assert.equal(stripBom('﻿{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('CLI accepts a payload file with a leading BOM (as PowerShell Set-Content -Encoding utf8 would write)', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, '﻿' + JSON.stringify([SAMPLE_OFFER]));
    const { out, exitCode } = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${out}`);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.added, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI writes a new offer to pipeline.md and scan-history.tsv through the lock', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify([SAMPLE_OFFER]));

    const { out, exitCode } = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${out}`);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.version, 'careerops.append.receipt@1');
    assert.equal(receipt.added, 1);
    assert.deepEqual(receipt.added_urls, [SAMPLE_OFFER.url]);
    assert.equal(receipt.skipped_duplicate.length, 0);

    const pipelineText = readFileSync(join(dataRoot, 'data', 'pipeline.md'), 'utf-8');
    assert.match(pipelineText, /Acme Manufacturing/);
    assert.match(pipelineText, /Solutions Engineer/);
    assert.match(pipelineText, new RegExp(SAMPLE_OFFER.url.replace(/\//g, '\\/')));

    const historyText = readFileSync(join(dataRoot, 'data', 'scan-history.tsv'), 'utf-8');
    const row = historyText.split('\n').find((l) => l.includes(SAMPLE_OFFER.url));
    assert.ok(row, 'expected a scan-history row for the new URL');
    const cols = row.split('\t');
    assert.equal(cols[2], SAMPLE_OFFER.source, 'portal column should carry the caller-supplied source label');
    assert.equal(cols[5], 'added');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI skips a URL already present in scan-history.tsv (duplicate)', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify([SAMPLE_OFFER]));

    const first = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(first.exitCode, 0);

    const second = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(second.exitCode, 0);
    const receipt = JSON.parse(second.out.trim());
    assert.equal(receipt.added, 0);
    assert.deepEqual(receipt.skipped_duplicate, [SAMPLE_OFFER.url]);

    // The row must not have been duplicated in scan-history.tsv.
    const historyText = readFileSync(join(dataRoot, 'data', 'scan-history.tsv'), 'utf-8');
    const occurrences = historyText.split('\n').filter((l) => l.includes(SAMPLE_OFFER.url)).length;
    assert.equal(occurrences, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI skips two same-URL offers within one batch (in-batch dedup)', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify({ offers: [SAMPLE_OFFER, { ...SAMPLE_OFFER, title: 'Duplicate title' }] }));

    const { out, exitCode } = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(exitCode, 0);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.added, 1);
    assert.equal(receipt.skipped_duplicate.length, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI reports skipped_invalid and exits 2 for a malformed offer, without touching pipeline.md', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify([{ url: 'not-a-url', title: 'X', company: 'Y' }]));

    const { out, exitCode } = runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(exitCode, 2);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.added, 0);
    assert.equal(receipt.skipped_invalid.length, 1);
    assert.equal(existsSync(join(dataRoot, 'data', 'pipeline.md')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI reads the payload from stdin when --payload is omitted (no Write-tool caller)', () => {
  const dataRoot = freshDataRoot();
  try {
    const { out, exitCode } = runCli(['--json'], dataRoot, JSON.stringify([SAMPLE_OFFER]));
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${out}`);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.added, 1);
    assert.deepEqual(receipt.added_urls, [SAMPLE_OFFER.url]);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI reads the payload from stdin when --payload is "-"', () => {
  const dataRoot = freshDataRoot();
  try {
    const { out, exitCode } = runCli(['--payload', '-', '--json'], dataRoot, JSON.stringify({ offers: [SAMPLE_OFFER] }));
    assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}: ${out}`);
    const receipt = JSON.parse(out.trim());
    assert.equal(receipt.added, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI errors cleanly (does not hang) when --payload is omitted and stdin is empty', () => {
  const dataRoot = freshDataRoot();
  try {
    const { exitCode } = runCli(['--json'], dataRoot, '');
    assert.equal(exitCode, 1);
    assert.equal(existsSync(join(dataRoot, 'data', 'pipeline.md')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('CLI never writes data/applications.md', () => {
  const dataRoot = freshDataRoot();
  try {
    const payloadPath = join(dataRoot, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify([SAMPLE_OFFER]));
    runCli(['--payload', payloadPath, '--json'], dataRoot);
    assert.equal(existsSync(join(dataRoot, 'data', 'applications.md')), false);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
