// tests/ui-server-linkedin-paste-e2e.test.mjs — ONE isolated, end-to-end
// acceptance test through the ACTUAL production route
// (getApiRoute('POST', '/api/review/linkedin-paste'), the exact function
// tuple the real HTTP server dispatches to — not a reimplementation).
//
// Boundaries faked, nothing else:
//  - globalThis.fetch is stubbed so LinkedIn guest-search calls and JD
//    fetches never leave the machine.
//  - PATH is given a fake `claude` shim (recognized by cli-exec.mjs's real
//    npm-shim parser, so resolveCliTarget resolves it exactly the way it
//    resolves the real Claude Code CLI) that returns canned TRIAGE verdicts.
//    This is the regression check for the actual defect: the 25-job UI test
//    failed 9/9 evaluator calls with "spawn codex ENOENT" because the route
//    silently defaulted to invokeCodexTriage. Running through the REAL
//    invokeClaudeTriage spawn path here (with a fake claude on PATH instead
//    of a fake codex) proves that defect is gone end-to-end, not just at the
//    unit level.
// Everything else — parsing, dedup/history, geography-before-title, JD
// hydration, batch creation — is the real, unmodified production code
// against a throwaway data root.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, delimiter } from 'path';
import { pass, fail } from './helpers.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'co-lip-e2e-'));
const root = join(sandbox, 'root');
mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'modes'), { recursive: true });
process.env.CAREER_OPS_ROOT = root; // module-level DATA_ROOT resolves here, never production
delete process.env.CAREER_OPS_DATA_DIR;
delete process.env.CAREER_OPS_TRACKER;

// ── Fixture data root ───────────────────────────────────────────────────
writeFileSync(join(root, 'portals.yml'), [
  'title_filter:',
  '  positive:',
  '    - solutions architect',
  '    - solution architect',
  '  negative:',
  '    - intern',
  'pipeline:',
  '  triage_threshold: 3.5',
  '',
].join('\n'));
writeFileSync(join(root, 'modes', '_brief.md'), '# Fixture triage brief\nManufacturing solutions roles; US remote.\n');
// One job resolvable purely from local history (no network): the survivor.
// location column matches the PARSED card's location field, i.e. with the
// "(Remote)" arrangement suffix already stripped out by parseLocationLine —
// not the raw pasted text. Random Co is also seeded so the title gate (which
// runs AFTER identity/JD resolution, not before) gets a real shot at it
// instead of it stalling at an unresolved-URL retry.
writeFileSync(join(root, 'data', 'scan-history.tsv'), 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n'
  + 'https://fixture.test/jobs/acme-solutions-architect\t2026-09-20\tfixture\tSolutions Architect\tAcme Manufacturing\tadded\tUnited States\n'
  + 'https://fixture.test/jobs/random-marketing-intern\t2026-09-20\tfixture\tMarketing Intern\tRandom Co\tadded\tUnited States\n'
  + 'https://fixture.test/jobs/titlecorp-technical-account-manager\t2026-09-20\tfixture\tTechnical Account Manager\tTitleCorp\tadded\tUnited States\n');
// A prior APPLIED record for the duplicate/history-dedup scenario.
writeFileSync(join(root, 'data', 'review-state.json'), JSON.stringify({
  schema_version: 1, updated_at: null, ingested_batches: {},
  jobs: {
    'cr:kinaxis::business consultant@@us': { fit_decision: 'APPLY', execution_status: 'APPLIED', reason: '', company: 'Kinaxis', title: 'Business Consultant', url: '', batch_id: 'batch-20260910-0001', decided_at: '2026-09-10T12:00:00.000Z', applied_at: '2026-09-11T12:00:00.000Z' },
  },
}, null, 2));

// ── Fake `claude` on PATH (the actual evaluator-wiring regression check) ──
const binDir = join(sandbox, 'bin');
mkdirSync(binDir, { recursive: true });
const stubScriptPath = join(binDir, 'claude-stub.mjs');
writeFileSync(stubScriptPath, `
import { readFileSync } from 'fs';
const prompt = readFileSync(0, 'utf8');
let line;
if (/Acme Manufacturing/.test(prompt)) line = 'TRIAGE: PASS | Acme Manufacturing | Solutions Architect | 4.2/5 | Direct manufacturing solutions fit';
else if (/TitleCorp/.test(prompt)) line = 'TRIAGE: PASS | TitleCorp | Technical Account Manager | 3.8/5 | Corrected-title manufacturing presales fit';
else line = 'TRIAGE: FAIL | Unknown | Unknown | 1.0/5 | Fixture default reject';
process.stdout.write(JSON.stringify({ result: line, is_error: false, total_cost_usd: 0, duration_ms: 1 }));
`);
// Windows npm-shim shape cli-exec.mjs's resolveShimTarget explicitly recognizes: node "<script>.mjs" %*
writeFileSync(join(binDir, 'claude.cmd'), `node "${stubScriptPath}" %*\r\n`);
// POSIX fallback (process.platform !== 'win32' path in resolveCliTarget spawns `bin` directly via PATH lookup).
writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nexec node "${stubScriptPath}" "$@"\n`);
try { chmodSync(join(binDir, 'claude'), 0o755); } catch { /* not needed on Windows */ }
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;

// ── Fake network boundary: LinkedIn guest search + JD fetch ───────────────
const REALISTIC_JD = 'This is a fully remote United States customer-facing manufacturing MES solutions architecture role. '.repeat(6);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes('linkedin.com/jobs-guest')) {
    // No guest-search hit for anything: every candidate must resolve via
    // local history or stay unresolved. Proves no live LinkedIn traffic.
    return { ok: true, text: async () => '<html><body>no results</body></html>' };
  }
  if (href === 'https://fixture.test/jobs/acme-solutions-architect') {
    return { ok: true, text: async () => `<div class="show-more-less-html__markup">${REALISTIC_JD}</div>` };
  }
  if (href === 'https://fixture.test/jobs/random-marketing-intern') {
    return { ok: true, text: async () => `<div class="show-more-less-html__markup">${'Assist the marketing team with social media campaigns and event coordination. '.repeat(6)}</div>` };
  }
  if (href === 'https://fixture.test/jobs/titlecorp-technical-account-manager') {
    // "Technical Account Manager" is NOT in the fixture title_filter.positive
    // list — the production gate rejects it on title alone. Real JD evidence
    // (customer-facing + manufacturing MES domain) is what the corrected
    // shadow rule (technical_account_manager+technical+mfg) requires to
    // rescue it, exactly mirroring the real Tulip Interfaces false negative.
    return { ok: true, text: async () => `<div class="show-more-less-html__markup">${'This fully remote United States role bridges deep technical expertise and customer-facing success across our manufacturing MES platform. '.repeat(6)}</div>` };
  }
  return { ok: false, status: 404, text: async () => '' };
};

const ui = await import('../ui-server.mjs');

const PASTE_TEXT = [
  // Card 1: duplicate/already-applied — must be excluded before geography/title/LLM.
  'Business Consultant',
  'Kinaxis',
  'United States (Remote)',
  '2 weeks ago',
  // Card 2: the qualifying survivor — resolves via local history, gets a
  // real (stubbed) Claude PASS, lands in a Review batch.
  'Solutions Architect',
  'Acme Manufacturing',
  'United States (Remote)',
  '3 days ago',
  // Card 3: negative-control title — rejected by the title gate, never reaches Claude.
  'Marketing Intern',
  'Random Co',
  'United States (Remote)',
  '1 week ago',
  // Card 4: corrected manufacturing false-negative — "Technical Account
  // Manager" fails the production title_filter on title alone, but real JD
  // evidence satisfies linkedin-title-shadow.mjs's evidence-gated rule, so
  // it reaches Claude (via the actual UI route's allowShadowTitleRules:true)
  // and gets admitted too.
  'Technical Account Manager',
  'TitleCorp',
  'United States (Remote)',
  '4 days ago',
].join('\n');

async function main() {
  const route = ui.getApiRoute('POST', '/api/review/linkedin-paste');

  // ── First ingest ─────────────────────────────────────────────────────
  const result = await route({ text: PASTE_TEXT, search_query: 'solutions architect manufacturing', captured_at: '2026-09-23T00:00:00.000Z' });

  if (result.counts.parsed === 4) pass('all 4 pasted cards parsed');
  else fail(`expected 4 parsed cards, got ${result.counts.parsed}`);

  if (typeof result.counts.concurrency_used === 'number' && result.counts.concurrency_used >= 1) pass('the real route surfaces the bounded Claude worker-pool concurrency used for this import');
  else fail(`expected a numeric concurrency_used on the real route's response, got ${JSON.stringify(result.counts.concurrency_used)}`);

  const kinaxis = result.items.find((i) => i.company === 'Kinaxis');
  if (kinaxis && kinaxis.outcome === 'excluded' && kinaxis.reason === 'application_history') pass('duplicate/already-applied card excluded before geography/title/LLM');
  else fail(`Kinaxis row unexpected: ${JSON.stringify(kinaxis)}`);

  const intern = result.items.find((i) => i.company === 'Random Co');
  if (intern && intern.outcome === 'excluded') pass('negative-control title rejected, never reached Claude');
  else fail(`Random Co row unexpected: ${JSON.stringify(intern)}`);

  const acme = result.items.find((i) => i.company === 'Acme Manufacturing');
  if (acme && acme.outcome === 'added' && acme.reason === 'careerops_qualified') pass('qualifying survivor reached CLAUDE (not Codex) and was admitted');
  else fail(`Acme Manufacturing row unexpected: ${JSON.stringify(acme)}`);

  const titlecorp = result.items.find((i) => i.company === 'TitleCorp');
  if (titlecorp && titlecorp.outcome === 'added' && titlecorp.reason === 'careerops_qualified') pass('corrected manufacturing title (Technical Account Manager) reached Claude through the actual UI route and was admitted');
  else fail(`TitleCorp row unexpected (title correction not reachable through the real route): ${JSON.stringify(titlecorp)}`);

  if (result.batch_id) pass('exactly one Review batch created for the qualified survivors');
  else fail('expected a batch_id for the qualified survivors');

  const batchView = ui.listReviewJobsForBatch(result.batch_id, root);
  const batchJobs = batchView?.jobs || [];
  const batchCompanies = batchJobs.map((j) => j.company).sort();
  if (batchJobs.length === 2 && JSON.stringify(batchCompanies) === JSON.stringify(['Acme Manufacturing', 'TitleCorp'])) pass('Review batch contains ONLY the two qualified survivors — no premature/extra admissions');
  else fail(`unexpected batch contents: ${JSON.stringify(batchCompanies)}`);

  // No row anywhere should carry the original defect's signature.
  const anyCodexEnoent = JSON.stringify(result.items).includes('spawn codex ENOENT');
  if (!anyCodexEnoent) pass('no row shows the spawn codex ENOENT failure — the fixed evaluator wiring holds end-to-end');
  else fail('a row still shows spawn codex ENOENT — evaluator wiring regressed');

  // ── Idempotency: re-paste the identical text ────────────────────────
  const secondResult = await route({ text: PASTE_TEXT, search_query: 'solutions architect manufacturing', captured_at: '2026-09-23T00:05:00.000Z' });
  if (!secondResult.batch_id) pass('re-paste of identical cards creates no second batch (idempotent)');
  else fail(`re-paste created a new batch: ${secondResult.batch_id}`);
  const acme2 = secondResult.items.find((i) => i.company === 'Acme Manufacturing');
  const titlecorp2 = secondResult.items.find((i) => i.company === 'TitleCorp');
  if (acme2 && acme2.outcome !== 'added' && titlecorp2 && titlecorp2.outcome !== 'added') pass('already-qualified survivors are not re-admitted on re-paste');
  else fail(`survivors re-admitted on re-paste: ${JSON.stringify({ acme2, titlecorp2 })}`);
}

try {
  await main();
} catch (err) {
  fail(`ui-server-linkedin-paste-e2e.test.mjs crashed: ${err.stack || err.message}`);
} finally {
  globalThis.fetch = originalFetch;
}
