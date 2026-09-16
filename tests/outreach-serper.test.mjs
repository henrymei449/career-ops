// tests/outreach-serper.test.mjs — Pass 2B: wiring exactly one real
// public-web search provider (Serper) into outreach.mjs's existing,
// unchanged contact-discovery interface. Numbered tests map to the task's
// required-proof list. No real network calls: global fetch is monkeypatched
// per-test and always restored in a finally block.

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
import { markApplied, setOutreachDecision, discoverContacts } from '../outreach.mjs';
import { normalizeCandidate, dedupeCandidates, rankCandidates, buildDiscoveryQueries, classifyRoleFamily } from '../outreach-schema.mjs';
import { serperSearch } from '../lib/outreach-search-serper.mjs';

function scratchRoot() {
  return mkdtempSync(join(tmpdir(), 'co-outreach-serper-test-'));
}

/** Install a fake global.fetch for the duration of `fn`, always restoring it. */
async function withFakeFetch(fakeFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function setupAppliedRequired(root, job) {
  const { batchId, batch } = createBatchFromJobs([job], { root, source: 'test' });
  const jobKey = batch.jobs[0].job_key;
  applyProposedDecisions(batchId, {
    decisions: [{ job_key: jobKey, proposed_decision: 'APPLY', reason: 'strong fit', reason_codes: [] }],
  }, { root });
  finalizeBatch(batchId, { root });
  await ingestFinalizedReviewBatches({ root });
  await markApplied(jobKey, { root });
  await setOutreachDecision(jobKey, 'REQUIRED', { root });
  return jobKey;
}

async function main() {
  // ── 1. generated query reaches the provider ─────────────────────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedRequired(root, {
      url: 'https://boards.greenhouse.io/serper-t/jobs/1',
      company: 'Acme Manufacturing',
      title: 'MES Manufacturing Consultant',
    });
    const seenQueries = [];
    const spy = async (query) => { seenQueries.push(query); return []; };
    await discoverContacts(jobKey, { searchProvider: spy, root });
    const expectedQueries = buildDiscoveryQueries({ company: 'Acme Manufacturing', persona: classifyRoleFamily('MES Manufacturing Consultant') });
    if (seenQueries.length > 0 && seenQueries.every((q) => expectedQueries.some((e) => e.query === q))) {
      pass('1. discoverContacts hands buildDiscoveryQueries() output to the provider verbatim');
    } else fail(`1. provider did not receive the generated queries: ${JSON.stringify(seenQueries)}`);
  }

  // ── query budget: capped to MAX_QUERIES_PER_LANE (2) per lane ──────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedRequired(root, {
      url: 'https://boards.greenhouse.io/serper-t/jobs/2',
      company: 'Wide Co',
      title: 'Solutions Engineer', // SOLUTIONS_ENGINEERING: 4 recruiting (2 queries), 5 functional (3 queries uncapped)
    });
    let calls = 0;
    const spy = async () => { calls += 1; return []; };
    await discoverContacts(jobKey, { searchProvider: spy, root });
    const uncapped = buildDiscoveryQueries({ company: 'Wide Co', persona: 'SOLUTIONS_ENGINEERING' }).length;
    if (uncapped === 5 && calls === 4) {
      pass('query budget: live search issues at most 2 queries per lane, even when persona generates more');
    } else fail(`query budget: expected 4 capped calls (uncapped ${uncapped}), got ${calls}`);
  }

  // ── 2. API key is loaded from env/config only ───────────────────────
  {
    const savedKey = process.env.SERPER_API_KEY;
    process.env.SERPER_API_KEY = 'test-key-abc123';
    let captured = null;
    await withFakeFetch(async (url, opts) => {
      captured = { url: String(url), headers: opts.headers, body: opts.body, method: opts.method };
      return jsonResponse({ organic: [] });
    }, async () => {
      await serperSearch('site:linkedin.com/in "Acme" (Recruiter)');
    });
    process.env.SERPER_API_KEY = savedKey;
    if (captured?.url === 'https://google.serper.dev/search'
      && captured.headers['X-API-KEY'] === 'test-key-abc123'
      && captured.method === 'POST'
      && JSON.parse(captured.body).q === 'site:linkedin.com/in "Acme" (Recruiter)') {
      pass('2. serperSearch sends the env-sourced API key and the query verbatim, nothing hardcoded');
    } else fail(`2. serperSearch request did not match expectations: ${JSON.stringify(captured)}`);
  }

  // ── 3. missing key fails clearly ────────────────────────────────────
  {
    const savedKey = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    try {
      await serperSearch('site:linkedin.com/in "Acme" (Recruiter)');
      fail('3. serperSearch should have thrown with no SERPER_API_KEY set');
    } catch (err) {
      if (/SERPER_API_KEY/.test(err.message)) pass('3. missing SERPER_API_KEY fails with a clear, actionable error');
      else fail(`3. wrong error for missing key: ${err.message}`);
    } finally {
      if (savedKey !== undefined) process.env.SERPER_API_KEY = savedKey;
    }
  }

  // ── 4. LinkedIn /in/ results normalize ──────────────────────────────
  {
    process.env.SERPER_API_KEY = 'test-key';
    const results = await withFakeFetch(async () => jsonResponse({
      organic: [{ title: 'Jane Smith - MES Practice Lead - Acme Manufacturing | LinkedIn', link: 'https://www.linkedin.com/in/janesmith/?trk=abc', snippet: 'MES lead at Acme' }],
    }), () => serperSearch('site:linkedin.com/in "Acme Manufacturing"'));
    const candidate = normalizeCandidate(results[0], { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' });
    if (candidate && candidate.name === 'Jane Smith' && candidate.linkedin_url === 'https://www.linkedin.com/in/janesmith') {
      pass('4. a Serper organic result for a /in/ profile normalizes into a candidate, tracking param stripped');
    } else fail(`4. normalization failed: ${JSON.stringify(candidate)}`);
  }

  // ── 5. non-profile LinkedIn URLs are rejected ───────────────────────
  {
    const nonProfileUrls = [
      'https://www.linkedin.com/jobs/view/12345',
      'https://www.linkedin.com/company/acme-manufacturing/',
      'https://www.linkedin.com/posts/janesmith_hiring-activity',
      'https://www.linkedin.com/feed/update/urn:li:activity:1',
    ];
    const allRejected = nonProfileUrls.every((url) => normalizeCandidate({ title: 'Someone | LinkedIn', url, snippet: '' }, { company: 'Acme', lane: 'FUNCTIONAL' }) === null);
    if (allRejected) pass('5. /jobs/, /company/, /posts/, /feed/ LinkedIn URLs are all rejected as candidates');
    else fail('5. a non-/in/ LinkedIn URL was accepted as a candidate');
  }

  // ── 6. duplicate profile URLs collapse ──────────────────────────────
  {
    const raw = [
      { title: 'Jane Smith - MES Practice Lead - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/janesmith?trk=public_profile', snippet: '' },
      { title: 'Jane Smith - MES Practice Lead - Acme Manufacturing | LinkedIn', url: 'https://www.linkedin.com/in/janesmith/?miniProfileUrn=abc', snippet: '' },
    ];
    const candidates = raw.map((r) => normalizeCandidate(r, { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' })).filter(Boolean);
    const deduped = dedupeCandidates(candidates);
    if (candidates.length === 2 && deduped.length === 1) pass('6. two tracking-param variants of the same profile URL collapse to one candidate');
    else fail(`6. dedup did not collapse variants: ${candidates.length} -> ${deduped.length}`);
  }

  // ── 7. wrong-company results are rejected when deterministically clear ─
  {
    const wrong = normalizeCandidate(
      { title: 'John Doe - MES Practice Lead - Totally Different Corp | LinkedIn', url: 'https://www.linkedin.com/in/johndoe/', snippet: '' },
      { company: 'Acme Manufacturing', lane: 'FUNCTIONAL' },
    );
    if (wrong === null) pass('7. an explicit different current-company mention is rejected');
    else fail('7. a wrong-company result was accepted');
  }

  // ── 8. recruiting/functional lane is preserved end to end ──────────
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedRequired(root, {
      url: 'https://boards.greenhouse.io/serper-t/jobs/3',
      company: 'Acme Manufacturing',
      title: 'MES Manufacturing Consultant',
    });
    process.env.SERPER_API_KEY = 'test-key';
    const { candidates } = await withFakeFetch(async (url, opts) => {
      const q = JSON.parse(opts.body).q;
      const isRecruiting = /Recruiter|Talent/.test(q);
      return jsonResponse({
        organic: [{
          title: isRecruiting
            ? 'Ada Recruiter - Technical Recruiter - Acme Manufacturing | LinkedIn'
            : 'Max Lead - MES Practice Lead - Acme Manufacturing | LinkedIn',
          link: isRecruiting ? 'https://www.linkedin.com/in/adarecruiter/' : 'https://www.linkedin.com/in/maxlead/',
          snippet: '',
        }],
      });
    }, async () => discoverContacts(jobKey, {
      searchProvider: (await import('../lib/outreach-search-serper.mjs')).default,
      root,
    }));
    const recruiting = candidates.filter((c) => c.lane === 'RECRUITING');
    const functional = candidates.filter((c) => c.lane === 'FUNCTIONAL');
    if (recruiting.length >= 1 && recruiting.every((c) => c.name === 'Ada Recruiter')
      && functional.length >= 1 && functional.every((c) => c.name === 'Max Lead')) {
      pass('8. lane assignment survives the full Serper -> normalize -> rank -> persist path');
    } else fail(`8. lane assignment was lost: ${JSON.stringify(candidates)}`);
  }

  // ── 9. provider/network failure never silently yields empty CANDIDATES_FOUND ─
  {
    const root = scratchRoot();
    const jobKey = await setupAppliedRequired(root, {
      url: 'https://boards.greenhouse.io/serper-t/jobs/4',
      company: 'Acme Manufacturing',
      title: 'MES Manufacturing Consultant',
    });
    process.env.SERPER_API_KEY = 'test-key';
    let threw = false;
    await withFakeFetch(async () => { throw new TypeError('fetch failed: ECONNRESET'); }, async () => {
      try {
        await discoverContacts(jobKey, { searchProvider: (await import('../lib/outreach-search-serper.mjs')).default, root });
      } catch {
        threw = true;
      }
    });
    const state = getJobState(jobKey, { root });
    if (threw && state.outreach.status === 'SEARCH_REQUIRED' && state.outreach.candidates.length === 0) {
      pass('9a. a network failure propagates as a thrown error and leaves the job at SEARCH_REQUIRED (retryable), never CANDIDATES_FOUND');
    } else fail(`9a. network failure was not handled safely: threw=${threw}, state=${JSON.stringify(state.outreach)}`);

    // A 200 response with no `organic` field (Serper's shape for e.g. "out of
    // credits") must also be a thrown provider error, not zero candidates.
    let threwOnMalformed = false;
    await withFakeFetch(async () => jsonResponse({ message: 'Not enough credits' }), async () => {
      try {
        await discoverContacts(jobKey, { searchProvider: (await import('../lib/outreach-search-serper.mjs')).default, root });
      } catch {
        threwOnMalformed = true;
      }
    });
    const state2 = getJobState(jobKey, { root });
    if (threwOnMalformed && state2.outreach.status === 'SEARCH_REQUIRED') {
      pass('9b. a 200 response with no organic array is treated as a provider error, not zero candidates');
    } else fail(`9b. malformed-but-200 response was not treated as an error: threw=${threwOnMalformed}`);
  }

  // ── bug found by the live smoke test: never fabricate a company match ──
  // Real Serper/Google snippets often render as "Name - Title at Company |
  // LinkedIn" (one combined segment) rather than three dash-separated
  // segments. The live smoke against "Augury" surfaced a Tenable recruiter
  // ("Tal Egozi - Talent Acquisition Partner at Tenable - LinkedIn") ranking
  // as a #1 same-company match, because normalizeCandidate defaulted an
  // unparsed company to the SEARCHED-for company instead of leaving it
  // blank/ambiguous.
  {
    const wrongCompanyAtForm = normalizeCandidate(
      { title: 'Tal Egozi - Talent Acquisition Partner at Tenable - LinkedIn', url: 'https://il.linkedin.com/in/tal-egozi', snippet: '' },
      { company: 'Augury', lane: 'RECRUITING' },
    );
    if (wrongCompanyAtForm === null) {
      pass('bugfix: "Title at Company" phrasing extracts the company and rejects a deterministic mismatch');
    } else fail(`bugfix: "at Company" wrong-company result was not rejected: ${JSON.stringify(wrongCompanyAtForm)}`);

    const ambiguous = normalizeCandidate(
      { title: 'Jim Viris - Global Head of Talent Acquisition Strategy - LinkedIn', url: 'https://www.linkedin.com/in/jim-viris-0963161', snippet: '' },
      { company: 'Augury', lane: 'RECRUITING' },
    );
    if (ambiguous && ambiguous.company === '') {
      pass('bugfix: an unparseable company is left blank (ambiguous), never fabricated as the searched-for company');
    } else fail(`bugfix: company was fabricated instead of left ambiguous: ${JSON.stringify(ambiguous)}`);

    // The consequence that actually mattered live: ranking must not give the
    // full same-company bonus to a fabricated match.
    const scored = rankCandidates([ambiguous], { company: 'Augury', persona: 'GENERIC_TECHNICAL_COMMERCIAL' });
    if (scored[0].score < 40) {
      pass('bugfix: an ambiguous-company candidate scores below the same-company bonus threshold');
    } else fail(`bugfix: ambiguous candidate still scored as a confirmed company match: ${scored[0].score}`);
  }

  // ── follow-up bug found by the SAME live smoke: former-employee
  // rejection must be target-company-aware ──────────────────────────────
  // The exact live case: "Talent Acquisition Manager at Augury | ex-AWS"
  // was rejected outright because the old FORMER_RE matched "ex-" anywhere
  // in the text, with no regard for WHICH company it named. ex-AWS is
  // irrelevant to an Augury search and must never reject an Augury
  // employee; an explicit former-of-the-TARGET-company signal still must.
  {
    const exUnrelatedCompany = normalizeCandidate(
      { title: 'Rachel Abramovich - Talent Acquisition Manager at Augury | LinkedIn', url: 'https://il.linkedin.com/in/rachel-abramovich/', snippet: 'ex-AWS' },
      { company: 'Augury', lane: 'RECRUITING' },
    );
    if (exUnrelatedCompany && exUnrelatedCompany.name === 'Rachel Abramovich' && exUnrelatedCompany.company === 'Augury') {
      pass('former-fix: "ex-AWS" (unrelated company) does not reject a current Augury employee');
    } else fail(`former-fix: an unrelated ex-employer wrongly rejected/altered the candidate: ${JSON.stringify(exUnrelatedCompany)}`);

    // Same live shape, but the ex-/former segment names the TARGET company
    // itself — this must still reject (segment-form: "... | ex-Augury").
    const exTargetSegment = normalizeCandidate(
      { title: 'Jane Doe - Solutions Engineer - ex-Augury | LinkedIn', url: 'https://www.linkedin.com/in/janedoe/', snippet: '' },
      { company: 'Augury', lane: 'FUNCTIONAL' },
    );
    if (exTargetSegment === null) {
      pass('former-fix: an explicit "ex-Augury" segment still rejects (former of the TARGET company)');
    } else fail(`former-fix: "ex-Augury" should have been rejected: ${JSON.stringify(exTargetSegment)}`);

    // Same requirement, inline-phrase form: "Former Augury ..." within the
    // snippet rather than its own dash-delimited segment.
    const formerTargetInline = normalizeCandidate(
      { title: 'John Smith - Solutions Engineer | LinkedIn', url: 'https://www.linkedin.com/in/johnsmith/', snippet: 'Former Augury Solutions Engineer, now independent consultant' },
      { company: 'Augury', lane: 'FUNCTIONAL' },
    );
    if (formerTargetInline === null) {
      pass('former-fix: an explicit "Former Augury ..." inline phrase still rejects');
    } else fail(`former-fix: inline "Former Augury" should have been rejected: ${JSON.stringify(formerTargetInline)}`);
  }

  // ── 10. existing Pass 2 candidate ranking/select logic is unchanged ──
  {
    const candidate = normalizeCandidate(
      { title: 'Ada Recruiter - Technical Recruiter - Acme Co | LinkedIn', url: 'https://www.linkedin.com/in/adarecruiter/', snippet: '' },
      { company: 'Acme Co', lane: 'RECRUITING' },
    );
    const ranked = rankCandidates([candidate], { company: 'Acme Co', persona: 'GENERIC_TECHNICAL_COMMERCIAL' });
    // Same score this exact input produced before Pass 2B (company match 40 +
    // recruiter-keyword-in-lane-titles 35 + RECRUITER_RE bonus 15 = 90) —
    // a regression guard that Pass 2B did not touch outreach-schema.mjs.
    if (ranked.length === 1 && ranked[0].score === 90) {
      pass('10. rankCandidates() scoring is unchanged from Pass 2 for a known input (90)');
    } else fail(`10. ranking output changed: ${JSON.stringify(ranked)}`);
  }
}

try {
  await main();
} catch (err) {
  fail(`outreach-serper.test.mjs crashed: ${err.stack || err.message}`);
}
