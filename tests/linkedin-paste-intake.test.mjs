// tests/linkedin-paste-intake.test.mjs — manual LinkedIn result-page paste ->
// the NORMAL Review batch. Everything runs against a throwaway data root
// (CAREER_OPS_ROOT is pointed at a temp dir BEFORE any module loads), so no
// production file is read or written. The fixture state copies the real
// shapes of the Kinaxis (APPLIED, cr-keyed), CONVERGIX Detroit (PASS,
// cr-keyed) and IFS (APPLIED, SmartRecruiters url-keyed) records.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pass, fail, rmSync } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(__dirname, '..', 'test-fixtures', 'linkedin-paste', 'sample-25.txt'), 'utf-8');
const CAPTURED_AT = '2026-09-22T15:00:00.000Z';
const QUERY = 'forward deployed engineer manufacturing';

const sandbox = mkdtempSync(join(tmpdir(), 'co-lip-'));
process.env.CAREER_OPS_ROOT = sandbox; // module-level DATA_ROOTs resolve here, never to production
delete process.env.CAREER_OPS_DATA_DIR;
delete process.env.CAREER_OPS_TRACKER;

const lip = await import('../linkedin-paste-intake.mjs');
const review = await import('../review.mjs');
const ui = await import('../ui-server.mjs');
const gate = await import('../resume-gate.mjs');

const IFS_URL = 'https://jobs.smartrecruiters.com/ifs1/744000149374069-customer-success-manager-manufacturing';

function seedRoot() {
  const root = mkdtempSync(join(sandbox, 'root-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  const jobs = {
    'cr:kinaxis::business consultant@@us': { fit_decision: 'APPLY', execution_status: 'APPLIED', reason: '', company: 'Kinaxis', title: 'Business Consultant', url: '', batch_id: 'batch-20260910-0001', decided_at: '2026-09-10T12:00:00.000Z', applied_at: '2026-09-11T12:00:00.000Z' },
    'cr:convergix automation solutions::solutions architect@@detroit mi': { fit_decision: 'PASS', execution_status: 'NONE', reason: 'on-site Detroit', company: 'CONVERGIX Automation Solutions', title: 'Solutions Architect', url: 'local:jds/convergix-automation-solutions-solutions-architect-4b40e49359.md', batch_id: 'batch-20260912-0002', decided_at: '2026-09-12T12:00:00.000Z' },
    [`url:${IFS_URL}`]: { fit_decision: 'APPLY', execution_status: 'APPLIED', reason: '', company: 'IFS', title: 'Customer Success Manager / Manufacturing', url: IFS_URL, batch_id: 'batch-20260915-0001', decided_at: '2026-09-15T12:00:00.000Z', applied_at: '2026-09-16T12:00:00.000Z' },
    'url:https://jobs.smartrecruiters.com/ifs1/744000147194305-forward-deployed-engineer': { fit_decision: 'PASS', execution_status: 'NONE', reason: '', company: 'IFS', title: 'Forward Deployed Engineer', url: 'https://jobs.smartrecruiters.com/ifs1/744000147194305-forward-deployed-engineer', batch_id: 'batch-20260915-0001', decided_at: '2026-09-15T12:00:00.000Z' },
  };
  writeFileSync(join(root, 'data', 'review-state.json'), JSON.stringify({ schema_version: 1, updated_at: null, ingested_batches: {}, jobs }, null, 2));
  // An already-open batch from normal discovery holding the Samsara role.
  review.createBatchFromJobs([{ url: 'https://www.samsara.com/company/careers/roles/7001', company: 'Samsara', title: 'Solutions Engineer, Manufacturing', location: 'United States', description: 'Remote - United States' }], { root, source: 'pipeline.md' });
  writeFileSync(join(root, 'data', 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
    + 'https://jobs.lever.co/oden/5f2d1c3a-1111-2222-3333-444455556666\t2026-09-16\tlever-api\tSolutions Engineer\tOden Technologies\tadded\tNew York, NY\n');
  writeFileSync(join(root, 'data', 'blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme Staffing Partners | 2026-09-01 | company-wide | agency |\n');
  writeFileSync(join(root, 'data', 'discard.log'), '2026-09-10T00:00:00Z\thttps://guidewheel.com/careers/1\t(SKIP_COMPANY) Guidewheel -- not a fit\n');
  return root;
}

const byTitle = (receipt, company, location) => receipt.items.filter((i) => i.company === company && (!location || i.location === location));
const openBatchFiles = (root) => readdirSync(join(root, 'review', 'open')).filter((f) => f.endsWith('.json'));

async function main() {
  // ── Parsing ──────────────────────────────────────────────────────────
  const { cards } = lip.parseLinkedInPaste(SAMPLE, { capturedAt: CAPTURED_AT });
  if (cards.length === 25) pass('parser: two pasted result pages yield exactly the 25 postings');
  else fail(`parser: expected 25 cards, got ${cards.length}`);
  const kinaxis = cards[0];
  if (kinaxis.title === 'Business Consultant' && kinaxis.company === 'Kinaxis' && kinaxis.location === 'United States' && kinaxis.arrangement === 'Remote'
    && kinaxis.compensation === '$110K/yr - $140K/yr' && kinaxis.posting_age === '2 weeks ago' && kinaxis.posted_date === '2026-09-08' && kinaxis.labels.join() === 'Viewed') {
    pass('parser: title/employer/geography/arrangement/compensation/age/Viewed label extracted; "with verification" duplicate title dropped');
  } else fail(`parser: Kinaxis card wrong: ${JSON.stringify(kinaxis)}`);
  if (cards.some((c) => c.company === 'AT&T') && !cards.some((c) => /&amp;/.test(c.company))) pass('parser: HTML entities decoded (AT&amp;T -> AT&T)');
  else fail('parser: entity not decoded');
  const litmus = cards.find((c) => c.company === 'Litmus');
  const hitachi = cards.find((c) => c.company === 'Hitachi Vantara');
  if (litmus?.labels.includes('Applied') && hitachi?.labels.includes('Saved') && cards.find((c) => c.company === 'Acme Staffing Partners')?.posted_date === '2026-09-22') pass('parser: Applied / Saved labels and "Just now" age recognized');
  else fail('parser: labels/age wrong');
  const convergix = cards.filter((c) => c.company === 'CONVERGIX Automation Solutions').map((c) => `${c.location}|${c.arrangement}`);
  if (convergix.join() === 'Detroit, MI|On-site,United States|Remote') pass('parser: both CONVERGIX location variants kept as separate cards');
  else fail(`parser: CONVERGIX variants ${convergix}`);
  const noise = lip.parseLinkedInPaste('Jobs you may be interested in\n614 results\nNext\n1\n2\n').cards;
  if (noise.length === 0) pass('parser: page chrome alone yields no cards');
  else fail(`parser: noise produced ${noise.length} card(s)`);
  const html = '<li><div>Sales Engineer</div><div>Litmus</div><div>United States (Remote)</div><div>2 days ago</div></li>';
  const fromHtml = lip.parseLinkedInPaste(html).cards;
  if (fromHtml.length === 1 && fromHtml[0].company === 'Litmus' && fromHtml[0].arrangement === 'Remote') pass('parser: tolerates pasted HTML markup');
  else fail(`parser: HTML markup ${JSON.stringify(fromHtml)}`);

  // ── Full import against the fixture data root ──────────────────────
  const root = seedRoot();
  const preBatches = openBatchFiles(root).length;
  const r1 = await lip.importLinkedInPaste({ text: SAMPLE, search_query: QUERY, captured_at: CAPTURED_AT }, { root });
  const c = r1.counts;
  if (c.parsed === 25 && c.duplicate === 2 && c.excluded === 13 && c.added === 10 && c.unresolved === 9) pass('receipt: parsed 25 / duplicate 2 / excluded 13 / added 10 / unresolved 9');
  else fail(`receipt counts ${JSON.stringify(c)}`);
  if (c.duplicate + c.excluded + c.added === c.parsed) pass('receipt: every parsed card has exactly one outcome');
  else fail('receipt: outcomes do not sum to parsed');

  const kin = byTitle(r1, 'Kinaxis');
  if (kin.length === 2 && kin.every((i) => i.outcome === 'excluded' && i.reason === 'already_applied')) pass('Kinaxis: both location variants (United States Remote, Dallas TX) excluded by the existing APPLIED record — not re-queued');
  else fail(`Kinaxis ${JSON.stringify(kin)}`);
  const cvDet = byTitle(r1, 'CONVERGIX Automation Solutions', 'Detroit, MI')[0];
  const cvRem = byTitle(r1, 'CONVERGIX Automation Solutions', 'United States')[0];
  if (cvDet?.outcome === 'excluded' && cvDet.reason === 'suppressed_pass' && cvRem?.outcome === 'added' && cvRem.job_key !== cvDet.matched_job_key) pass('CONVERGIX: Detroit variant suppressed by its PASS; the Remote-US variant is a distinct job and is added (never merged)');
  else fail(`CONVERGIX ${JSON.stringify({ cvDet, cvRem })}`);
  const ifs = byTitle(r1, 'IFS')[0];
  if (ifs?.outcome === 'excluded' && ifs.reason === 'already_applied' && ifs.matched_job_key === `url:${IFS_URL}`) pass('IFS: existing SmartRecruiters application matched by company+role despite no URL in the paste');
  else fail(`IFS ${JSON.stringify(ifs)}`);
  const expect = {
    'Litmus': ['excluded', 'already_applied'],
    'Acme Staffing Partners': ['excluded', 'blacklist'],
    'Guidewheel': ['excluded', 'discard_suppressed'],
    'Samsara': ['duplicate', 'already_known'],
    'Rockwell Automation': ['excluded', 'geography'],
    'Siemens Digital Industries Software': ['excluded', 'geography'],
    'Plex, by Rockwell Automation': ['excluded', 'geography'],
    'MachineMetrics': ['excluded', 'geography'],
    'Instrumental': ['excluded', 'geography'],
    'Poka': ['excluded', 'geography'],
  };
  const wrong = Object.entries(expect).filter(([co, [o, rsn]]) => { const i = byTitle(r1, co)[0]; return !i || i.outcome !== o || i.reason !== rsn; });
  if (wrong.length === 0) pass('routing: LinkedIn Applied label, blacklist, discard.log SKIP_COMPANY, open-batch duplicate and geography rejects all route through existing contracts');
  else fail(`routing mismatches: ${wrong.map(([co]) => `${co}=${JSON.stringify(byTitle(r1, co)[0])}`).join('; ')}`);
  const tulip = byTitle(r1, 'Tulip Interfaces');
  if (tulip.length === 2 && tulip.filter((i) => i.outcome === 'added').length === 1 && tulip.filter((i) => i.reason === 'duplicate_in_paste').length === 1) pass('duplicate text: the card repeated on page 2 is counted once');
  else fail(`Tulip ${JSON.stringify(tulip)}`);
  const oden = byTitle(r1, 'Oden Technologies')[0];
  if (oden?.outcome === 'added' && oden.url === 'https://jobs.lever.co/oden/5f2d1c3a-1111-2222-3333-444455556666' && oden.url_status === 'resolved') pass('URL resolution: exact URL recovered from local scan history (unique company+role+place match)');
  else fail(`Oden ${JSON.stringify(oden)}`);
  const unresolved = r1.items.filter((i) => i.outcome === 'added' && !i.url);
  if (unresolved.length === 9 && unresolved.every((i) => i.reason === 'added_unresolved_url' && i.url_status === 'unresolved')) pass('URL resolution: unmatched survivors are flagged for manual entry with url "" (no invented links)');
  else fail(`unresolved ${JSON.stringify(unresolved.map((i) => [i.company, i.url, i.url_status]))}`);

  // ── Normal Review batch ─────────────────────────────────────────────
  const batch = review.loadOpenBatch(r1.batch_id, { root });
  const { validateBatch } = await import('../review-schema.mjs');
  if (batch && batch.source === 'linkedin_paste' && batch.jobs.length === 10 && validateBatch(batch, 'open').length === 0 && openBatchFiles(root).length === preBatches + 1) pass('batch: survivors land in ONE ordinary open Review batch (source linkedin_paste) that passes the canonical validator');
  else fail(`batch ${JSON.stringify({ src: batch?.source, n: batch?.jobs.length })}`);
  const j0 = batch.jobs.find((j) => j.company === 'Kinaxis');
  const kept = batch.jobs.find((j) => j.company === 'Braincube');
  if (!j0 && kept?.intake?.search_query === QUERY && kept.intake.captured_at === CAPTURED_AT && kept.intake.arrangement === 'Hybrid' && kept.compensation === '$130K/yr - $160K/yr' && kept.posted_date === '2026-09-19' && kept.gates.geography.state === 'NYC_COMPATIBLE') pass('batch: records carry query, capture time, arrangement, compensation, posted date and the geography gate evidence');
  else fail(`batch record ${JSON.stringify(kept)}`);
  const view = ui.listReviewJobsForBatch(r1.batch_id, root);
  if (view?.jobs.length === 10 && view.jobs.every((j) => j.proposed_decision === null && j.final_decision === null)) pass('Review UI read path lists the new batch; every job UNREVIEWED with no decision');
  else fail('Review UI read path');

  // cheap-prune PASS still works on a pasted job and suppresses its repeat.
  const passJob = batch.jobs.find((j) => j.company === 'Augury');
  await review.passJobFromBatch(r1.batch_id, passJob.job_key, { root });
  if (review.isSuppressed(passJob.job_key, { root })) pass('PASS: immediate PASS on a pasted job writes the normal durable PASS record');
  else fail('PASS not durable');

  // Resume Gate still runs on the batch: unresolved (no URL, no JD) -> BLOCKED_MISSING_JD, never dropped.
  const s = await gate.runResumeGateForBatch(r1.batch_id, { root, sop: { path: 'f', source: 'registry', version: '2', sha256: 'x', text: 'sop' }, jdResolvers: [], invoke: async () => { throw new Error('must not be invoked without a JD'); } });
  if (s.total === 9 && s.blocked === 9 && review.loadOpenBatch(r1.batch_id, { root }).jobs.length === 9) pass('Resume Gate: runs on the pasted batch unchanged; JD-less jobs are BLOCKED_MISSING_JD and stay in the batch');
  else fail(`resume gate ${JSON.stringify({ total: s.total, blocked: s.blocked, errors: s.errors })}`);

  // ── Idempotency ─────────────────────────────────────────────────────
  const r2 = await lip.importLinkedInPaste({ text: SAMPLE, search_query: QUERY, captured_at: CAPTURED_AT }, { root });
  if (r2.counts.added === 0 && r2.batch_id === null && openBatchFiles(root).length === preBatches + 1 && r2.counts.parsed === 25) pass('idempotency: re-importing the same paste adds nothing and creates no batch');
  else fail(`repeat import ${JSON.stringify(r2.counts)} batch=${r2.batch_id}`);
  const aug = byTitle(r2, 'Augury')[0];
  if (aug?.outcome === 'excluded' && aug.reason === 'suppressed_pass') pass('idempotency: a job PASSed after the first import is suppressed on re-import');
  else fail(`Augury on repeat ${JSON.stringify(aug)}`);

  // Manual URL entry for an unresolved card, then re-import (URL-less) still dedupes.
  const cvJob = review.loadOpenBatch(r1.batch_id, { root }).jobs.find((j) => j.company === 'CONVERGIX Automation Solutions');
  const set = await lip.setManualJobUrl(r1.batch_id, cvJob.job_key, 'https://www.linkedin.com/jobs/view/solutions-architect-at-convergix-4471112222?refId=abc&trackingId=xyz', { root });
  const after = review.loadOpenBatch(r1.batch_id, { root }).jobs.find((j) => j.company === 'CONVERGIX Automation Solutions');
  if (set.outcome === 'updated' && after.url === 'https://www.linkedin.com/jobs/view/4471112222/' && after.job_key === 'url:https://www.linkedin.com/jobs/view/4471112222' && after.intake.cr_key === cvJob.job_key && after.intake.url_resolution.via === 'manual') pass('manual URL: exact LinkedIn URL canonicalized (tracking stripped), identity re-keyed, original key retained');
  else fail(`manual url ${JSON.stringify({ set, url: after?.url, key: after?.job_key })}`);
  const clash = await lip.setManualJobUrl(r1.batch_id, review.loadOpenBatch(r1.batch_id, { root }).jobs.find((j) => j.company === 'Sight Machine').job_key, IFS_URL, { root });
  if (clash.outcome === 'conflict' && clash.state === 'APPLIED') pass('manual URL: a URL that belongs to another known job is refused as a conflict, never merged');
  else fail(`clash ${JSON.stringify(clash)}`);
  const r3 = await lip.importLinkedInPaste({ text: SAMPLE, search_query: QUERY, captured_at: '2026-09-23T09:00:00.000Z' }, { root });
  if (r3.counts.added === 0 && byTitle(r3, 'CONVERGIX Automation Solutions', 'United States')[0]?.reason === 'already_known') pass('idempotency: after a manual URL is set, a URL-less re-paste of that card is still a duplicate');
  else fail(`r3 ${JSON.stringify(r3.counts)} ${JSON.stringify(byTitle(r3, 'CONVERGIX Automation Solutions'))}`);
  const log = readFileSync(join(root, 'data', 'linkedin-paste-imports.jsonl'), 'utf-8').trim().split('\n');
  if (log.length === 3 && JSON.parse(log[0]).counts.added === 10) pass('receipt log: one JSONL line per import in the data root');
  else fail(`receipt log lines ${log.length}`);

  // ── Distinct requisitions + clipboard HTML links + bounded network ─
  const root2 = seedRoot();
  const twin = 'Forward Deployed Engineer\nNorthwind Robotics\nUnited States (Remote)\n1 day ago\nForward Deployed Engineer\nNorthwind Robotics\nUnited States (Remote)\n2 days ago\n';
  const same = await lip.importLinkedInPaste({ text: twin, search_query: 'q' }, { root: root2, dryRun: true });
  if (same.counts.duplicate === 1 && same.counts.added === 1) pass('duplicate text without job ids: identical company/role/place collapses to one');
  else fail(`twin ${JSON.stringify(same.counts)}`);
  const withIds = await lip.importLinkedInPaste({ text: `${twin.split('\n').slice(0, 4).join('\n')}\nhttps://www.linkedin.com/jobs/view/4400000001/\n${twin.split('\n').slice(4).join('\n')}https://www.linkedin.com/jobs/view/4400000002/\n`, search_query: 'q' }, { root: root2, dryRun: true });
  if (withIds.counts.added === 2 && withIds.counts.duplicate === 0) pass('distinct requisitions: same title/place with different LinkedIn job ids are never merged');
  else fail(`withIds ${JSON.stringify(withIds.counts)}`);
  const links = [{ url: 'https://www.linkedin.com/jobs/view/sales-engineer-at-litmus-4412345678?trk=x', text: 'Sales Engineer' }, { url: 'https://www.linkedin.com/jobs/view/4499999999/', text: 'Solutions Engineer' }];
  const withHtml = await lip.importLinkedInPaste({ text: 'Sales Engineer\nLitmus\nUnited States (Remote)\n\nSolutions Engineer\nAugury\nUnited States (Remote)\n\nSolutions Engineer\nFalkonry\nUnited States (Remote)\n', html_links: links }, { root: root2, dryRun: true });
  const lit = byTitle(withHtml, 'Litmus')[0];
  const ambiguousTitle = withHtml.items.filter((i) => i.title === 'Solutions Engineer');
  if (lit?.url === 'https://www.linkedin.com/jobs/view/4412345678/' && ambiguousTitle.every((i) => !i.url)) pass('clipboard HTML links: a unique title gets its exact job URL; a title shared by two cards stays unresolved');
  else fail(`html links ${JSON.stringify(withHtml.items.map((i) => [i.company, i.url]))}`);

  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    const q = new URL(url).searchParams.get('keywords');
    const body = /Hitachi/.test(q)
      ? '<li><div class="base-card" data-entity-urn="urn:li:jobPosting:4455667788"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/director-at-hitachi-vantara-4455667788?position=1&amp;trk=x"></a><h3 class="base-search-card__title">Director, Manufacturing AI Solutions</h3><h4 class="base-search-card__subtitle"><a>Hitachi Vantara</a></h4><span class="job-search-card__location">United States</span></div></li>'
      : '<li><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/other-1111111111"></a><h3 class="base-search-card__title">Something Else</h3><h4 class="base-search-card__subtitle">Other Co</h4><span class="job-search-card__location">United States</span></li>';
    return { ok: true, status: 200, text: async () => body };
  };
  const capped = await lip.importLinkedInPaste({ text: SAMPLE, search_query: QUERY, captured_at: CAPTURED_AT }, { root: root2, dryRun: true, resolveOnline: true, fetchImpl: fakeFetch, maxLookups: 3 });
  const skipped = capped.items.filter((i) => i.outcome === 'would_add' && !i.url).length;
  if (calls === 3 && skipped === 9) pass('bounded network lookup: hard-capped at 3 requests per import; the rest stay unresolved');
  else fail(`capped ${JSON.stringify({ calls, counts: capped.counts })}`);
  calls = 0;
  const online = await lip.importLinkedInPaste({ text: SAMPLE, search_query: QUERY, captured_at: CAPTURED_AT }, { root: root2, dryRun: true, resolveOnline: true, fetchImpl: fakeFetch, maxLookups: 20 });
  const hv = byTitle(online, 'Hitachi Vantara')[0];
  const linkedinResolved = online.items.filter((i) => i.url && /linkedin/.test(i.url));
  if (calls === 9 && hv?.url === 'https://www.linkedin.com/jobs/view/4455667788/' && linkedinResolved.length === 1 && online.counts.unresolved === 8) pass('bounded network lookup: only an exact company+role+place card resolves (Hitachi); non-matching cards never borrow a URL');
  else fail(`online ${JSON.stringify({ calls, counts: online.counts, hv })}`);
  if (!existsSync(join(root2, 'data', 'linkedin-paste-imports.jsonl')) && openBatchFiles(root2).length === 1) pass('dry-run: no batch and no receipt log written');
  else fail('dry-run wrote files');
}

try {
  await main();
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
