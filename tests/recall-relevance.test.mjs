// tests/recall-relevance.test.mjs — the facts-only judge, deterministic
// selection, claim/commit locking, and HIGH-only promotion through the
// SAME post-title gate + appendToPipeline/appendToScanHistory Lane A uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, NODE, rmSync } from './helpers.mjs';
import { buildJudgePrompt, parseJudgeResponse, appendRecallRunSummary } from '../recall-relevance.mjs';

const RECALL_RELEVANCE_URL = pathToFileURL(join(ROOT, 'recall-relevance.mjs')).href;

// ── Pure functions ───────────────────────────────────────────────────────

test('buildJudgePrompt: includes every candidate, numbered, facts only (no description leaked)', () => {
  const prompt = buildJudgePrompt([
    { title: 'Customer Deployment Lead', company: 'Acme', location: 'Remote', source: 'reverse-ats', description: 'SECRET JD TEXT' },
  ]);
  assert.match(prompt, /0\. "Customer Deployment Lead" — Acme — Remote — source: reverse-ats/);
  assert.doesNotMatch(prompt, /SECRET JD TEXT/, 'the facts-only judge must never see JD description text');
});

test('parseJudgeResponse: parses a clean JSON array', () => {
  const result = parseJudgeResponse('[{"id":0,"confidence":"high","reason":"plausible fit"},{"id":1,"confidence":"low","reason":"unrelated"}]');
  assert.deepEqual(result, [
    { id: 0, confidence: 'high', reason: 'plausible fit' },
    { id: 1, confidence: 'low', reason: 'unrelated' },
  ]);
});

test('parseJudgeResponse: tolerates prose/fences around the array', () => {
  const result = parseJudgeResponse('Here you go:\n```json\n[{"id":0,"confidence":"medium","reason":"maybe"}]\n```');
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 'medium');
});

test('parseJudgeResponse: rejects an invalid confidence value rather than guessing', () => {
  const result = parseJudgeResponse('[{"id":0,"confidence":"very high","reason":"x"}]');
  assert.deepEqual(result, []);
});

test('parseJudgeResponse: unparseable text returns [] (safe-empty, no salvage)', () => {
  assert.deepEqual(parseJudgeResponse('not json at all'), []);
  assert.deepEqual(parseJudgeResponse(''), []);
});

// ── recall-runs.tsv instrumentation ──────────────────────────────────────

test('appendRecallRunSummary: writes a header once, then one row per call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-recall-runs-'));
  try {
    const path = join(dir, 'recall-runs.tsv');
    appendRecallRunSummary({ timestamp: '2026-09-11T00:00:00Z', considered: 10, sentToLlm: 5, batches: 1, high: 1, medium: 2, low: 2, promoted: 1, estimatedCostUsd: 0.05 }, path);
    appendRecallRunSummary({ timestamp: '2026-09-11T01:00:00Z', considered: 3, sentToLlm: 3, batches: 1, high: 0, medium: 1, low: 2, promoted: 0, estimatedCostUsd: null }, path);
    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 3); // header + 2 rows
    assert.match(lines[0], /^timestamp\tconsidered/);
    assert.match(lines[1], /0\.0500$/);
    assert.match(lines[2], /\t$/, 'a null cost is an empty cell, never a fabricated number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Full run() integration: claim -> commit -> promote, injected fake CLI ─

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'co-recall-relevance-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'profile.yml'), '{}\n');
  writeFileSync(join(root, 'portals.yml'), 'tracked_companies: []\njob_boards: []\n');
  return root;
}

function seedCandidate(root, overrides = {}) {
  const row = {
    url: 'https://x.test/req-1', title: 'Customer Deployment Lead', company: 'Acme', location: 'Remote',
    posted_at: '2026-09-09', first_seen_at: '2026-09-09', source: 'reverse-ats', description: null,
    captured_at: '2026-09-09', status: 'pending', confidence: null, reason: null,
    evaluated_at: null, claimed_at: null, claim_token: null,
    ...overrides,
  };
  writeFileSync(join(root, 'data', 'recall-candidates.jsonl'), JSON.stringify(row) + '\n');
  return row;
}

function runProbe(root, script) {
  return execFileSync(NODE, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: root, CAREER_OPS_PORTALS: '' },
  });
}

test('run(): a HIGH verdict is promoted through the shared gate into pipeline.md + scan-history.tsv with discovery_lane=semantic_recall', () => {
  const root = workspace();
  try {
    seedCandidate(root);
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = (cli, prompt, model) => ({ text: '[{"id":0,"confidence":"high","reason":"plausible fit"}]', costUsd: 0.0123 });
      const code = await run(['--cli', 'fake-test-cli', '--json'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.high, 1);
    assert.equal(summary.promoted, 1);
    assert.equal(summary.estimated_cost_usd, 0.0123);

    const candidates = readFileSync(join(root, 'data', 'recall-candidates.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(candidates[0].status, 'evaluated_high');
    assert.equal(candidates[0].claim_token, null, 'claim released after commit');

    const pipelineText = readFileSync(join(root, 'data', 'pipeline.md'), 'utf-8');
    assert.match(pipelineText, /Customer Deployment Lead/);
    assert.match(pipelineText, /discovery_lane=semantic_recall/);

    const historyText = readFileSync(join(root, 'data', 'scan-history.tsv'), 'utf-8');
    assert.match(historyText, /Customer Deployment Lead/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run(): MEDIUM/LOW verdicts are recorded but never promoted', () => {
  const root = workspace();
  try {
    seedCandidate(root);
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = () => ({ text: '[{"id":0,"confidence":"medium","reason":"unclear"}]', costUsd: null });
      const code = await run(['--cli', 'fake-test-cli', '--json'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.medium, 1);
    assert.equal(summary.promoted, 0);
    assert.equal(existsSync(join(root, 'data', 'pipeline.md')), false, 'nothing promoted, pipeline.md never created');

    const candidates = readFileSync(join(root, 'data', 'recall-candidates.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(candidates[0].status, 'evaluated_medium');
    assert.equal(candidates[0].reason, 'unclear');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run(): --dry-run judges but promotes nothing, even for HIGH', () => {
  const root = workspace();
  try {
    seedCandidate(root);
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = () => ({ text: '[{"id":0,"confidence":"high","reason":"plausible"}]', costUsd: null });
      const code = await run(['--cli', 'fake-test-cli', '--json', '--dry-run'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.high, 1);
    assert.equal(summary.promoted, 0);
    assert.equal(existsSync(join(root, 'data', 'pipeline.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run(): a HIGH verdict that fails the shared gate (e.g. already deduped) is not promoted', () => {
  const root = workspace();
  try {
    seedCandidate(root);
    // Pre-seed applications.md with the SAME URL so the shared gate's dedup rejects it.
    writeFileSync(join(root, 'data', 'applications.md'), '# Applications\n\nhttps://x.test/req-1\n');
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = () => ({ text: '[{"id":0,"confidence":"high","reason":"plausible"}]', costUsd: null });
      const code = await run(['--cli', 'fake-test-cli', '--json'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.high, 1);
    assert.equal(summary.promoted, 0, 'the shared gate must catch a dedup hit exactly like it would for Lane A');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run(): nothing pending — no-op, no CLI call attempted', () => {
  const root = workspace();
  try {
    let called = false;
    // No candidate file at all.
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = () => { throw new Error('must not be called'); };
      const code = await run(['--cli', 'fake-test-cli', '--json'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    assert.doesNotMatch(out, /must not be called/);
    void called;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run(): --recall-eval-cap bounds how many candidates are sent to the LLM', () => {
  const root = workspace();
  try {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      url: `https://x.test/${i}`, title: 'Customer Deployment Lead', company: `Co${i}`, location: 'Remote',
      posted_at: '2026-09-09', first_seen_at: '2026-09-09', source: 'reverse-ats', description: null,
      captured_at: '2026-09-09', status: 'pending', confidence: null, reason: null,
      evaluated_at: null, claimed_at: null, claim_token: null,
    }));
    writeFileSync(join(root, 'data', 'recall-candidates.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const script = `
      import { run } from ${JSON.stringify(RECALL_RELEVANCE_URL)};
      const fakeCli = (cli, prompt) => {
        const n = (prompt.match(/^\\d+\\. /gm) || []).length;
        return { text: JSON.stringify(Array.from({length:n},(_, i)=>({id:i, confidence:'low', reason:'x'}))), costUsd: null };
      };
      const code = await run(['--cli', 'fake-test-cli', '--recall-eval-cap', '2', '--json'], { callCliFn: fakeCli });
      process.exitCode = code;
    `;
    const out = runProbe(root, script);
    const summary = JSON.parse(out.trim().split('\n').pop());
    assert.equal(summary.sentToLlm, 2, 'the cap must bound how many of the 5 pending rows are ever sent to the LLM');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
