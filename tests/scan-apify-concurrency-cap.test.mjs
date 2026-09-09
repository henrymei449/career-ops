// tests/scan-apify-concurrency-cap.test.mjs — Apify-backed scan targets get
// their own concurrency pool, separate from every other provider (#3512-scan-batching).
//
// The 2026-09-09 LinkedIn production scan launched all 10 `provider: apify`
// portals.yml entries into the single shared CONCURRENCY=10 worker pool
// (scan.mjs's parallelFetch), exceeding Apify's account-level cap of 5
// concurrent actor runs and failing 5 of 10 families with HTTP 402
// "concurrent-runs-limit-exceeded". dispatchScanTasks partitions tasks by
// `targets[i]._provider.id === 'apify'` into a 5-slot pool, while every other
// provider keeps the existing CONCURRENCY (10) pool untouched — both pools run
// concurrently with each other since they hit unrelated services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const { dispatchScanTasks, parallelFetch, partitionTasksByProvider } =
  await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake target+task pair that tracks concurrency and completion for `providerId`. */
function buildInstrumentedTasks(providerId, count, state) {
  const targets = [];
  const tasks = [];
  for (let n = 0; n < count; n++) {
    targets.push({ name: `${providerId}-${n}`, _provider: { id: providerId } });
    tasks.push(async () => {
      state.concurrent[providerId] = (state.concurrent[providerId] || 0) + 1;
      state.maxConcurrent[providerId] = Math.max(state.maxConcurrent[providerId] || 0, state.concurrent[providerId]);
      await delay(15);
      state.concurrent[providerId] -= 1;
      state.ranCount[providerId] = (state.ranCount[providerId] || 0) + 1;
    });
  }
  return { targets, tasks };
}

test('partitionTasksByProvider splits index-aligned tasks by target._provider.id', () => {
  const targets = [{ _provider: { id: 'apify' } }, { _provider: { id: 'greenhouse' } }, { _provider: { id: 'apify' } }];
  const tasks = [() => 'a', () => 'b', () => 'c'];
  const { matched, rest } = partitionTasksByProvider(targets, tasks, 'apify');
  assert.equal(matched.length, 2);
  assert.equal(rest.length, 1);
  assert.equal(matched[0](), 'a');
  assert.equal(matched[1](), 'c');
  assert.equal(rest[0](), 'b');
});

test('parallelFetch never exceeds its own concurrency limit and runs every task exactly once', async () => {
  const state = { concurrent: {}, maxConcurrent: {}, ranCount: {} };
  const { tasks } = buildInstrumentedTasks('generic', 9, state);
  await parallelFetch(tasks, 4);
  assert.ok(state.maxConcurrent.generic <= 4, `expected max concurrency <= 4, saw ${state.maxConcurrent.generic}`);
  assert.equal(state.ranCount.generic, 9, 'every queued task must run exactly once');
});

test('dispatchScanTasks caps apify tasks at 5 concurrent while non-apify tasks keep using the existing (10) concurrency', async () => {
  const state = { concurrent: {}, maxConcurrent: {}, ranCount: {} };
  const apify = buildInstrumentedTasks('apify', 10, state);
  const other = buildInstrumentedTasks('greenhouse', 10, state);

  const targets = [...apify.targets, ...other.targets];
  const tasks = [...apify.tasks, ...other.tasks];

  await dispatchScanTasks(targets, tasks, { apifyConcurrency: 5, concurrency: 10 });

  // 1. No more than 5 apify tasks run concurrently.
  assert.ok(state.maxConcurrent.apify <= 5, `expected apify max concurrency <= 5, saw ${state.maxConcurrent.apify}`);

  // 3. Every queued apify family eventually runs — none skipped, none retried.
  assert.equal(state.ranCount.apify, 10, 'all 10 apify tasks must run exactly once');

  // 2. Non-apify tasks are unaffected: still pooled at the existing CONCURRENCY
  //    (10), not silently capped down to the apify limit. With 10 tasks and a
  //    limit of 10, every worker starts at once, so peak concurrency should
  //    reach the full 10 — proving the two pools are genuinely independent.
  assert.equal(state.maxConcurrent.greenhouse, 10, `expected non-apify concurrency to reach the full pool size (10), saw ${state.maxConcurrent.greenhouse}`);
  assert.equal(state.ranCount.greenhouse, 10, 'all 10 non-apify tasks must run exactly once');
});

test('dispatchScanTasks is a no-op-safe when there are zero apify tasks (default scan, unchanged behavior)', async () => {
  const state = { concurrent: {}, maxConcurrent: {}, ranCount: {} };
  const other = buildInstrumentedTasks('workday', 3, state);
  await dispatchScanTasks(other.targets, other.tasks, { apifyConcurrency: 5, concurrency: 10 });
  assert.equal(state.ranCount.workday, 3);
  assert.equal(state.ranCount.apify, undefined);
});
