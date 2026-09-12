// tests/recall-store.test.mjs — the Lane B holding pen: JSONL (multiline-safe
// JD text), lock-scoped claim/commit (never held across an LLM call),
// deterministic selection (not provider-iteration-order), stale in_flight
// recovery. Runs in a subprocess against a fresh temp CAREER_OPS_DATA_DIR
// since RECALL_CANDIDATES_PATH is fixed at module load time (same pattern as
// tests/apify-jd-cache-data-root.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, NODE, rmSync } from './helpers.mjs';
import { selectForEvaluation, claimRows, commitVerdict, STALE_IN_FLIGHT_MS } from '../recall-store.mjs';

const RECALL_STORE_URL = pathToFileURL(join(ROOT, 'recall-store.mjs')).href;

// ── Pure functions: selection, claim, commit — in-process ──────────────

function row(overrides = {}) {
  return {
    url: 'https://x.test/1', title: 'Solutions Engineer', company: 'Acme', location: 'Remote',
    posted_at: null, first_seen_at: null, source: 'reverse-ats', description: null,
    captured_at: '2026-09-10', status: 'pending', confidence: null, reason: null,
    evaluated_at: null, claimed_at: null, claim_token: null,
    ...overrides,
  };
}

test('selectForEvaluation: newest-first by posted_at, undated rows sort last', () => {
  const rows = [
    row({ url: 'https://x.test/old', posted_at: '2026-08-01' }),
    row({ url: 'https://x.test/new', posted_at: '2026-09-09' }),
    row({ url: 'https://x.test/undated' }),
  ];
  const selected = selectForEvaluation(rows, { cap: 10 });
  assert.deepEqual(selected.map((r) => r.url), ['https://x.test/new', 'https://x.test/old', 'https://x.test/undated']);
});

test('selectForEvaluation: per-company cap prevents one company from consuming the whole budget', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ url: `https://x.test/${i}`, company: 'BigCo', posted_at: '2026-09-09' }));
  const selected = selectForEvaluation(rows, { cap: 10, perCompanyCap: 2 });
  assert.equal(selected.length, 2);
});

test('selectForEvaluation: per-source cap applies independently of per-company cap', () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ url: `https://x.test/${i}`, company: `Co${i}`, source: 'reverse-ats', posted_at: '2026-09-09' }));
  const selected = selectForEvaluation(rows, { cap: 10, perCompanyCap: 10, perSourceCap: 3 });
  assert.equal(selected.length, 3);
});

test('selectForEvaluation: never selects provider-iteration order alone — ties break on URL, not array position', () => {
  const rows = [
    row({ url: 'https://x.test/z', posted_at: '2026-09-09' }),
    row({ url: 'https://x.test/a', posted_at: '2026-09-09' }),
  ];
  const selected = selectForEvaluation(rows, { cap: 10 });
  assert.deepEqual(selected.map((r) => r.url), ['https://x.test/a', 'https://x.test/z']);
});

test('selectForEvaluation: excludes already-evaluated rows', () => {
  const rows = [row({ status: 'evaluated_low' }), row({ url: 'https://x.test/2', status: 'promoted' })];
  assert.equal(selectForEvaluation(rows, { cap: 10 }).length, 0);
});

test('selectForEvaluation: a FRESH in_flight row is not reselected (still being processed)', () => {
  const rows = [row({ status: 'in_flight', claimed_at: new Date().toISOString() })];
  assert.equal(selectForEvaluation(rows, { cap: 10 }).length, 0);
});

test('selectForEvaluation: a STALE in_flight row (crashed process) is reselected', () => {
  const staleTimestamp = new Date(Date.now() - STALE_IN_FLIGHT_MS - 60_000).toISOString();
  const rows = [row({ status: 'in_flight', claimed_at: staleTimestamp })];
  assert.equal(selectForEvaluation(rows, { cap: 10 }).length, 1);
});

test('claimRows: marks matching URLs in_flight with a claim_token, returns the token map', () => {
  const rows = [row({ url: 'https://x.test/1' }), row({ url: 'https://x.test/2' })];
  const tokens = claimRows(rows, ['https://x.test/1']);
  assert.equal(rows[0].status, 'in_flight');
  assert.ok(rows[0].claim_token);
  assert.equal(tokens.get('https://x.test/1'), rows[0].claim_token);
  assert.equal(rows[1].status, 'pending'); // untouched
});

test('commitVerdict: applies when the claim_token matches', () => {
  const rows = [row({ status: 'in_flight', claim_token: 'tok-1', claimed_at: new Date().toISOString() })];
  const applied = commitVerdict(rows, { url: 'https://x.test/1', claimToken: 'tok-1', status: 'evaluated_high', confidence: 'high', reason: 'plausible fit' });
  assert.equal(applied, true);
  assert.equal(rows[0].status, 'evaluated_high');
  assert.equal(rows[0].claim_token, null, 'claim released after commit');
});

test('commitVerdict: refuses to clobber a row reclaimed under a different token (stale-recovery race)', () => {
  const rows = [row({ status: 'in_flight', claim_token: 'newer-token' })];
  const applied = commitVerdict(rows, { url: 'https://x.test/1', claimToken: 'stale-token', status: 'evaluated_high' });
  assert.equal(applied, false);
  assert.equal(rows[0].claim_token, 'newer-token', 'the newer claim is untouched');
});

// ── File I/O: JSONL round-trip, locking — subprocess against a temp data root ─

function freshDataRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'co-recall-store-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  return dir;
}

function runProbe(script, dataRoot) {
  return execFileSync(NODE, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
  });
}

test('appendRecallCandidateIfNew: round-trips a multiline JD description safely (JSONL, not TSV)', () => {
  const dataRoot = freshDataRoot();
  try {
    const description = 'Line one.\nLine two with a\ttab.\nLine three: "quoted" and unicode — café.';
    const script = `
      import { appendRecallCandidateIfNew, readRecallCandidates } from ${JSON.stringify(RECALL_STORE_URL)};
      const added = await appendRecallCandidateIfNew({
        url: 'https://x.test/1', title: 'Customer Deployment Lead', company: 'Acme', location: 'Remote',
        source: 'reverse-ats', description: ${JSON.stringify(description)},
      });
      const rows = readRecallCandidates();
      console.log(JSON.stringify({ added, storedDescription: rows[0].description }));
    `;
    const out = runProbe(script, dataRoot);
    const { added, storedDescription } = JSON.parse(out.trim());
    assert.equal(added, true);
    assert.equal(storedDescription, description, 'multiline/tab/unicode JD text must round-trip byte-for-byte');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('appendRecallCandidateIfNew: does not duplicate an already-captured URL', () => {
  const dataRoot = freshDataRoot();
  try {
    const script = `
      import { appendRecallCandidateIfNew, readRecallCandidates } from ${JSON.stringify(RECALL_STORE_URL)};
      const first = await appendRecallCandidateIfNew({ url: 'https://x.test/1', title: 'A', company: 'B', source: 's' });
      const second = await appendRecallCandidateIfNew({ url: 'https://x.test/1', title: 'A', company: 'B', source: 's' });
      console.log(JSON.stringify({ first, second, count: readRecallCandidates().length }));
    `;
    const out = runProbe(script, dataRoot);
    const { first, second, count } = JSON.parse(out.trim());
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(count, 1);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('a malformed line in recall-candidates.jsonl is skipped, not fatal', () => {
  const dataRoot = freshDataRoot();
  try {
    writeFileSync(join(dataRoot, 'data', 'recall-candidates.jsonl'), '{"url":"https://x.test/good","title":"A"}\nnot json\n');
    const script = `
      import { readRecallCandidates } from ${JSON.stringify(RECALL_STORE_URL)};
      console.log(JSON.stringify(readRecallCandidates()));
    `;
    const out = runProbe(script, dataRoot);
    const rows = JSON.parse(out.trim());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://x.test/good');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
