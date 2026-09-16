// tests/adhoc-intake.test.mjs — ad-hoc job intake (#pass3): manual URL ->
// canonical review batch, through the exact same identity/batch machinery
// every sourced job already uses. Network-free by construction: the
// "created" path stubs global.fetch with a Greenhouse-shaped response (the
// same pattern tests/browser-extract.test.mjs already uses), and the
// "unsupported" path uses a loopback URL, which liveness-browser.mjs's SSRF
// guard rejects before any real request is attempted.

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import {
  intakeJob,
  findExistingJob,
  slugToCompanyName,
  guessCompanyFromTitle,
  extractLocationFromJdText,
} from '../adhoc-intake.mjs';
import { createBatchFromJobs, reviewPaths } from '../review.mjs';

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), 'co-adhoc-intake-test-'));
}

function writeDurableState(root, jobs) {
  const p = reviewPaths(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(p.statePath, JSON.stringify({
    schema_version: 1,
    updated_at: new Date().toISOString(),
    ingested_batches: {},
    jobs,
  }, null, 2) + '\n');
}

async function main() {
  // ── 1. pure helpers ──────────────────────────────────────────────────
  if (slugToCompanyName('acme-manufacturing') === 'Acme Manufacturing') {
    pass('1. slugToCompanyName title-cases a hyphenated slug');
  } else fail(`1. slugToCompanyName => ${slugToCompanyName('acme-manufacturing')}`);

  if (guessCompanyFromTitle('Software Engineer at Acme Corp') === 'Acme Corp') {
    pass('1. guessCompanyFromTitle reads "Title at Company"');
  } else fail(`1. guessCompanyFromTitle(at) => ${guessCompanyFromTitle('Software Engineer at Acme Corp')}`);

  if (guessCompanyFromTitle('Software Engineer - Acme Corp | Careers') === 'Acme Corp') {
    pass('1. guessCompanyFromTitle reads "Title - Company | Site"');
  } else fail(`1. guessCompanyFromTitle(dash) => ${guessCompanyFromTitle('Software Engineer - Acme Corp | Careers')}`);

  if (guessCompanyFromTitle('Just A Title With Nothing Useful') === '') {
    pass('1. guessCompanyFromTitle returns empty rather than a wrong guess');
  } else fail(`1. guessCompanyFromTitle(none) => "${guessCompanyFromTitle('Just A Title With Nothing Useful')}"`);

  if (extractLocationFromJdText('Location: Remote - United States\n\nWe are hiring...') === 'Remote - United States') {
    pass('1. extractLocationFromJdText reads the metadata line');
  } else fail('1. extractLocationFromJdText did not read the metadata line');

  if (extractLocationFromJdText('No location line here.') === '') {
    pass('1. extractLocationFromJdText returns empty when absent');
  } else fail('1. extractLocationFromJdText should return empty when absent');

  // ── 2. invalid URL ───────────────────────────────────────────────────
  {
    const root = scratchRoot();
    const result = await intakeJob('not a url', { root });
    if (result.outcome === 'error') pass('2. a non-URL input outcome is "error"');
    else fail(`2. expected error outcome, got ${JSON.stringify(result)}`);

    const ftp = await intakeJob('ftp://example.com/job', { root });
    if (ftp.outcome === 'error') pass('2. a non-http(s) scheme outcome is "error"');
    else fail(`2. expected error outcome for ftp://, got ${JSON.stringify(ftp)}`);
  }

  // ── 3. dedupe via durable state (fit_decision / execution_status axes) ─
  {
    const cases = [
      { fit_decision: 'PASS', execution_status: 'NONE', want: 'PASS' },
      { fit_decision: 'APPLY', execution_status: 'APPLIED', want: 'APPLIED' },
      { fit_decision: 'APPLY', execution_status: 'READY_TO_APPLY', want: 'READY_TO_APPLY' },
      { fit_decision: 'APPLY', execution_status: 'NOT_APPLYING', want: 'NOT_APPLYING' },
      { fit_decision: 'INVESTIGATE', execution_status: 'NONE', want: 'INVESTIGATE' },
    ];
    for (const c of cases) {
      const root = scratchRoot();
      const url = 'https://example.com/jobs/durable-fixture';
      writeDurableState(root, {
        'url:https://example.com/jobs/durable-fixture': {
          fit_decision: c.fit_decision,
          execution_status: c.execution_status,
          company: 'DurableCo',
          title: 'Durable Fixture Role',
          url,
        },
      });
      const result = await intakeJob(url, { root });
      if (result.outcome === 'existing' && result.state === c.want) {
        pass(`3. durable state fit=${c.fit_decision}/exec=${c.execution_status} reports existing as ${c.want}`);
      } else {
        fail(`3. durable state fit=${c.fit_decision}/exec=${c.execution_status} => ${JSON.stringify(result)}`);
      }
    }
  }

  // ── 4. dedupe via an already-open (unfinalized) batch ──────────────────
  {
    const root = scratchRoot();
    const url = 'https://example.com/jobs/open-batch-fixture';
    const { batchId } = createBatchFromJobs(
      [{ url, company: 'OpenBatchCo', title: 'Open Batch Fixture Role', description: 'x'.repeat(300) }],
      { root, source: 'ad_hoc' },
    );
    const result = await intakeJob(url, { root });
    if (result.outcome === 'existing' && result.state === 'UNREVIEWED' && result.batch_id === batchId) {
      pass('4. a URL already sitting in an open batch reports existing/UNREVIEWED with its batch_id');
    } else {
      fail(`4. open-batch dedupe => ${JSON.stringify(result)}`);
    }
  }

  // ── 5. unsupported: a loopback URL is rejected before any real request ─
  {
    const root = scratchRoot();
    const result = await intakeJob('https://127.0.0.1:9/definitely-not-a-real-job', { root });
    if (result.outcome === 'unsupported' && typeof result.reason === 'string' && result.reason.length > 0) {
      pass('5. a loopback URL comes back as "unsupported" with a reason, not a crash');
    } else {
      fail(`5. loopback URL => ${JSON.stringify(result)}`);
    }
  }

  // ── 6. created: stubbed Greenhouse API hit produces a scoped ad_hoc batch
  {
    const root = scratchRoot();
    const url = 'https://boards.greenhouse.io/stubco/jobs/999888';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (reqUrl) => {
      if (String(reqUrl).includes('boards-api.greenhouse.io')) {
        return {
          ok: true,
          json: async () => ({
            title: 'Senior Backend Engineer',
            content: '<p>Build things. Fully remote within the United States.</p>',
            location: { name: 'Remote - United States' },
            offices: [],
          }),
        };
      }
      throw new Error(`unexpected fetch in test: ${reqUrl}`);
    };
    let result;
    try {
      result = await intakeJob(url, { root });
    } finally {
      globalThis.fetch = realFetch;
    }

    if (result.outcome === 'created' && result.job.title === 'Senior Backend Engineer') {
      pass('6. a stubbed known-ATS hit produces outcome "created" with the JD title');
    } else {
      fail(`6. created outcome => ${JSON.stringify(result)}`);
    }
    if (result.outcome === 'created' && result.job.company === 'Stubco') {
      pass('6. company is best-effort derived from the Greenhouse board slug');
    } else {
      fail(`6. company derivation => ${JSON.stringify(result.job)}`);
    }
    if (result.outcome === 'created' && result.job.location === 'Remote - United States') {
      pass('6. location is read from the JD text metadata line');
    } else {
      fail(`6. location derivation => ${JSON.stringify(result.job)}`);
    }
    if (result.outcome === 'created' && Array.isArray(result.evidence_gaps) && result.evidence_gaps.length === 0) {
      pass('6. no evidence gaps reported when company/title/location are all present');
    } else {
      fail(`6. evidence_gaps => ${JSON.stringify(result.evidence_gaps)}`);
    }

    // ── 6b. the SAME URL submitted again reports existing, never a duplicate
    globalThis.fetch = async () => { throw new Error('should not re-capture an already-batched URL'); };
    let second;
    try {
      second = await intakeJob(url, { root });
    } finally {
      globalThis.fetch = realFetch;
    }
    if (second.outcome === 'existing' && second.batch_id === result.batch_id) {
      pass('6b. re-submitting the same URL reports existing in the SAME batch, no re-capture');
    } else {
      fail(`6b. re-submit => ${JSON.stringify(second)}`);
    }
  }

  // ── 7. findExistingJob returns null for a genuinely unseen job_key ─────
  {
    const root = scratchRoot();
    const found = findExistingJob('url:https://example.com/jobs/never-seen', { root });
    if (found === null) pass('7. findExistingJob returns null for an unseen job_key');
    else fail(`7. findExistingJob should be null, got ${JSON.stringify(found)}`);
  }
}

try {
  await main();
} catch (err) {
  fail(`adhoc-intake.test.mjs crashed: ${err.stack || err.message}`);
}
