#!/usr/bin/env node
// export-shortlist.mjs — CSV shortlist export, the last step of the normal
// career-ops workflow (scan → pipeline/oferta evaluation → export).
//
// No existing exporter covered this (checked first, #csv-export-2026-09-07):
//   - tracker.mjs's `export` command is markdown -> markdown (the inverse of
//     `sync`, a repaired copy of applications.md) — never CSV.
//   - linkedin-join.mjs's `--tsv` and contacts.mjs's `--vcf` export a
//     DIFFERENT domain (LinkedIn connections, the phonebook) — unrelated.
//   - No script anywhere writes a `.csv` file for evaluated opportunities.
// What DOES already exist and is reused here rather than reinvented:
//   - tracker-parse.mjs's resolveColumns()/parseTrackerRow() — the same
//     column-name-driven parser applications.md's own writers use.
//   - The `## Machine Summary` YAML-fence-after-heading shape (batch-prompt.md
//     "Machine Summary" section is its source of truth) and the containment-
//     checked report-path resolution pattern merge-tracker.mjs's
//     resolveReportUrl() already established — mirrored here via the shared
//     pathIsInsideCanonical() helper instead of a new safety check.
//
// Honest gap (do not paper over it): `search_family` and `geography_tier`
// are NOT fields in the existing Machine Summary schema (batch-prompt.md) —
// no career-ops mode persists them anywhere today. Rather than inventing a
// schema change (out of scope — "do not alter scoring/dedup/geography
// behavior"), this script leaves those two columns blank when no source
// exists, exactly as batch-prompt.md's own Machine Summary rule requires for
// itself ("Do not invent missing data"). If a mode starts persisting them
// later, this exporter picks them up for free — see the two TODO markers.
//
// Source of truth: data/applications.md (evaluated opportunities only — a
// raw pipeline.md discovery is never in this file, so "after scoring" holds
// by construction). Each row is enriched, when its linked report exists,
// from that report's Machine Summary. A row with no report still exports,
// scored/verdicted from the tracker's own Score cell alone (see
// scoreToVerdict()) — most real trackers have rows older than the Machine
// Summary convention, and an exporter that silently dropped them would be a
// surprise, not a feature.
//
// Run:
//   node export-shortlist.mjs                 # write exports/careerops-shortlist-{today}.csv
//   node export-shortlist.mjs --include-c      # also include C-verdict rows (D is never included)
//   node export-shortlist.mjs --dry-run         # print the CSV to stdout, write nothing
//   node export-shortlist.mjs --out <path>       # override the output path (still CSV)
//   node export-shortlist.mjs --help

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolveWorkspaceRoot, writeFileAtomic, pathIsInsideCanonical } from './tracker-utils.mjs';
import { localToday } from './lib/local-today.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const APPS_FILE = resolveTrackerPath(ROOT);
const REPORTS_ROOT = resolveWorkspaceRoot(APPS_FILE);
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');

const KNOWN_FLAGS = ['--include-c', '--dry-run', '--out', '--help', '-h'];
const USAGE = `Usage: node export-shortlist.mjs [--include-c] [--dry-run] [--out <path>]

Exports the evaluated-opportunity shortlist (data/applications.md, enriched
from each row's linked report) to exports/careerops-shortlist-{YYYY-MM-DD}.csv.

  --include-c   Also include C-verdict (relevant but not actionable) rows.
                D-verdict rows are never included.
  --dry-run     Print the CSV to stdout; write nothing.
  --out <path>  Write to this path instead of the default exports/ location.
  --help, -h    Show this message.`;

// --- Machine Summary extraction (mirrors salary-gap.mjs's FENCE_RE shape) --

const URL_HEADER_RE = /\*\*URL:\*\*[ \t]*(\S+)/;
const FENCE_RE = /##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i;

/** Parse one report's Machine Summary fence. Never throws — a malformed or
 * absent fence yields {} so the caller falls back to tracker-only fields. */
function readMachineSummary(reportText) {
  const m = String(reportText || '').match(FENCE_RE);
  if (!m) return {};
  try {
    const parsed = yaml.load(m[1]);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** `[42](reports/042-acme.md)` -> absolute path, or null. Same containment
 * discipline as merge-tracker.mjs's resolveReportUrl(): resolve against the
 * workspace root and require the result stay inside it before ever reading
 * it — the tracker's Report cell is user-editable text, not a trusted path. */
function resolveReportPath(reportField) {
  const m = String(reportField || '').match(/\]\(([^)]+)\)/);
  if (!m) return null;
  const candidate = resolve(REPORTS_ROOT, m[1].trim().replace(/^(\.\.\/)+/, ''));
  if (!pathIsInsideCanonical(candidate, REPORTS_ROOT)) return null;
  return existsSync(candidate) ? candidate : null;
}

// final_decision (batch-prompt.md's existing 4-value taxonomy) -> the A/B/C/D
// shortlist verdict this export uses. Not a new taxonomy grafted onto the
// schema — just a display mapping of the field that already exists.
const DECISION_TO_VERDICT = {
  apply: 'A',
  consider: 'B',
  'research first': 'C',
  skip: 'D',
};

/** Score-only fallback for a row with no report (or no Machine Summary) to
 * read a final_decision from. Thresholds match modes/triage.md's own PASS
 * (>=3.5) / MARGINAL (3.0-3.4) / FAIL (<3.0) bands, with PASS split at 4.0
 * so "A" means genuinely strong, not merely over the triage bar. */
function scoreToVerdict(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 4.0) return 'A';
  if (score >= 3.5) return 'B';
  if (score >= 3.0) return 'C';
  return 'D';
}

function parseScoreCell(raw) {
  const m = String(raw || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return m ? parseFloat(m[1]) : NaN;
}

function hostnameOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function deriveSource(url) {
  const host = hostnameOf(url);
  if (!host) return '';
  if (host.includes('linkedin.com')) return 'LinkedIn';
  return host;
}

/** Best-effort location recovery: applications.md rarely has its own
 * Location column, but the pipeline.md line a promoted row came from
 * usually still does, in its Processed section, keyed by the same URL. */
function findPipelineLocation(url, pipelineText) {
  if (!url || !pipelineText) return '';
  for (const line of pipelineText.split('\n')) {
    if (!line.includes(url)) continue;
    const cells = line.split('|').map(s => s.trim()).filter(Boolean);
    // `- [x] {url} | Company | Role | Location | posted: ...` — location is
    // whichever cell after Role isn't a `posted:`/`note:`/`rank:` tag.
    for (let i = 3; i < cells.length; i++) {
      if (!/^(posted|note|rank):/i.test(cells[i])) return cells[i];
    }
  }
  return '';
}

// --- CSV writing (RFC 4180: quote on comma/quote/CR/LF, double inner quotes) --

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(',');
}

const COLUMNS = [
  'date_seen', 'company', 'role', 'score', 'verdict', 'geography_tier',
  'location', 'compensation', 'search_family', 'source', 'url',
  'why_it_matters', 'hard_gap', 'status',
];

export function buildShortlistRows({ appsText, pipelineText, includeC }) {
  const lines = appsText.split('\n');
  const colmap = resolveColumns(lines);
  const rows = [];

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;

    const reportPath = resolveReportPath(row.report);
    const reportText = reportPath ? readFileSync(reportPath, 'utf-8') : '';
    const ms = readMachineSummary(reportText);

    const trackerScore = parseScoreCell(row.score);
    const score = Number.isFinite(ms.score) ? ms.score : trackerScore;
    const decision = typeof ms.final_decision === 'string' ? ms.final_decision.trim().toLowerCase() : null;
    const verdict = (decision && DECISION_TO_VERDICT[decision]) || scoreToVerdict(score);
    if (!verdict || verdict === 'D') continue;
    if (verdict === 'C' && !includeC) continue;

    const urlHeaderMatch = reportText.match(URL_HEADER_RE);
    const url = urlHeaderMatch ? urlHeaderMatch[1].replace(/^<|>$/, '').replace(/[),.;]+$/, '') : '';

    const hardGap = Array.isArray(ms.hard_stops) ? ms.hard_stops.filter(Boolean).join('; ') : '';
    const whyItMatters = Array.isArray(ms.top_strengths) ? ms.top_strengths.filter(Boolean).join('; ') : '';
    const compensation = ms.advertised_comp != null ? String(ms.advertised_comp) : '';
    const location = row.location || findPipelineLocation(url, pipelineText) || '';

    rows.push({
      date_seen: row.date || '',
      company: (ms.company || row.company || '').trim(),
      role: (ms.role || row.role || '').trim(),
      score: Number.isFinite(score) ? score.toFixed(1) : '',
      verdict,
      // TODO: populate once a mode persists a geography tier in the Machine
      // Summary — no such field exists today (batch-prompt.md's schema has
      // no geography_tier key), so this stays blank rather than guessed.
      geography_tier: '',
      location,
      compensation,
      // TODO: populate once a mode/scan-history persists which search
      // family (portals.yml entry name) sourced this opportunity — not
      // currently carried past ingestion into applications.md or reports/.
      search_family: '',
      source: deriveSource(url),
      url,
      why_it_matters: whyItMatters,
      hard_gap: hardGap,
      status: row.status || '',
      _sortScore: Number.isFinite(score) ? score : -1,
    });
  }

  // Highest score first; ties broken by verdict (A before B before C) then company.
  rows.sort((a, b) => b._sortScore - a._sortScore
    || a.verdict.localeCompare(b.verdict)
    || a.company.localeCompare(b.company));
  for (const r of rows) delete r._sortScore;
  return rows;
}

export function rowsToCsv(rows) {
  const lines = [toCsvRow(COLUMNS)];
  for (const r of rows) lines.push(toCsvRow(COLUMNS.map(c => r[c])));
  return lines.join('\r\n') + '\r\n'; // CRLF: matches contacts.mjs's vCard convention, opens cleanly in Excel
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--out'] });
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) { console.log(USAGE); return; }

  const includeC = hasFlag(args, '--include-c');
  const dryRun = hasFlag(args, '--dry-run');
  const outOverride = flagValue(args, '--out');

  if (!existsSync(APPS_FILE)) {
    console.error(`No tracker found at ${APPS_FILE} — nothing to export yet.`);
    process.exitCode = 1;
    return;
  }
  const appsText = readFileSync(APPS_FILE, 'utf-8');
  const pipelineText = existsSync(PIPELINE_PATH) ? readFileSync(PIPELINE_PATH, 'utf-8') : '';

  const rows = buildShortlistRows({ appsText, pipelineText, includeC });
  const csv = rowsToCsv(rows);

  if (dryRun) {
    process.stdout.write(csv);
    console.error(`\n(dry run — ${rows.length} row(s), nothing written)`);
    return;
  }

  const outPath = outOverride || join(ROOT, 'exports', `careerops-shortlist-${localToday()}.csv`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileAtomic(outPath, csv);
  console.log(`✅ Exported ${rows.length} shortlist row(s) (verdict A/B${includeC ? '/C' : ''}) to ${outPath}`);
  if (rows.length === 0) {
    console.log('   (0 rows: data/applications.md has no A/B-verdict evaluated opportunities yet.)');
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
