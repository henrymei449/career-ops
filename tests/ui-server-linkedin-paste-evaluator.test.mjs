// tests/ui-server-linkedin-paste-evaluator.test.mjs — regression for the
// Codex-vs-Claude divergence found in the 25-job manual-paste UI test
// (spawn codex ENOENT on all 9 evaluation attempts). qualifyLinkedInReceipt
// (linkedin-qualification.mjs) used to default to invokeCodexTriage whenever
// a caller omitted `invoke`; the /api/review/linkedin-paste route omitted it
// entirely. There is now no implicit evaluator default at all — every caller
// must say explicitly which provider it wants, or qualifyLinkedInReceipt
// throws — so this covers both halves: the actual UI route resolves to
// Claude, and a caller that forgets `invoke` fails loudly instead of
// silently reaching for Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { resolveLinkedInPasteEvaluator } from '../ui-server.mjs';
import { invokeClaudeTriage, invokeCodexTriage, qualifyLinkedInReceipt } from '../linkedin-qualification.mjs';

test('manual-paste UI route resolves the Claude triage evaluator, not Codex', () => {
  const evaluator = resolveLinkedInPasteEvaluator();
  assert.equal(evaluator, invokeClaudeTriage);
  assert.notEqual(evaluator, invokeCodexTriage);
});

test('qualifyLinkedInReceipt has no implicit evaluator default — a missing `invoke` fails clearly instead of silently reaching for Codex', async () => {
  const root = mkdtempSync(join(tmpdir(), 'co-linkedin-qual-noinvoke-'));
  try {
    await assert.rejects(
      () => qualifyLinkedInReceipt(
        { receipt_id: 'no-invoke', items: [{ company: 'A', title: 'Solutions Architect', location: 'Remote - United States', outcome: 'would_add', reason: 'added_unresolved_url' }] },
        { root, dryRun: true, config: {}, modeText: 'triage', briefText: 'brief', resolve: async () => ({ status: 'unresolved', attempts: [] }) },
      ),
      /requires an explicit `invoke` evaluator/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
