#!/usr/bin/env node
/**
 * recall-relevance.mjs — Lane B's cheap, facts-only relevance judge.
 *
 * Reads pending rows from data/recall-candidates.jsonl (title-filter rejects
 * that already survived no-fetch eligibility — see post-title-gate.mjs's
 * runStructuralChecks, called from scan.mjs's --capture-recall-rejects
 * path), asks ONLY: "could this role's TITLE plausibly belong to one of the
 * candidate's target problem spaces, despite not matching a title_filter
 * keyword?" — no JD text, facts only, batched (mirrors rank-pipeline.mjs's
 * existing CLI-dispatch pattern; CLI_CANDIDATES/detectCli are reused
 * directly from it, not reimplemented).
 *
 * Only HIGH confidence promotes, and promotion runs through the EXACT SAME
 * post-title-gate.mjs chain and appendToPipeline/appendToScanHistory calls
 * Lane A itself uses — same dedup, same pipeline, same downstream A-F eval.
 *
 * Locking: claim -> commit, never holding the lock across the LLM call.
 *   1. lock -> select pending/stale-in_flight rows -> mark in_flight -> unlock
 *   2. LLM batches, fully outside the lock
 *   3. lock -> commit verdicts (token-checked) -> unlock
 *   4. HIGH verdicts promoted via the shared gate (no lock needed beyond
 *      what appendToPipeline/appendToScanHistory already take internally)
 *
 * Selection is deterministic (freshness + per-company/per-source caps), not
 * provider-iteration order — see recall-store.mjs's selectForEvaluation.
 *
 * Usage:
 *   node recall-relevance.mjs                          # default cap
 *   node recall-relevance.mjs --recall-eval-cap 20
 *   node recall-relevance.mjs --per-company-cap 5 --per-source-cap 15
 *   node recall-relevance.mjs --cli claude --model claude-sonnet-5
 *   node recall-relevance.mjs --dry-run                # judge, don't promote
 *   node recall-relevance.mjs --json                   # machine-readable summary
 *   node recall-relevance.mjs --self-test
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { execCliSafely } from './cli-exec.mjs';
import { dirname, join } from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { CLI_CANDIDATES, detectCli } from './rank-pipeline.mjs';
import {
  withRecallLock, selectForEvaluation, claimRows, commitVerdict, RECALL_CANDIDATES_PATH,
} from './recall-store.mjs';
import { runPostTitleGate } from './post-title-gate.mjs';
import {
  buildLocationFilter, buildPostingAgeFilter, buildPostedDateFilter, buildSalaryFilter,
  buildContentFilter, buildCountryEligibilityFilter, buildVisaFilter, buildCompanyCanonicalizer,
  loadDedupSnapshot, appendToPipeline, appendToScanHistory, loadCandidateCountry, PORTALS_PATH,
} from './scan.mjs';

const DATA_ROOT = getCareerOpsRoot();
const RECALL_RUNS_PATH = process.env.CAREER_OPS_RECALL_RUNS || join(DATA_ROOT, 'data/recall-runs.tsv');
const RECALL_RUNS_HEADER = 'timestamp\tconsidered\tsent_to_llm\tbatches\thigh\tmedium\tlow\tpromoted\testimated_cost_usd\n';

const DEFAULT_EVAL_CAP = 20;
const EVAL_CAP_CEILING = 200; // same philosophy as rank-pipeline.mjs's LIMIT_CEILING
const DEFAULT_PER_COMPANY_CAP = 5;
const DEFAULT_PER_SOURCE_CAP = 15;
const BATCH_SIZE = 10; // mirrors rank-pipeline.mjs's BATCH_SIZE

const KNOWN_FLAGS = [
  '--recall-eval-cap', '--per-company-cap', '--per-source-cap', '--cli', '--model',
  '--dry-run', '--json', '--help', '-h',
];
const VALUE_FLAGS = ['--recall-eval-cap', '--per-company-cap', '--per-source-cap', '--cli', '--model'];

const USAGE = `Usage:
  node recall-relevance.mjs [options]

  --recall-eval-cap N   max candidates sent to the LLM this run (default ${DEFAULT_EVAL_CAP}, ceiling ${EVAL_CAP_CEILING})
  --per-company-cap N   max candidates per company within this run (default ${DEFAULT_PER_COMPANY_CAP})
  --per-source-cap N    max candidates per source within this run (default ${DEFAULT_PER_SOURCE_CAP})
  --cli <name>          force a specific headless CLI instead of auto-detecting
  --model <name>        passed through to the CLI when it accepts one
  --dry-run             judge and print verdicts, promote nothing
  --json                emit a machine-readable summary line

Only HIGH-confidence verdicts are promoted, through the same post-title gate
and appendToPipeline/appendToScanHistory Lane A itself uses.`;

function clampCap(raw, fallback, ceiling) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), ceiling) : fallback;
}

/**
 * Facts-only prompt — deliberately no JD text (candidates were captured
 * before any JD extraction). Mirrors Pinloop's confirmed quick-judge
 * pattern: structured facts only, explicit instruction to default to a
 * lower confidence when unsure — the same "never invent" discipline
 * Block B's evidence-tier gating already uses elsewhere in this system.
 *
 * @param {object[]} batch
 * @returns {string}
 */
// Truncated, not omitted: a provider-supplied description is real evidence
// this pass should use (per explicit policy — never fetch a NEW JD for this
// cheap pass, but a description already sitting on the captured candidate
// is free and should not be thrown away). Capped to bound batch token cost,
// not because the judge shouldn't see it.
const DESCRIPTION_SNIPPET_CHARS = 600;

function formatCandidateBlock(c, i) {
  const header = `${i}. "${c.title}" — ${c.company} — ${c.location || 'location unknown'} — source: ${c.source || 'unknown'}${c.posted_at ? ` — posted: ${c.posted_at}` : ''}`;
  if (typeof c.description === 'string' && c.description.trim()) {
    const snippet = c.description.trim().slice(0, DESCRIPTION_SNIPPET_CHARS).replace(/\s+/g, ' ');
    return `${header}\n   description (excerpt, already on hand — not a new fetch): ${snippet}${c.description.length > DESCRIPTION_SNIPPET_CHARS ? '…' : ''}`;
  }
  return `${header}\n   description: (not available for this posting)`;
}

/**
 * Facts-only in the sense that matters: no NEW fetch happens for this pass
 * (a JD is never retrieved solely to judge relevance). If the provider
 * already supplied a description at capture time, it rides along as free
 * evidence, per explicit policy ("if description is present ... USE IT").
 *
 * @param {object[]} batch
 * @returns {string}
 */
export function buildJudgePrompt(batch) {
  const list = batch.map(formatCandidateBlock).join('\n');
  return `You are a fast, cheap relevance triage step for a job-search discovery pipeline. Each posting below already FAILED a literal keyword title filter — that is exactly why this pass exists. Decide only: could this role plausibly belong to one of the candidate's target problem spaces despite not matching an existing title keyword? This is a coarse first pass, not a final verdict: postings you mark "high" still go through a full evaluation (reading the complete JD, matching against the candidate's actual CV) before anything is applied to.

TARGET PROBLEM SPACES (the underlying functions/domains, not a keyword list — judge plausibility, not string overlap):
- Manufacturing, semiconductor, and industrial operations
- MES / MOM / QMS (manufacturing execution, operations management, quality management systems)
- Smart factory / Industry 4.0
- Manufacturing analytics: yield, quality, process optimization
- Industrial AI
- Customer-facing technical solutioning
- Solutions engineering / presales
- Implementation / deployment of manufacturing or industrial software
- Discovery, requirements-gathering, or proof-of-concept (POC) work with customers
- Technical GTM (go-to-market)
- Manufacturing systems integration (connecting shop-floor/plant data to enterprise systems)

STRONG RELEVANCE SIGNALS (raise confidence toward high/medium):
- Works directly with factories, fabs, plants, or manufacturers
- Technical customer engagement (not just relationship management)
- Discovery/requirements work, demos, or POCs with customers
- Deployment or implementation of a technical product at a customer site
- Manufacturing systems or plant-data integration
- Operational improvement work (yield, throughput, quality, downtime)
- AI/analytics applied to a real production environment

STRONG EXCLUSIONS (push toward low, even if the company is in this industry):
- Generic SaaS sales (no manufacturing/industrial specificity)
- Pure generic software engineering (no customer-facing or domain-specific signal)
- Consumer AI or consumer products
- Unrelated finance/accounting roles
- Generic IT support/helpdesk
- Unrelated SDR/BDR roles with no industrial/manufacturing focus
- Unrelated facilities/workplace/office-operations roles (a role that MANAGES a physical workplace, not a manufacturing customer)

A company being in the manufacturing/industrial sector does NOT by itself make every role there relevant — an accountant or office-facilities manager at a fab is still low. Judge the ROLE's function against the target problem spaces above, not the employer's industry alone.

Evidence for each posting below: title, company, location, source, posted date, and a description excerpt IF the original provider already supplied one (never invented, never fetched new — some postings have none, which is not itself a negative signal).

RULES:
- "high" ONLY when there is strong, specific evidence of genuine target relevance — you would be surprised if this role turned out irrelevant once someone reads the complete JD.
- "medium" for plausible but genuinely ambiguous adjacency.
- "low" for weak or unrelated evidence.
- When uncertain, bias toward medium/low, never high. A guess dressed up as confidence is worse than an honest "medium".

Postings:
${list}

Respond with ONLY a JSON array, no prose, no markdown fences, one entry per posting above in the same order:
[{"id": 0, "confidence": "high"|"medium"|"low", "reason": "one short phrase"}]`;
}

/**
 * Same "no salvage, safe-empty-on-failure" philosophy as
 * rank-pipeline.mjs's parseBatchResponse — a batch that yields no usable
 * JSON leaves its candidates un-annotated (picked up again next run via
 * their still-'in_flight' status once it goes stale) rather than guessing.
 *
 * @param {string} text
 * @returns {Array<{id: number, confidence: 'high'|'medium'|'low', reason: string}>}
 */
export function parseJudgeResponse(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
  return parsed
    .filter((r) => r && typeof r.id === 'number' && Number.isInteger(r.id) && r.id >= 0 && VALID_CONFIDENCE.has(r.confidence))
    .map((r) => ({ id: r.id, confidence: r.confidence, reason: String(r.reason ?? '').slice(0, 200) }));
}

// See cli-exec.mjs's header for the full root-cause writeup: resolves the
// real target a Windows npm .cmd shim launches (claude.cmd -> claude.exe on
// this machine) and invokes it directly, argv-only, no shell -- fixing the
// ENOENT/EINVAL pair that a bare execFileSync('claude', ...) hit.
const execCliFile = execCliSafely;

/**
 * Adapted from rank-pipeline.mjs's callCli — requests --output-format json
 * from the `claude` CLI specifically so total_cost_usd is available for
 * instrumentation (confirmed present in that envelope); other CLIs in
 * CLI_CANDIDATES don't uniformly expose an equivalent, so cost is left null
 * for them rather than estimated.
 *
 * @returns {{text: string, costUsd: number|null}}
 */
export function callJudgeCli(cli, prompt, model) {
  const args = cli.args(prompt);
  const wantsCostData = cli.bin === 'claude';
  if (wantsCostData) args.push('--output-format', 'json');
  if (model && cli.bin !== 'codex' && cli.bin !== 'opencode') args.push('--model', model);
  const out = execCliFile(cli.bin, args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });
  if (!wantsCostData) return { text: out, costUsd: null };
  try {
    const envelope = JSON.parse(out);
    return {
      text: typeof envelope.result === 'string' ? envelope.result : '',
      costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
    };
  } catch {
    return { text: out, costUsd: null };
  }
}

export function appendRecallRunSummary(counters, filePath = RECALL_RUNS_PATH) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(filePath)) appendFileSync(filePath, RECALL_RUNS_HEADER, 'utf-8');
  const row = [
    counters.timestamp, counters.considered, counters.sentToLlm, counters.batches,
    counters.high, counters.medium, counters.low, counters.promoted,
    counters.estimatedCostUsd == null ? '' : counters.estimatedCostUsd.toFixed(4),
  ].join('\t') + '\n';
  appendFileSync(filePath, row, 'utf-8');
}

/**
 * Rebuilds the post-title-gate filters/dedup state fresh (not reused from
 * whenever capture happened) — portals.yml and the dedup history may both
 * have legitimately changed since capture, so a fresh read is more correct,
 * not a compromise.
 */
function buildPromotionContext() {
  const config = existsSync(PORTALS_PATH) ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}) : {};
  const canonicalizeCompany = buildCompanyCanonicalizer(config.company_aliases);
  const dedupSnapshot = loadDedupSnapshot({}, canonicalizeCompany, {});
  const skipTiers = Array.isArray(config.skip_tiers) ? config.skip_tiers.filter((t) => typeof t === 'string').map((t) => t.toLowerCase()) : [];
  return {
    filters: {
      skipTiers,
      locationFilter: buildLocationFilter(config.location_filter),
      postingAgeFilter: buildPostingAgeFilter(config.max_posting_age_days),
      postedDateFilter: buildPostedDateFilter(null, null), // scan-time date windows don't apply to a delayed promotion
      salaryFilter: buildSalaryFilter(config.salary_filter),
      contentFilter: buildContentFilter(config.content_filter),
      countryEligibilityFilter: buildCountryEligibilityFilter(config.country_eligibility_filter, loadCandidateCountry()),
      visaFilter: buildVisaFilter(config.visa_filter),
      titleFilterConfig: config.title_filter,
    },
    dedupState: {
      seenUrls: dedupSnapshot.seen,
      seenCompanyRoles: dedupSnapshot.seenCompanyRoles,
      seenCompanyRoleBases: dedupSnapshot.seenCompanyRoleBases ?? new Set(),
      canonicalizeCompany,
    },
  };
}

export async function run(args, { callCliFn = callJudgeCli } = {}) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return 0;
  }

  const evalCap = clampCap(flagValue(args, '--recall-eval-cap'), DEFAULT_EVAL_CAP, EVAL_CAP_CEILING);
  const perCompanyCap = clampCap(flagValue(args, '--per-company-cap'), DEFAULT_PER_COMPANY_CAP, EVAL_CAP_CEILING);
  const perSourceCap = clampCap(flagValue(args, '--per-source-cap'), DEFAULT_PER_SOURCE_CAP, EVAL_CAP_CEILING);
  const dryRun = hasFlag(args, '--dry-run');
  const jsonMode = hasFlag(args, '--json');
  const model = flagValue(args, '--model');

  const forced = flagValue(args, '--cli');
  const cli = forced
    ? (CLI_CANDIDATES.find((c) => c.bin === forced) ?? { bin: forced, args: (p) => ['-p', p] })
    : detectCli();
  if (!cli) {
    console.error('No supported agent CLI found (tried: %s).', CLI_CANDIDATES.map((c) => c.bin).join(', '));
    console.error('Install one, or pass --cli <name>. See the Headless / Batch Mode table in AGENTS.md.');
    return 1;
  }

  // ── Claim (locked) ──────────────────────────────────────────────────
  let claimed = [];
  let tokens = new Map();
  let considered = 0;
  await withRecallLock(RECALL_CANDIDATES_PATH, (rows) => {
    considered = rows.filter((r) => r.status === 'pending' || r.status === 'in_flight').length;
    const selected = selectForEvaluation(rows, { cap: evalCap, perCompanyCap, perSourceCap });
    claimed = selected.map((r) => ({ ...r }));
    tokens = claimRows(rows, selected.map((r) => r.url));
    return rows;
  });

  if (claimed.length === 0) {
    console.log('No pending recall candidates to evaluate.');
    if (jsonMode) console.log(JSON.stringify({ version: 'careerops.recall-relevance@1', considered, sentToLlm: 0, batches: 0, high: 0, medium: 0, low: 0, promoted: 0 }));
    return 0;
  }

  // ── LLM batches — OUTSIDE the lock ───────────────────────────────────
  let sentToLlm = 0;
  let batches = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  let estimatedCostUsd = 0;
  let hadCost = false;
  const verdicts = [];

  for (let i = 0; i < claimed.length; i += BATCH_SIZE) {
    const batch = claimed.slice(i, i + BATCH_SIZE);
    batches += 1;
    sentToLlm += batch.length;
    let result;
    try {
      result = callCliFn(cli, buildJudgePrompt(batch), model);
    } catch (err) {
      console.error(`  batch ${batches}: CLI call failed (${err.code ?? err.message}) — left claimed for stale-recovery`);
      continue;
    }
    if (result.costUsd != null) {
      estimatedCostUsd += result.costUsd;
      hadCost = true;
    }
    const parsed = parseJudgeResponse(result.text);
    if (!parsed.length) {
      console.error(`  batch ${batches}: no usable JSON in response — left claimed for stale-recovery`);
      continue;
    }
    for (const r of parsed) {
      const candidate = batch[r.id];
      if (!candidate) continue;
      verdicts.push({ url: candidate.url, claimToken: tokens.get(candidate.url), confidence: r.confidence, reason: r.reason, candidate });
      if (r.confidence === 'high') highCount += 1;
      else if (r.confidence === 'medium') mediumCount += 1;
      else lowCount += 1;
    }
  }

  // ── Commit (locked) ──────────────────────────────────────────────────
  await withRecallLock(RECALL_CANDIDATES_PATH, (rows) => {
    for (const v of verdicts) {
      commitVerdict(rows, { url: v.url, claimToken: v.claimToken, status: `evaluated_${v.confidence}`, confidence: v.confidence, reason: v.reason });
    }
    return rows;
  });

  // ── Promotion — HIGH only, through the SHARED post-title gate ────────
  let promoted = 0;
  const highVerdicts = verdicts.filter((v) => v.confidence === 'high');
  if (dryRun) {
    for (const v of highVerdicts) console.log(`[dry-run] would attempt promotion: ${v.candidate.company} — ${v.candidate.title} (${v.reason})`);
  } else if (highVerdicts.length > 0) {
    const { filters, dedupState } = buildPromotionContext();
    const toPromote = [];
    for (const v of highVerdicts) {
      const job = {
        title: v.candidate.title,
        company: v.candidate.company,
        location: v.candidate.location,
        url: v.candidate.url,
        postedAt: v.candidate.posted_at ? Date.parse(v.candidate.posted_at) : undefined,
        description: v.candidate.description || undefined,
      };
      const gateResult = runPostTitleGate(job, filters, dedupState);
      if (!gateResult.accepted) continue; // same gate Lane A runs — a bad recall candidate is still caught here
      job.note = 'discovery_lane=semantic_recall';
      job.source = v.candidate.source || 'Semantic Recall';
      toPromote.push(job);
    }
    if (toPromote.length > 0) {
      await appendToPipeline(toPromote);
      await appendToScanHistory(toPromote, localToday(), 'added');
      promoted = toPromote.length;
    }
  }

  appendRecallRunSummary({
    timestamp: new Date().toISOString(), considered, sentToLlm, batches,
    high: highCount, medium: mediumCount, low: lowCount, promoted,
    estimatedCostUsd: hadCost ? estimatedCostUsd : null,
  });

  const summary = { version: 'careerops.recall-relevance@1', considered, sentToLlm, batches, high: highCount, medium: mediumCount, low: lowCount, promoted, estimated_cost_usd: hadCost ? Number(estimatedCostUsd.toFixed(4)) : null };
  if (jsonMode) {
    console.log(JSON.stringify(summary));
  } else {
    console.log(`Considered: ${considered} | sent to LLM: ${sentToLlm} in ${batches} batch(es)`);
    console.log(`High: ${highCount} | Medium: ${mediumCount} | Low: ${lowCount}`);
    console.log(`Promoted: ${promoted}${dryRun ? ' (dry-run — nothing written)' : ''}`);
    console.log(`Estimated cost: ${hadCost ? `$${estimatedCostUsd.toFixed(4)}` : 'unknown (CLI does not expose cost)'}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  run(args).then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  });
}
