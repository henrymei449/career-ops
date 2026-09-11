#!/usr/bin/env node
/**
 * discovery-report.mjs — renders the human review Markdown report for a
 * scheduled discovery run (LinkedIn or Top-100 targeted).
 *
 * Reuses existing, already-persisted artifacts rather than inventing a new
 * receipt schema:
 *   - data/scan-runs.tsv    — per-invocation funnel counters scan.mjs already
 *                              appends on every real run (found/filtered/*
 *                              breakdown, dupes, new_added). This script sums
 *                              the rows written inside the run's own time
 *                              window instead of re-deriving those numbers.
 *   - data/scan-history.tsv — resolves each net-new URL back to its
 *                              company/title/location/portal for the
 *                              PASS/MARGINAL tables.
 *   - location-tier.mjs     — the existing NYC-centric location classifier,
 *                              reused as-is for the "Location Tier" column
 *                              (not a new scoring model).
 *
 * scan.mjs's own --json receipt supplies added_urls/errors for one
 * invocation; a caller with several (the Top-100 cohort runs one scan.mjs
 * process per company) passes all of them in `receipts`.
 *
 * The report is written to {DATA_ROOT}/reports/discovery/{date}_{kind}.md —
 * an operational Drive artifact, not a system file. Nothing here writes to
 * pipeline.md, scan-history.tsv, or applications.md; it only reads them.
 *
 * Usage:
 *   node discovery-report.mjs --payload run.json [--out <path>] [--json]
 *
 * Payload shape — see README below for full field docs:
 *   {
 *     "kind": "linkedin" | "top100",
 *     "date": "YYYY-MM-DD",           // optional, default: local today
 *     "runStartedAt": "ISO",          // required
 *     "runFinishedAt": "ISO",         // optional, default: now
 *     "sinceDays": 2,                  // optional (linkedin)
 *     "model": "claude-sonnet-5",     // optional (top100, when handoff ran)
 *     "receipts": [ <scan.mjs --json receipt>, ... ],
 *     "handoff": <append-pipeline-entry.mjs --json receipt> | null,
 *     "cohort": {                      // optional (top100)
 *       "providerBacked": ["Manufacturo", ...],
 *       "handoffAttempted": ["Siemens Digital Industries Software", ...],
 *       "blockedUnresolved": [{ "name": "...", "reason": "..." }]
 *     },
 *     "notes": ["free-text run note", ...]
 *   }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { classifyLocation, workdayUrlHint } from './location-tier.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

const DATA_ROOT = getCareerOpsRoot();
export const SCAN_RUNS_PATH = process.env.CAREER_OPS_SCAN_RUNS || join(DATA_ROOT, 'data/scan-runs.tsv');
export const SCAN_HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || join(DATA_ROOT, 'data/scan-history.tsv');
export const REPORTS_DIR = join(DATA_ROOT, 'reports/discovery');

const KIND_LABELS = { linkedin: 'LinkedIn Discovery', top100: 'Top-100 Targeted Discovery' };

// PowerShell's `-Encoding utf8` (Set-Content/Out-File, PS 5.1) writes a UTF-8
// byte-order mark, which JSON.parse rejects outright. Every payload/asset
// this script (or a caller building its input) reads may have been written
// by the Windows wrapper scripts, so strip a leading BOM defensively rather
// than push "never use -Encoding utf8" onto every .ps1 author.
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ── scan-runs.tsv (funnel counters) ─────────────────────────────────

/** @param {string} text */
export function parseScanRunsTsv(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const byName = {};
    header.forEach((name, i) => { byName[name] = cols[i] ?? ''; });
    const num = (v) => (v === '' || v == null ? 0 : Number(v) || 0);
    rows.push({
      timestamp: byName.timestamp || '',
      status: byName.status || 'completed',
      found: num(byName.found),
      filteredTitle: num(byName.filtered_title),
      filteredTier: num(byName.filtered_tier),
      filteredLocation: num(byName.filtered_location),
      filteredPostingAge: num(byName.filtered_posting_age),
      filteredSalary: num(byName.filtered_salary),
      filteredContent: num(byName.filtered_content),
      filteredCooldown: num(byName.filtered_cooldown),
      dupes: num(byName.dupes),
      newAdded: num(byName.new_added),
      errors: num(byName.errors),
      filteredBlacklist: num(byName.filtered_blacklist),
      filteredVisa: num(byName.filtered_visa),
      filteredPostedDate: num(byName.filtered_posted_date),
      filteredCountryEligibility: num(byName.filtered_country_eligibility),
    });
  }
  return rows;
}

/** Rows whose timestamp falls in [startIso, endIso] (inclusive), completed or failed alike. */
export function rowsInWindow(rows, startIso, endIso) {
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(start)) return [];
  return rows.filter((r) => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) && t >= start && t <= end;
  });
}

/** @param {ReturnType<typeof parseScanRunsTsv>} rows */
export function sumScanRunRows(rows) {
  const completed = rows.filter((r) => r.status === 'completed');
  const failed = rows.filter((r) => r.status !== 'completed');
  const sum = (key) => completed.reduce((acc, r) => acc + r[key], 0);
  return {
    rawJobs: sum('found'),
    freshnessRejects: sum('filteredPostedDate') + sum('filteredPostingAge'),
    duplicates: sum('dupes'),
    cheapFilterRejects: sum('filteredTitle') + sum('filteredTier') + sum('filteredLocation')
      + sum('filteredSalary') + sum('filteredContent') + sum('filteredCooldown')
      + sum('filteredBlacklist') + sum('filteredVisa') + sum('filteredCountryEligibility'),
    netNew: sum('newAdded'),
    failedRuns: failed.map((r) => ({ timestamp: r.timestamp, status: r.status })),
  };
}

// ── scan-history.tsv (candidate detail lookup) ──────────────────────

/** @param {string} text */
export function parseScanHistoryRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols[0] === 'url') continue; // header
    rows.push({
      url: cols[0] || '',
      firstSeen: cols[1] || '',
      portal: cols[2] || '',
      title: cols[3] || '',
      company: cols[4] || '',
      status: cols[5] || '',
      location: cols[6] || '',
    });
  }
  return rows;
}

/**
 * Resolve each URL to its most recently written scan-history row (last
 * occurrence wins — a URL re-seen across runs keeps growing new rows, and the
 * most recent one is this run's).
 *
 * @param {string} historyText
 * @param {string[]} urls
 */
export function resolveCandidates(historyText, urls) {
  const rows = parseScanHistoryRows(historyText);
  const byUrl = new Map();
  for (const row of rows) byUrl.set(row.url, row); // later rows overwrite earlier ones
  return urls.map((url) => {
    const row = byUrl.get(url);
    return row
      ? { url, company: row.company, title: row.title, location: row.location, source: row.portal }
      : { url, company: 'Unknown', title: 'Unknown', location: '', source: '', unresolved: true };
  });
}

// ── Classification (reuses location-tier.mjs as-is) ─────────────────

const BUCKET_LABEL = {
  primary: 'Primary (actionable)',
  'location-friction': 'Location friction',
  'needs-validation': 'Needs validation',
  excluded: 'Excluded (non-US)',
};

function whyFor(classified) {
  if (classified.bucket === 'excluded') return 'Non-US location — excluded from review';
  if (classified.remoteUS) return 'Remote (US) — actionable';
  if (classified.nycMetro) return 'NYC metro — actionable';
  if (classified.bucket === 'location-friction') return 'Confirmed US location outside NYC metro — evaluate relocation/commute';
  return 'Location unclear from posting — verify manually';
}

/** @param {{url: string, title: string, location: string, company: string, source: string}} candidate */
export function classifyCandidate(candidate) {
  const classified = classifyLocation({
    location: candidate.location,
    title: candidate.title,
    urlHint: workdayUrlHint(candidate.url),
  });
  return {
    ...candidate,
    tier: classified.tier,
    bucket: classified.bucket,
    remoteUS: classified.remoteUS,
    nycMetro: classified.nycMetro,
    why: whyFor(classified),
  };
}

/** @param {ReturnType<typeof classifyCandidate>[]} candidates */
export function bucketCandidates(candidates) {
  const pass = candidates.filter((c) => c.bucket === 'primary');
  const marginal = candidates.filter((c) => c.bucket === 'location-friction' || c.bucket === 'needs-validation');
  const excluded = candidates.filter((c) => c.bucket === 'excluded');
  return { pass, marginal, excluded };
}

// ── Markdown rendering ───────────────────────────────────────────────

function escapeCell(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

function renderCandidateTable(rows) {
  if (rows.length === 0) return '_None this run._\n';
  const header = '| Company | Role | Direct Link | Structured Location | Location Tier | Fit | Why |\n'
    + '|---|---|---|---|---|---|---|\n';
  const body = rows.map((r) => {
    const link = r.url.startsWith('local:') ? escapeCell(r.url) : `[Apply](${r.url})`;
    const tierLabel = `Tier ${r.tier} — ${BUCKET_LABEL[r.bucket] || r.bucket}`;
    return `| ${escapeCell(r.company)} | ${escapeCell(r.title)} | ${link} | ${escapeCell(r.location) || '—'} | ${tierLabel} | ${escapeCell(r.source) || '—'} | ${escapeCell(r.why)} |`;
  }).join('\n');
  return header + body + '\n';
}

/**
 * Pure rendering from an already-assembled model. No file IO.
 * @param {object} model
 */
export function renderReport(model) {
  const {
    kind, date, runStartedAt, runFinishedAt, sinceDays, modelUsed,
    funnel, pass, marginal, excludedCount, notes, cohort, generatedAt,
  } = model;

  const lines = [];
  lines.push(`# Discovery Report — ${KIND_LABELS[kind] || kind} — ${date}`, '');

  lines.push('## 1. Run Metadata', '');
  lines.push(`- Kind: ${KIND_LABELS[kind] || kind}`);
  lines.push(`- Date: ${date}`);
  lines.push(`- Run window: ${runStartedAt || '—'} → ${runFinishedAt || '—'}`);
  if (sinceDays != null) lines.push(`- Freshness window (--since): ${sinceDays} day(s)`);
  if (modelUsed) lines.push(`- Model used for WebSearch/Playwright handoff: ${modelUsed}`);
  lines.push(`- Generated: ${generatedAt}`, '');

  lines.push('## 2. Run Summary', '');
  lines.push('| Stage | Count |', '|---|---|');
  lines.push(`| Raw jobs found | ${funnel.rawJobs} |`);
  lines.push(`| Freshness rejects | ${funnel.freshnessRejects} |`);
  lines.push(`| Duplicates | ${funnel.duplicates} |`);
  lines.push(`| Cheap-filter rejects | ${funnel.cheapFilterRejects} |`);
  lines.push(`| Genuinely net-new | ${funnel.netNew} |`);
  lines.push(`| Plausible (location-eligible) | ${pass.length + marginal.length} |`);
  lines.push(`| PASS (review first) | ${pass.length} |`, '');

  lines.push('## 3. PASS / Review First', '');
  lines.push(renderCandidateTable(pass));

  lines.push('## 4. MARGINAL / Quick Look', '');
  lines.push(renderCandidateTable(marginal));

  lines.push('## 5. Run Notes', '');
  const allNotes = [...notes];
  if (excludedCount > 0) allNotes.push(`${excludedCount} net-new posting(s) excluded from review as non-US/noise (not listed above).`);
  lines.push(allNotes.length > 0 ? allNotes.map((n) => `- ${n}`).join('\n') : '_None._', '');

  if (kind === 'top100' && cohort) {
    lines.push('## 6. Top-100 Employer Coverage', '');
    lines.push(`- Provider-backed, completed: ${cohort.providerBacked.length}`);
    if (cohort.providerBacked.length > 0) lines.push(`  ${cohort.providerBacked.join(', ')}`);
    lines.push(`- WebSearch/Playwright handoff, completed: ${cohort.handoffAttempted.length}`);
    if (cohort.handoffAttempted.length > 0) lines.push(`  ${cohort.handoffAttempted.join(', ')}`);
    lines.push(`- Blocked / unresolved: ${cohort.blockedUnresolved.length}`);
    for (const b of cohort.blockedUnresolved) lines.push(`  - ${b.name}${b.reason ? ` — ${b.reason}` : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Orchestration (reads the live data root) ─────────────────────────

function aggregateReceiptErrors(receipts) {
  const notes = [];
  for (const r of receipts || []) {
    for (const e of r.errors || []) notes.push(`Provider error: ${e.company} — ${e.error}`);
  }
  return notes;
}

/**
 * @param {object} payload — see the module header for the full shape.
 */
export function buildReport(payload) {
  const kind = payload.kind;
  if (kind !== 'linkedin' && kind !== 'top100') {
    throw new Error(`payload.kind must be "linkedin" or "top100", got ${JSON.stringify(kind)}`);
  }
  if (!payload.runStartedAt) throw new Error('payload.runStartedAt is required');

  const date = payload.date || localToday();
  const runsText = existsSync(SCAN_RUNS_PATH) ? readFileSync(SCAN_RUNS_PATH, 'utf-8') : '';
  const windowRows = rowsInWindow(parseScanRunsTsv(runsText), payload.runStartedAt, payload.runFinishedAt);
  const funnel = sumScanRunRows(windowRows);

  const handoff = payload.handoff || null;
  if (handoff) {
    funnel.netNew += handoff.added || 0;
    funnel.duplicates += (handoff.skipped_duplicate || []).length;
  }

  const receipts = payload.receipts || [];
  const urls = Array.from(new Set([
    ...receipts.flatMap((r) => r.added_urls || []),
    ...(handoff?.added_urls || []),
  ]));

  const historyText = existsSync(SCAN_HISTORY_PATH) ? readFileSync(SCAN_HISTORY_PATH, 'utf-8') : '';
  const candidates = resolveCandidates(historyText, urls).map(classifyCandidate);
  const { pass, marginal, excluded } = bucketCandidates(candidates);

  const notes = [
    ...(payload.notes || []),
    ...aggregateReceiptErrors(receipts),
    ...funnel.failedRuns.map((f) => `Run marked failed at ${f.timestamp}.`),
  ];
  if (handoff && (handoff.skipped_invalid || []).length > 0) {
    notes.push(`${handoff.skipped_invalid.length} handoff candidate(s) rejected as malformed before write.`);
  }

  const model = {
    kind,
    date,
    runStartedAt: payload.runStartedAt,
    runFinishedAt: payload.runFinishedAt || new Date().toISOString(),
    sinceDays: payload.sinceDays ?? null,
    modelUsed: payload.model || null,
    funnel,
    pass,
    marginal,
    excludedCount: excluded.length,
    notes,
    cohort: kind === 'top100' ? {
      providerBacked: payload.cohort?.providerBacked || [],
      handoffAttempted: payload.cohort?.handoffAttempted || [],
      blockedUnresolved: payload.cohort?.blockedUnresolved || [],
    } : null,
    generatedAt: new Date().toISOString(),
  };

  return { markdown: renderReport(model), model, outPath: join(REPORTS_DIR, `${date}_${kind}.md`) };
}

// ── CLI ───────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--payload', '--out', '--json', '--help', '-h'];
const VALUE_FLAGS = ['--payload', '--out'];
const USAGE = `Usage:
  node discovery-report.mjs --payload run.json [--out <path>] [--json]

Renders the human review Markdown report for a scheduled discovery run to
{DATA_ROOT}/reports/discovery/{date}_{kind}.md (or --out, if given).
See this file's header comment for the full payload shape.`;

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const payloadPath = flagValue(args, '--payload');
  if (!payloadPath) {
    console.error(`Error: --payload <file> is required\n\n${USAGE}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(stripBom(readFileSync(payloadPath, 'utf-8')));
  } catch (err) {
    console.error(`Error: could not read/parse ${payloadPath}: ${err.message}`);
    process.exit(1);
  }

  try {
    const { markdown, outPath } = buildReport(payload);
    const finalPath = flagValue(args, '--out') || outPath;
    mkdirSync(join(finalPath, '..'), { recursive: true });
    writeFileSync(finalPath, markdown, 'utf-8');
    if (args.includes('--json')) {
      console.log(JSON.stringify({ version: 'careerops.discovery-report@1', path: finalPath }));
    } else {
      console.log(`Wrote ${finalPath}`);
    }
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
}
