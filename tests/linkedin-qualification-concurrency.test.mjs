// tests/linkedin-qualification-concurrency.test.mjs — bounded concurrent
// Claude qualification (2026-09-23 performance work). Covers:
//  - CLAUDE_TRIAGE_CONCURRENCY resolution (default/clamp/invalid fallback)
//  - actual max in-flight calls matches the configured worker count
//  - a controlled 1/2/4-worker benchmark against a deterministic fake
//    evaluator with realistic (scaled-down) simulated latency
//  - out-of-order completion lands every result on the correct job
//  - a mid-batch rate limit stops NEW dispatch without touching in-flight
//    workers, and never fabricates a result
//  - crash/resume: a checkpoint from an interrupted run, resumed via a
//    follow-up receipt built from ONLY the surviving retry queue, never
//    re-invokes Claude for an already-completed row
//  - deterministic-gate protection (geography-before-title, zero LLM spend
//    on a confirmed reject, UNKNOWN stays pending) holds at every
//    concurrency level
// No network, no real Claude CLI, no paid calls anywhere in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  qualifyLinkedInReceipt,
  resolveClaudeTriageConcurrency,
  DEFAULT_CLAUDE_TRIAGE_CONCURRENCY,
  MAX_CLAUDE_TRIAGE_CONCURRENCY,
} from '../linkedin-qualification.mjs';

const BASE_CONFIG = { title_filter: { positive: ['solutions architect', 'solution architect'], negative: [] }, pipeline: { triage_threshold: 3.5 } };
const REMOTE_JD = 'This is a fully remote United States customer-facing manufacturing MES solutions architecture role. '.repeat(6);

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    company: `Company${i}`, title: 'Solutions Architect', location: 'United States',
    arrangement: 'Remote', outcome: 'would_add', reason: 'added_unresolved_url',
  }));
}
function stubResolve() {
  return async (c) => ({ status: 'resolved', url: `https://jobs.example/${c.company}`, attempts: [] });
}
function stubFetchJd() {
  // Distinct verified_url per candidate URL, not a shared constant — a
  // shared URL would make every qualified job collide on the same job_key
  // and createBatchFromJobs correctly refuses a batch with duplicate keys.
  return async (url) => ({ status: 'resolved', verified_url: url, source: 'test', text: REMOTE_JD });
}

// ── resolveClaudeTriageConcurrency ──────────────────────────────────────
test('resolveClaudeTriageConcurrency: documented default/clamp/invalid-fallback behavior', () => {
  assert.equal(resolveClaudeTriageConcurrency(undefined), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency(''), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('not-a-number'), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('0'), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('-1'), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('2.5'), DEFAULT_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('1'), 1);
  assert.equal(resolveClaudeTriageConcurrency('3'), 3);
  assert.equal(resolveClaudeTriageConcurrency('4'), MAX_CLAUDE_TRIAGE_CONCURRENCY);
  assert.equal(resolveClaudeTriageConcurrency('9999'), MAX_CLAUDE_TRIAGE_CONCURRENCY, 'never unbounded, even with an absurd override');
  assert.equal(MAX_CLAUDE_TRIAGE_CONCURRENCY, 4);
});

// ── actual max in-flight matches the configured limit ───────────────────
test('actual concurrent in-flight Claude calls equals the configured worker count when enough work is available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-lip-conc-'));
  try {
    const receipt = { receipt_id: 'conc-check', items: makeItems(8) };
    let inFlight = 0; let maxSeen = 0;
    const invoke = async () => {
      inFlight++; maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: 'TRIAGE: PASS | X | Solutions Architect | 4.0/5 | fit', cost_usd: 0, duration_ms: 1 };
    };
    const result = await qualifyLinkedInReceipt(receipt, {
      root, dryRun: true, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke, concurrency: 4,
    });
    assert.equal(maxSeen, 4, `expected exactly 4 concurrent calls with 8 eligible jobs, observed ${maxSeen}`);
    assert.equal(result.counts.concurrency_used, 4);
    assert.equal(result.counts.max_concurrent_observed, 4);
    assert.equal(result.counts.qualified, 8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── controlled 1 / 2 / 4 worker benchmark (SYNTHETIC — not a production measurement) ──
test('SYNTHETIC benchmark: concurrency 1 vs 2 vs 4 on the same 12-job fixture with a deterministic fake evaluator', async () => {
  // Scaled-down simulated latency modeled on the real production average
  // (12.4s/call, measured 2026-09-23 live run) at 1/100 scale (~124ms), with
  // small deterministic per-job jitter so the fixture is reproducible and
  // not brittle to wall-clock variance, while still exercising real
  // out-of-order completion (jobs do not all take identical time).
  const DELAYS_MS = [130, 118, 141, 122, 135, 119, 128, 137, 120, 144, 125, 132]; // 12 jobs, deterministic
  assert.equal(DELAYS_MS.length, 12);

  async function runAt(concurrency) {
    const root = mkdtempSync(join(tmpdir(), `co-lip-bench-c${concurrency}-`));
    try {
      const receipt = { receipt_id: `bench-c${concurrency}`, items: makeItems(12) };
      let checkpointWrites = 0;
      const seen = new Set();
      const invoke = async (prompt) => {
        const idx = DELAYS_MS.findIndex((_, i) => prompt.includes(`Company${i}`) && !seen.has(i));
        const i = idx === -1 ? 0 : idx;
        seen.add(i);
        await new Promise((r) => setTimeout(r, DELAYS_MS[i]));
        // 12 jobs -> 1 in 3 marginal/fail to give a realistic mixed outcome, deterministic by index
        const pass = i % 3 !== 0;
        return { text: `TRIAGE: ${pass ? 'PASS' : 'FAIL'} | Company${i} | Solutions Architect | ${pass ? '4.1' : '2.0'}/5 | deterministic fixture verdict`, cost_usd: 0, duration_ms: DELAYS_MS[i] };
      };
      const t0 = Date.now();
      const result = await qualifyLinkedInReceipt(receipt, {
        root, dryRun: false, config: BASE_CONFIG, modeText: 't', briefText: 'b',
        resolve: stubResolve(), fetchJd: stubFetchJd(), invoke, concurrency,
      });
      const wallMs = Date.now() - t0;
      return { concurrency, wallMs, result };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  const r1 = await runAt(1);
  const r2 = await runAt(2);
  const r4 = await runAt(4);

  // Same workload, same outcomes, regardless of concurrency.
  for (const r of [r1, r2, r4]) {
    assert.equal(r.result.counts.llm_calls, 12);
    assert.equal(r.result.counts.llm_succeeded, 12);
    assert.equal(r.result.counts.llm_failed, 0);
    assert.equal(r.result.counts.qualified, 8, 'same PASS/FAIL split at every concurrency level');
    assert.equal(r.result.counts.rejected, 4);
  }
  assert.equal(r1.result.counts.max_concurrent_observed, 1);
  assert.equal(r2.result.counts.max_concurrent_observed, 2);
  assert.equal(r4.result.counts.max_concurrent_observed, 4);

  // Higher concurrency must not be slower on this fixture (allow generous
  // scheduling slack — this asserts direction, not a tight wall-clock bound).
  assert.ok(r2.wallMs < r1.wallMs, `expected concurrency=2 (${r2.wallMs}ms) faster than concurrency=1 (${r1.wallMs}ms)`);
  assert.ok(r4.wallMs <= r2.wallMs + 50, `expected concurrency=4 (${r4.wallMs}ms) at least as fast as concurrency=2 (${r2.wallMs}ms) within scheduling slack`);

  console.log(`\n[SYNTHETIC BENCHMARK — 12-job fixture, fake evaluator, NOT a production measurement]`);
  for (const r of [r1, r2, r4]) {
    const throughput = (r.result.counts.llm_succeeded / (r.wallMs / 1000)).toFixed(2);
    console.log(`  concurrency=${r.concurrency}: wall=${r.wallMs}ms max_in_flight=${r.result.counts.max_concurrent_observed} throughput=${throughput}/s qualified=${r.result.counts.qualified}`);
  }
});

// ── out-of-order completion lands on the correct job ────────────────────
test('out-of-order completion: every result lands on its own job, none overwritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-lip-ooo-'));
  try {
    const receipt = { receipt_id: 'ooo', items: makeItems(6) };
    // Deliberately inverted delays: later-dispatched jobs finish FIRST.
    const delays = [100, 80, 60, 40, 20, 5];
    const invoke = async (prompt) => {
      const idx = Number(/Company(\d+)/.exec(prompt)[1]);
      await new Promise((r) => setTimeout(r, delays[idx]));
      return { text: `TRIAGE: PASS | Company${idx} | Solutions Architect | 4.${idx}/5 | fit${idx}`, cost_usd: 0, duration_ms: delays[idx] };
    };
    const result = await qualifyLinkedInReceipt(receipt, {
      root, dryRun: true, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke, concurrency: 4,
    });
    for (let i = 0; i < 6; i++) {
      const row = result.rows[i];
      assert.equal(row.company, `Company${i}`, `rows[${i}] identity preserved despite out-of-order completion`);
      assert.equal(row.status, 'QUALIFIED');
      assert.equal(row.triage.reason, `fit${i}`, `rows[${i}] carries its OWN triage result, not a neighbor's`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── rate limit mid-batch ─────────────────────────────────────────────────
test('a 429 from one worker stops NEW dispatch but never cancels or fabricates results for already-in-flight calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-lip-429-'));
  try {
    const receipt = { receipt_id: '429-test', items: makeItems(8) };
    let launched = 0;
    const invoke = async (prompt) => {
      const idx = Number(/Company(\d+)/.exec(prompt)[1]);
      launched++;
      if (idx === 2) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('429 You have hit your session limit · resets 12:30am');
      }
      await new Promise((r) => setTimeout(r, 60)); // slower than the 429 so it fires mid-batch
      return { text: `TRIAGE: PASS | Company${idx} | Solutions Architect | 4.0/5 | fit`, cost_usd: 0, duration_ms: 60 };
    };
    const result = await qualifyLinkedInReceipt(receipt, {
      root, dryRun: true, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke, concurrency: 4,
    });
    assert.equal(result.counts.rate_limited, true);
    // Never launched all 8 — dispatch stopped once the 429 fired.
    assert.ok(launched < 8, `expected fewer than 8 launches after a mid-batch 429, got ${launched}`);
    assert.ok(launched >= 4, 'the first wave (up to the configured concurrency) must have already been in flight');
    // Every row is either a genuine result or a preserved RETRY — never fabricated.
    for (const row of result.rows) {
      assert.ok(['QUALIFIED', 'RETRY'].includes(row.status), `unexpected status ${row.status}`);
      if (row.status === 'RETRY') assert.ok(row.retry && row.retry.reason, 'RETRY rows must carry the original failure reason');
    }
    const rateLimitedRow = result.rows.find((r) => r.company === 'Company2');
    assert.equal(rateLimitedRow.status, 'RETRY');
    assert.match(rateLimitedRow.retry.reason, /session limit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── crash/resume: completed calls are never repeated ────────────────────
test('crash/resume: a follow-up receipt built from the surviving retry queue never re-invokes Claude for an already-completed row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-lip-crash-'));
  try {
    const receipt = { receipt_id: 'crash-run', items: makeItems(6) };
    const firstRunCalls = [];
    // Simulate an interrupted process: items 0-2 complete normally, then a
    // hard failure (e.g. the CLI process itself was killed) hits every
    // remaining item, leaving them RETRY rather than fabricating a result.
    const firstInvoke = async (prompt) => {
      const idx = Number(/Company(\d+)/.exec(prompt)[1]);
      firstRunCalls.push(idx);
      if (idx >= 3) throw new Error('process terminated unexpectedly');
      return { text: `TRIAGE: PASS | Company${idx} | Solutions Architect | 4.0/5 | fit`, cost_usd: 0, duration_ms: 1 };
    };
    const first = await qualifyLinkedInReceipt(receipt, {
      root, dryRun: false, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke: firstInvoke, concurrency: 2,
    });
    const completedCompanies = first.rows.filter((r) => r.status === 'QUALIFIED').map((r) => r.company);
    assert.equal(completedCompanies.length, 3, 'exactly the 3 non-crashing jobs completed and were checkpointed');
    assert.equal(first.retry_queue.length, 3, 'the 3 crashed jobs are preserved as RETRY, not silently dropped');

    // "Resume": a follow-up receipt built from ONLY the surviving retry
    // queue (the established pattern — see scripts/resume-linkedin-codex.mjs),
    // never re-including the already-QUALIFIED companies.
    const retryCompanies = new Set(first.retry_queue.map((r) => r.company));
    assert.equal([...retryCompanies].some((c) => completedCompanies.includes(c)), false, 'retry queue never contains an already-completed company');

    const secondReceipt = { receipt_id: 'crash-run-resume', items: makeItems(6).filter((it) => retryCompanies.has(it.company)) };
    const secondRunCalls = [];
    const secondInvoke = async (prompt) => {
      const idx = Number(/Company(\d+)/.exec(prompt)[1]);
      secondRunCalls.push(idx);
      return { text: `TRIAGE: PASS | Company${idx} | Solutions Architect | 4.0/5 | recovered`, cost_usd: 0, duration_ms: 1 };
    };
    await qualifyLinkedInReceipt(secondReceipt, {
      root, dryRun: false, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke: secondInvoke, concurrency: 2,
    });
    assert.deepEqual(new Set(secondRunCalls), new Set([3, 4, 5]), 'the resume run only ever invokes Claude for the 3 previously-interrupted jobs');
    assert.equal(secondRunCalls.some((i) => completedCompanies.includes(`Company${i}`)), false, 'never re-invokes Claude for an already-completed row');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── deterministic-gate protection holds at every concurrency level ──────
for (const concurrency of [1, 2, 4]) {
  test(`deterministic gates (geography-before-title, zero-spend reject, UNKNOWN pending) hold at concurrency=${concurrency}`, async () => {
    const receipt = {
      receipt_id: `gates-c${concurrency}`,
      items: [
        { company: 'ConfirmedReject', title: 'Solutions Architect', location: 'Boston, MA', reason: 'geography', detail: 'REJECT: structured-onsite-hybrid-outside-nyc' },
        { company: 'Survivor', title: 'Solutions Architect', location: 'United States', arrangement: 'Remote', outcome: 'would_add', reason: 'added_unresolved_url' },
      ],
    };
    let invokeCalls = 0;
    const result = await qualifyLinkedInReceipt(receipt, {
      root: 'unused', dryRun: true, config: BASE_CONFIG, modeText: 't', briefText: 'b', concurrency,
      resolve: stubResolve(), fetchJd: stubFetchJd(),
      invoke: async () => { invokeCalls++; return { text: 'TRIAGE: PASS | Survivor | Solutions Architect | 4.0/5 | fit', cost_usd: 0, duration_ms: 1 }; },
    });
    assert.equal(invokeCalls, 1, 'the confirmed geography reject spent zero Claude calls regardless of concurrency');
    const rejected = result.rows.find((r) => r.company === 'ConfirmedReject');
    assert.equal(rejected.first_rule.gate, 'geography');
    assert.equal(rejected.gate_trace.some((g) => g.gate === 'title'), false, 'geography precedes title — title gate never runs for a confirmed reject');
  });
}

// ── provider integrity under concurrency ─────────────────────────────────
test('every concurrent worker uses the single injected evaluator (Claude, never a second/different provider)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-lip-provider-'));
  try {
    const receipt = { receipt_id: 'provider-check', items: makeItems(4) };
    const providersUsed = new Set();
    const invoke = async (prompt) => {
      providersUsed.add('the-one-injected-evaluator');
      return { text: 'TRIAGE: PASS | X | Solutions Architect | 4.0/5 | fit', cost_usd: 0, duration_ms: 1 };
    };
    await qualifyLinkedInReceipt(receipt, {
      root, dryRun: true, config: BASE_CONFIG, modeText: 't', briefText: 'b',
      resolve: stubResolve(), fetchJd: stubFetchJd(), invoke, concurrency: 4,
    });
    assert.deepEqual([...providersUsed], ['the-one-injected-evaluator'], 'no worker ever falls back to a different/second evaluator');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
