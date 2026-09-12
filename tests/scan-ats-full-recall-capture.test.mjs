// tests/scan-ats-full-recall-capture.test.mjs — scan-ats-full.mjs's Lane B
// wiring (the broad reverse-ATS sweep, the primary intended semantic-recall
// volume source). Its per-job filter chain (processJobs) is an unexported
// closure deep inside main() with many local counters/closures over it —
// extracting it purely for testability would be a larger refactor of an
// already-complex, working file than this task calls for (matching this
// file's own existing test convention: tests/scan-ats-full-title-filter-
// full.test.mjs tests exported pure helpers directly, never the full
// network-backed main()). This suite instead:
//   1. Source-guards the actual wiring — proves the capture hook exists at
//      the title-filter-reject branch, BEFORE the Lane A location_filter
//      check, and that the Lane A pass-through lines are byte-identical to
//      before.
//   2. Functionally tests the exact call shape (runRecallEligibilityChecks
//      + appendRecallCandidateIfNew) with scan-ats-full-shaped job objects
//      (job.company/job.postedAt as epoch ms, source = the ATS name),
//      proving geography rejection and description round-trip work
//      end-to-end through the real functions this hook actually calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ROOT, NODE, rmSync } from './helpers.mjs';
import { runRecallEligibilityChecks } from '../post-title-gate.mjs';

const POST_TITLE_GATE_URL = pathToFileURL(join(ROOT, 'post-title-gate.mjs')).href;
const RECALL_STORE_URL = pathToFileURL(join(ROOT, 'recall-store.mjs')).href;

const SOURCE = readFileSync(join(ROOT, 'scan-ats-full.mjs'), 'utf-8');

// ── Source guard: the wiring is actually present, in the right place ────

test('scan-ats-full.mjs: the capture hook sits at the title-filter-reject branch, before locationFilter', () => {
  const titleFilterLine = SOURCE.indexOf('if (!titleFilter(job.title, companySlug)) {');
  const captureCall = SOURCE.indexOf('runRecallEligibilityChecks(job, { locationFilter })');
  const locationFilterLine = SOURCE.indexOf("if (!locationFilter(job.location, job.url, job.title)) continue;");
  assert.ok(titleFilterLine !== -1, 'title-filter-reject branch not found');
  assert.ok(captureCall !== -1, 'runRecallEligibilityChecks call not found');
  assert.ok(locationFilterLine !== -1, "Lane A's own locationFilter line not found");
  assert.ok(titleFilterLine < captureCall, 'capture must be inside the title-filter-reject branch');
  assert.ok(captureCall < locationFilterLine, 'capture must run before Lane A\'s own location_filter check (title-filter rejects never reach it)');
});

test('scan-ats-full.mjs: capture is gated on opts.captureRecallRejects AND !opts.dryRun', () => {
  assert.match(SOURCE, /if \(opts\.captureRecallRejects && !opts\.dryRun\) \{/);
});

test('scan-ats-full.mjs: --capture-recall-rejects is a known flag, opt-in (not in any always-on path)', () => {
  assert.match(SOURCE, /'--capture-recall-rejects'/);
  assert.match(SOURCE, /captureRecallRejects: args\.includes\('--capture-recall-rejects'\)/);
});

test('scan-ats-full.mjs: Lane A\'s own filter chain lines are unmodified (title -> location -> content -> dedup)', () => {
  assert.match(SOURCE, /if \(!locationFilter\(job\.location, job\.url, job\.title\)\) continue;/);
  assert.match(SOURCE, /if \(!contentFilter\(job\.description, matchedTitleKeywords\(job\.title, fullTitleFilterConfig\)\)\) \{ droppedContent\+\+; continue; \}/);
  assert.match(SOURCE, /if \(seenUrls\.has\(dedupToken\)\) continue;/);
});

// ── Functional: the exact call shape this hook uses, with real job shapes ─
// scan-ats-full.mjs's providers return job.postedAt as epoch ms (same as
// scan.mjs's providers) and job.company set by the provider itself (unlike
// scan.mjs, there's no portals.yml tracked_companies entry to fall back to
// — companySlug is the ATS tenant slug, used only as a last resort).

test('functional: a Toronto-shaped scan-ats-full job is rejected by the geography gate (real Autodesk shape)', () => {
  const job = { title: 'Senior Product Manager, AEC Agentic AI', company: 'Autodesk', location: 'Toronto, ON, CAN', url: 'https://autodesk.wd1.myworkdayjobs.com/Ext/job/Toronto-ON-CAN/x', postedAt: Date.now() };
  const result = runRecallEligibilityChecks(job, { locationFilter: () => true }); // Lane A's own location_filter (unconfigured -> permissive)
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'non_us_geography');
});

test('functional: a US-plausible scan-ats-full job passes eligibility and captures with description intact', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-scan-ats-full-recall-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  try {
    const script = `
      import { runRecallEligibilityChecks } from ${JSON.stringify(POST_TITLE_GATE_URL)};
      import { appendRecallCandidateIfNew, readRecallCandidates } from ${JSON.stringify(RECALL_STORE_URL)};
      const job = {
        title: 'Customer Deployment Lead', company: 'Acme', location: 'New York, NY',
        url: 'https://boards.greenhouse.io/acme/jobs/12345', postedAt: Date.now(),
        description: 'Real JD text.\\nSecond line.',
      };
      const eligibility = runRecallEligibilityChecks(job, { locationFilter: () => true });
      let added = false;
      if (eligibility.accepted) {
        added = await appendRecallCandidateIfNew({
          url: job.url, title: job.title, company: job.company, location: job.location,
          postedAt: '2026-09-11', source: 'greenhouse', description: job.description,
        });
      }
      const rows = readRecallCandidates();
      console.log(JSON.stringify({ accepted: eligibility.accepted, added, row: rows[0] }));
    `;
    const out = execFileSync(NODE, ['--input-type=module', '-e', script], {
      cwd: ROOT, encoding: 'utf-8', timeout: 15000,
      env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
    });
    const { accepted, added, row } = JSON.parse(out.trim());
    assert.equal(accepted, true);
    assert.equal(added, true);
    assert.equal(row.source, 'greenhouse');
    assert.equal(row.description, 'Real JD text.\nSecond line.', 'provider-supplied description must survive the JSONL round-trip');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
