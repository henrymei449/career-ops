// tests/outreach.test.mjs — Pass 2: application execution + outreach
// lifecycle (READY_TO_APPLY -> APPLIED -> outreach decision -> contact
// discovery -> human selection). Numbered tests map to the task's
// required-proof list.

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail } from './helpers.mjs';

import {
  createBatchFromJobs,
  applyProposedDecisions,
  finalizeBatch,
  ingestFinalizedReviewBatches,
  getJobState,
} from '../review.mjs';
import {
  markApplied,
  setOutreachDecision,
  startOutreach,
  discoverContacts,
  selectContacts,
  listOutreach,
} from '../outreach.mjs';
import {
  buildDiscoveryQueries,
  classifyRoleFamily,
  normalizeCandidate,
  parseSearchResultTitle,
} from '../outreach-schema.mjs';

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), 'co-outreach-test-'));
}

const SAMPLE_JOB = {
  url: 'https://boards.greenhouse.io/acme/jobs/999?utm_source=x',
  company: 'Acme Manufacturing',
  title: 'MES Manufacturing Consultant',
  location: 'Remote - United States',
  source: 'greenhouse',
  postedAt: '2026-09-01',
  description: 'MES implementation consulting role, fully remote within the United States.',
};

/** Drive a job all the way to a finalized APPLY, durable READY_TO_APPLY. */
async function setupAppliedReady(root, job = SAMPLE_JOB) {
  const { batchId, batch } = createBatchFromJobs([job], { root, source: 'test' });
  const jobKey = batch.jobs[0].job_key;
  applyProposedDecisions(batchId, {
    decisions: [{ job_key: jobKey, proposed_decision: 'APPLY', reason: 'strong fit', reason_codes: [] }],
  }, { root });
  finalizeBatch(batchId, { reviewer: 'test-human', root });
  await ingestFinalizedReviewBatches({ root });
  return jobKey;
}

async function main() {
  // ── 1. READY_TO_APPLY -> APPLIED ────────────────────────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    const before = getJobState(jobKey, { root });
    if (before.execution_status === 'READY_TO_APPLY') pass('1. finalized APPLY starts READY_TO_APPLY');
    else fail(`1. expected READY_TO_APPLY, got ${before.execution_status}`);

    const { alreadyApplied, job } = await markApplied(jobKey, { root });
    if (!alreadyApplied && job.execution_status === 'APPLIED' && job.applied_at) {
      pass('1. markApplied transitions READY_TO_APPLY -> APPLIED with a timestamp');
    } else fail(`1. markApplied did not transition correctly: ${JSON.stringify(job)}`);
  }

  // ── 2. APPLIED creates outreach.decision = PENDING ──────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    const { job } = await markApplied(jobKey, { root });
    if (job.outreach?.decision === 'PENDING' && job.outreach?.status === 'NOT_STARTED') {
      pass('2. marking APPLIED creates outreach.decision=PENDING before resolution');
    } else fail(`2. outreach was not PENDING: ${JSON.stringify(job.outreach)}`);
  }

  // ── 3. REQUIRED -> SEARCH_REQUIRED ──────────────────────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    const outreach = await setOutreachDecision(jobKey, 'REQUIRED', { root });
    if (outreach.decision === 'REQUIRED' && outreach.status === 'SEARCH_REQUIRED') {
      pass('3. REQUIRED decision sets status=SEARCH_REQUIRED');
    } else fail(`3. REQUIRED did not set SEARCH_REQUIRED: ${JSON.stringify(outreach)}`);
  }

  // ── 4. OPTIONAL -> NOT_STARTED and remains retrievable ──────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    const outreach = await setOutreachDecision(jobKey, 'OPTIONAL', { root });
    if (outreach.decision === 'OPTIONAL' && outreach.status === 'NOT_STARTED') {
      pass('4. OPTIONAL decision sets status=NOT_STARTED');
    } else fail(`4. OPTIONAL did not set NOT_STARTED: ${JSON.stringify(outreach)}`);

    const listed = listOutreach({ root, filter: 'optional' });
    if (listed.some((e) => e.job_key === jobKey)) pass('4. OPTIONAL job remains retrievable via list(--filter optional)');
    else fail('4. OPTIONAL job disappeared from list()');
  }

  // ── 5. WAIVED -> COMPLETE ────────────────────────────────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    const outreach = await setOutreachDecision(jobKey, 'WAIVED', { root });
    if (outreach.decision === 'WAIVED' && outreach.status === 'COMPLETE') {
      pass('5. WAIVED decision sets status=COMPLETE');
    } else fail(`5. WAIVED did not set COMPLETE: ${JSON.stringify(outreach)}`);
  }

  // ── 6. OPTIONAL can later start outreach without becoming REQUIRED ──
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    await setOutreachDecision(jobKey, 'OPTIONAL', { root });
    const { alreadyStarted, outreach } = await startOutreach(jobKey, { root });
    if (!alreadyStarted && outreach.status === 'SEARCH_REQUIRED' && outreach.decision === 'OPTIONAL') {
      pass('6. startOutreach moves an OPTIONAL job to SEARCH_REQUIRED while decision stays OPTIONAL');
    } else fail(`6. startOutreach did not behave correctly: ${JSON.stringify(outreach)}`);
  }

  // ── 7. non-APPLY job cannot be marked APPLIED ───────────────────────
  {
    const root = scratchRoot();
    const { batchId, batch } = createBatchFromJobs([{ ...SAMPLE_JOB, url: 'https://boards.greenhouse.io/acme/jobs/1000' }], { root, source: 'test' });
    const jobKey = batch.jobs[0].job_key;
    applyProposedDecisions(batchId, {
      decisions: [{ job_key: jobKey, proposed_decision: 'PASS', reason: 'geography gate', reason_codes: [] }],
    }, { root });
    finalizeBatch(batchId, { root });
    await ingestFinalizedReviewBatches({ root });
    try {
      await markApplied(jobKey, { root });
      fail('7. markApplied should have refused a PASS-decision job');
    } catch (err) {
      if (/fit_decision=PASS/.test(err.message)) pass('7. markApplied refuses a non-APPLY job');
      else fail(`7. markApplied threw the wrong error: ${err.message}`);
    }
  }

  // ── 8. duplicate applied invocation is idempotent ───────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    const first = await markApplied(jobKey, { root });
    const second = await markApplied(jobKey, { root });
    if (!first.alreadyApplied && second.alreadyApplied && second.job.applied_at === first.job.applied_at) {
      pass('8. duplicate applied invocation is safe/idempotent (applied_at unchanged)');
    } else fail(`8. duplicate applied invocation was not idempotent: ${JSON.stringify({ first, second })}`);
  }

  // ── 9. query generation produces recruiting + functional searches ──
  {
    const persona = classifyRoleFamily('MES Manufacturing Consultant');
    if (persona === 'MES_MANUFACTURING_CONSULTING') pass('9. classifyRoleFamily matches an MES title to the MES family');
    else fail(`9. classifyRoleFamily picked ${persona} for an MES title`);

    const queries = buildDiscoveryQueries({ company: 'Acme Manufacturing', persona });
    const hasRecruiting = queries.some((q) => q.lane === 'RECRUITING' && q.query.includes('site:linkedin.com/in') && q.query.includes('Acme Manufacturing'));
    const hasFunctional = queries.some((q) => q.lane === 'FUNCTIONAL' && q.query.includes('site:linkedin.com/in') && q.query.includes('Acme Manufacturing'));
    if (hasRecruiting && hasFunctional) pass('9. buildDiscoveryQueries produces both recruiting and functional lane queries');
    else fail(`9. missing a lane in generated queries: ${JSON.stringify(queries)}`);

    const genericPersona = classifyRoleFamily('Completely Unrelated Widget Painter');
    if (genericPersona === 'GENERIC_TECHNICAL_COMMERCIAL') pass('9. an unrecognized title falls back to GENERIC_TECHNICAL_COMMERCIAL');
    else fail(`9. unrecognized title did not fall back: ${genericPersona}`);
  }

  // ── 10. candidate normalization rejects wrong-company / malformed ──
  {
    const good = normalizeCandidate(
      { title: 'Jane Smith - MES Practice Lead - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/janesmith/', snippet: '' },
      { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' },
    );
    if (good && good.name === 'Jane Smith' && good.lane === 'FUNCTIONAL') pass('10. a well-formed same-company result normalizes to a candidate');
    else fail(`10. well-formed result failed to normalize: ${JSON.stringify(good)}`);

    const wrongCompany = normalizeCandidate(
      { title: 'John Doe - MES Practice Lead - Totally Different Corp | LinkedIn', url: 'https://www.linkedin.com/in/johndoe/', snippet: '' },
      { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' },
    );
    if (wrongCompany === null) pass('10. a different explicit company is rejected');
    else fail(`10. wrong-company result was not rejected: ${JSON.stringify(wrongCompany)}`);

    const notAProfile = normalizeCandidate(
      { title: 'Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/company/acme/', snippet: '' },
      { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' },
    );
    if (notAProfile === null) pass('10. a non-/in/ URL (company page) is rejected');
    else fail('10. a company-page URL was accepted as a candidate');

    const former = normalizeCandidate(
      { title: 'Pat Lee - Former MES Practice Lead at Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/patlee/', snippet: '' },
      { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' },
    );
    if (former === null) pass('10. a "former" signal is rejected');
    else fail('10. a former-employee result was accepted as a candidate');

    const parsed = parseSearchResultTitle('Jane Smith - MES Practice Lead - Acme Manufacturing | LinkedIn');
    if (parsed.name === 'Jane Smith' && parsed.title === 'MES Practice Lead' && parsed.company === 'Acme Manufacturing') {
      pass('10. parseSearchResultTitle splits name/title/company correctly');
    } else fail(`10. parseSearchResultTitle mis-split: ${JSON.stringify(parsed)}`);
  }

  // ── 11. CANDIDATES_FOUND persists candidates correctly ──────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    await setOutreachDecision(jobKey, 'REQUIRED', { root });

    const fakeProvider = async (query) => {
      if (query.includes('Recruiter') || query.includes('Talent')) {
        return [{ title: 'Ada Recruiter - Technical Recruiter - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/adarecruiter/', snippet: '' }];
      }
      return [{ title: 'Max Lead - MES Practice Lead - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/maxlead/', snippet: '' }];
    };
    const { candidates, outreach } = await discoverContacts(jobKey, { searchProvider: fakeProvider, root });
    const recruiting = candidates.filter((c) => c.lane === 'RECRUITING');
    const functional = candidates.filter((c) => c.lane === 'FUNCTIONAL');
    if (outreach.status === 'CANDIDATES_FOUND' && recruiting.length >= 1 && functional.length >= 1 && candidates.length <= 6) {
      pass('11. discoverContacts persists candidates and sets status=CANDIDATES_FOUND');
    } else fail(`11. discoverContacts did not persist as expected: ${JSON.stringify({ candidates, outreach })}`);

    const state = getJobState(jobKey, { root });
    if (state.outreach.candidates.length === candidates.length) pass('11. persisted candidates round-trip through durable state');
    else fail('11. durable state candidates do not match discoverContacts() result');
  }

  // ── 12. human selection persists + transitions to CONTACTS_SELECTED ─
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    await markApplied(jobKey, { root });
    await setOutreachDecision(jobKey, 'REQUIRED', { root });
    const fakeProvider = async () => [
      { title: 'Ada Recruiter - Technical Recruiter - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/adarecruiter/', snippet: '' },
      { title: 'Max Lead - MES Practice Lead - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/maxlead/', snippet: '' },
    ];
    const { candidates } = await discoverContacts(jobKey, { searchProvider: fakeProvider, root });
    const pickIds = candidates.slice(0, 2).map((c) => c.candidate_id);
    const outreach = await selectContacts(jobKey, pickIds, { root });
    if (outreach.status === 'CONTACTS_SELECTED' && outreach.selected_contacts.length === pickIds.length) {
      pass('12. selectContacts persists selection and transitions to CONTACTS_SELECTED');
    } else fail(`12. selectContacts did not behave correctly: ${JSON.stringify(outreach)}`);

    try {
      await selectContacts(jobKey, ['cand-doesnotexist'], { root });
      fail('12. selectContacts should reject an unknown candidate id');
    } catch (err) {
      if (/unknown candidate id/.test(err.message)) pass('12. selectContacts rejects an unknown candidate id');
      else fail(`12. selectContacts threw the wrong error: ${err.message}`);
    }
  }

  // ── 13. existing review-state behavior from Pass 1 remains intact ──
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedReady(root);
    const beforeApply = getJobState(jobKey, { root });
    if (beforeApply.fit_decision === 'APPLY' && beforeApply.execution_status === 'READY_TO_APPLY' && !beforeApply.outreach) {
      pass('13. Pass 1 ingestion still produces a plain READY_TO_APPLY record with no outreach field');
    } else fail(`13. Pass 1 ingestion output changed shape: ${JSON.stringify(beforeApply)}`);

    await markApplied(jobKey, { root });
    const after = getJobState(jobKey, { root });
    if (after.fit_decision === 'APPLY' && after.company === beforeApply.company && after.url === beforeApply.url) {
      pass('13. outreach.mjs mutation preserves Pass 1 fields (fit_decision, company, url) untouched');
    } else fail('13. outreach.mjs mutation clobbered a Pass 1 field');
  }
}

try {
  await main();
} catch (err) {
  fail(`outreach.test.mjs crashed: ${err.stack || err.message}`);
}
