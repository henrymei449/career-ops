#!/usr/bin/env node
/**
 * startup-watch.mjs — Startup Target watchlist renderer for career-ops.
 *
 * FORK-LOCAL. Declared in config/local-paths.txt; not shipped by upstream and
 * not covered by SYSTEM_PATHS. Declare it there so the updater's safety check
 * and validate-system-paths-coverage.mjs both know it belongs to this clone.
 *
 * READ-ONLY and OFFLINE. Never writes a file, never opens a socket. v1 has no
 * --refresh, no scraping, no scheduled monitoring and no trigger polling: every
 * external fact it shows was put into data/startup-signals.tsv by a human, with
 * a date and a source URL.
 *
 * It stores no job records. Company state lives in data/startup-targets.md;
 * everything about postings is DERIVED at read time by joining on the company
 * key, the same way company-history.mjs joins the tracker, follow-ups and
 * scan-history without owning any of them.
 *
 * Sources (each optional; a missing file degrades to a blank column, never a
 * crash):
 *   - targets:      data/startup-targets.md      (company state — this lane)
 *   - signals:      data/startup-signals.tsv     (dated evidence — this lane)
 *   - boards:       portals.yml tracked_companies (is the company monitored?)
 *   - openings:     data/scan-history.tsv        (postings seen by scan.mjs)
 *   - openings:     data/pipeline.md             (unprocessed URL inbox)
 *   - coverage:     data/portal-health.tsv       (was the board actually
 *                                                  checked successfully?)
 *
 * "none seen" vs "unmonitored" (V1.1, #startup-watch-coverage): a company is
 * rendered "none seen" ONLY when data/portal-health.tsv has a 'reachable' or
 * 'empty' record for it inside the window — i.e. scan.mjs actually resolved a
 * provider and completed a real check (appendPortalHealth() in scan.mjs is
 * called only for entries that made it into its `targets` list; a
 * scan_method:'websearch' entry with no matching provider, like Datanomix,
 * never enters that list and so never gets a health record at all). Absence of
 * postings is NEVER inferred from absence of a check — a company with zero
 * openings but NO successful health record renders "unmonitored", the same as
 * a company with no board configured at all. A found opening (scan-history or
 * pipeline) always wins regardless of coverage: a real posting is its own
 * proof the board works, even if the health record has aged out of the window.
 *
 * Opening COUNT dedups scan-history and pipeline hits by canonical job
 * identity (url-key.mjs normalizeUrl()) rather than summing source-record
 * counts: scan.mjs writes a newly-added posting to BOTH data/scan-history.tsv
 * and data/pipeline.md at once, so summing double-counts every posting still
 * sitting unprocessed in the pipeline inbox. A URL that fails to normalize
 * (normalizeUrl returns '', e.g. a `local:jds/...` reference) is NOT treated
 * as one shared "no key" bucket — url-key.mjs's own "NO KEY IS NOT A KEY" rule
 * — it falls back to raw-string identity instead, so two different
 * unparseable references never collapse into each other.
 *
 * Company identity reuses the EXISTING career-ops helpers rather than inventing
 * a lane-specific one:
 *   - normalizeCompanyName() (invite-match.mjs) — the key scan.mjs stores in
 *     scan-history.tsv column 12 and the key companyKey() clusters on. This is
 *     the canonical company_key for this lane.
 *   - normalizeCompany() (tracker-utils.mjs) — the tracker-side key. Kept as a
 *     SECOND equivalence class because the two normalizers disagree in useful
 *     ways: "Landing AI"/"LandingAI" collide under normalizeCompany but not
 *     under normalizeCompanyName. A record matches a target when EITHER key
 *     agrees.
 *
 * Run: node startup-watch.mjs                    (rendered watchlist)
 *      node startup-watch.mjs --stance attack    (filter by stance)
 *      node startup-watch.mjs --window 90        (opening-evidence window, days)
 *      node startup-watch.mjs --json             (machine-readable)
 *      node startup-watch.mjs --self-test
 */

import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'js-yaml';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { parseScanHistory, companyKey } from './detect-reposts.mjs';
import { loadPortalHealth } from './scan.mjs';
import { normalizeUrl } from './url-key.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags, flagValue } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';

const DATA_ROOT = getCareerOpsRoot();

export const TARGETS_PATH = process.env.CAREER_OPS_STARTUP_TARGETS || join(DATA_ROOT, 'data', 'startup-targets.md');
export const SIGNALS_PATH = process.env.CAREER_OPS_STARTUP_SIGNALS || join(DATA_ROOT, 'data', 'startup-signals.tsv');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');
const SCAN_HISTORY_PATH = join(DATA_ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || join(DATA_ROOT, 'data', 'pipeline.md');
const PORTAL_HEALTH_PATH = join(DATA_ROOT, 'data', 'portal-health.tsv');

// scan.mjs statuses that mean "the board actually answered" — appendPortalHealth()
// (scan.mjs) records 'empty' when the board answered with zero total postings,
// which is still a completed check, not a coverage gap. Every other status
// (slug_gone, network, auth, server, unknown) is a failed attempt, and a
// skipped/unresolved entry (e.g. scan_method:'websearch' with no provider
// match) gets no record at all — both must read as "no coverage", never as
// "checked, zero found".
const SUCCESSFUL_HEALTH_STATUSES = new Set(['reachable', 'empty']);

export const STANCES = ['attack', 'build', 'watch'];
export const SIGNAL_TYPES = [
  'funding', 'customer', 'us-expansion', 'gtm-hire',
  'leadership', 'product', 'role', 'partnership',
];
export const RECOMMENDATIONS = ['apply', 'research', 'outreach', 'monitor', 'ignore'];

const DEFAULT_WINDOW_DAYS = 60;

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Every key spelling a record may be found under. Both existing normalizers,
 * plus the raw lowercased name as a last resort for names that fold to empty
 * (all-CJK, all-Cyrillic) — the same fallback companyKey() uses.
 *
 * @param {string} name - A company name in any spelling.
 * @returns {Set<string>} Non-empty keys.
 */
export function identityKeys(name) {
  const raw = String(name ?? '').trim();
  const keys = new Set();
  for (const k of [normalizeCompanyName(raw), normalizeCompany(raw), raw.toLowerCase()]) {
    if (k) keys.add(k);
  }
  return keys;
}

/** True when two names denote the same company under either existing normalizer. */
export function sameCompany(a, b) {
  const ka = identityKeys(a);
  for (const k of identityKeys(b)) if (ka.has(k)) return true;
  return false;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse data/startup-targets.md — a markdown table of company STATE.
 * Prose above and below the table is ignored; only pipe rows are read.
 *
 * TWO SHAPES are accepted, distinguished by column count:
 *   10 cells — Company | Aliases | Stance | ... (current)
 *    9 cells — Company | Stance | ...           (pre-alias, legacy)
 * A clone that has not taken the alias change still loads, with no aliases,
 * rather than silently producing zero targets — the failure mode that would
 * make the whole watchlist read "(no startup targets)" after a partial sync.
 *
 * @param {string} content - File content.
 * @returns {Array<object>} Target rows.
 */
export function parseTargets(content) {
  const targets = [];
  for (const line of String(content ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Separator row (|---|---|) and the header row carry no data.
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue;
    const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    if (cells.length < 9) continue;
    const hasAliases = cells.length >= 10;
    const company = cells[0];
    const aliasCell = hasAliases ? cells[1] : '';
    const [stance, stage, wedge, usSignal, roleFamily, checked, nextAction, notes] = cells.slice(hasAliases ? 2 : 1);
    if (!company || company.toLowerCase() === 'company') continue;

    // Semicolon-separated. Comma is deliberately NOT a separator: "Fero Labs,
    // Inc." is one name, and splitting it would register "Inc." as an alias
    // that matches every company whose name folds to that key.
    const aliases = aliasCell.split(';').map((a) => a.trim()).filter(Boolean);

    // The record's identity is the union of its canonical name and every
    // explicit alias, each run through BOTH existing normalizers. Aliases add
    // keys to one record; they never create a record.
    const keys = identityKeys(company);
    for (const alias of aliases) for (const k of identityKeys(alias)) keys.add(k);

    targets.push({
      company,
      aliases,
      stance: stance.toLowerCase(),
      stage: stage || 'unknown',
      wedge,
      usSignal,
      roleFamily,
      checked: checked && checked !== '-' ? checked : '',
      nextAction,
      notes,
      keys,
    });
  }
  return targets;
}

/**
 * Parse data/startup-signals.tsv — append-only dated evidence.
 * Rows with an out-of-vocabulary signal_type or recommendation are KEPT and
 * flagged rather than dropped: a typo should be visible, not silently absent.
 *
 * @param {string} content - File content.
 * @returns {Array<object>} Signal rows, each with a `problems` array.
 */
export function parseSignals(content) {
  const rows = [];
  const lines = String(content ?? '').split('\n').filter((l) => l.trim());
  const hasHeader = /^\s*date\s*\t/i.test(lines[0] || '');
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    const [date, key, type, summary, sourceUrl, recommendation] = cols.map((c) => (c ?? '').trim());
    const problems = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push('bad date');
    if (!SIGNAL_TYPES.includes(type)) problems.push(`unknown signal_type "${type}"`);
    if (!RECOMMENDATIONS.includes(recommendation)) problems.push(`unknown recommendation "${recommendation}"`);
    if (!/^https?:\/\//.test(sourceUrl)) problems.push('missing source_url');
    rows.push({ date, key, type, summary, sourceUrl, recommendation, problems });
  }
  return rows;
}

/**
 * Company names in portals.yml tracked_companies — "is this company being
 * monitored at all?". A malformed portals.yml is scan.mjs's problem to report,
 * not this script's problem to crash on.
 *
 * @param {string} portalsPath - Path to portals.yml.
 * @returns {Array<string>} Raw company names.
 */
export function loadTrackedCompanies(portalsPath = PORTALS_PATH) {
  try {
    if (!existsSync(portalsPath)) return [];
    const doc = yaml.load(readFileSync(portalsPath, 'utf-8'));
    const names = [];
    for (const entries of [doc?.tracked_companies, doc?.job_boards]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const raw = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (raw) names.push(raw);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Pending entries from data/pipeline.md. Same contract archive-posting.mjs
 * reads: `- [ ] URL | Company | Role`, company optional.
 *
 * @param {string} content - File content.
 * @returns {Array<{url: string, company: string|null}>}
 */
export function parsePipelinePending(content) {
  const entries = [];
  for (const line of String(content ?? '').split('\n')) {
    if (!line.startsWith('- [ ]')) continue;
    const urlMatch = line.match(/https?:\/\/[^\s|)]+/);
    if (!urlMatch) continue;
    const parts = line.split('|').map((s) => s.trim());
    entries.push({ url: urlMatch[0], company: parts[1] || null });
  }
  return entries;
}

// ── Join ─────────────────────────────────────────────────────────────────────

function daysBetween(fromISO, toISO) {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

function matches(target, name) {
  for (const k of identityKeys(name)) if (target.keys.has(k)) return true;
  return false;
}

/**
 * Stable job-identity key for dedup: canonical URL when normalizeUrl() can
 * parse it, otherwise the raw trimmed string. Falling back to '' (rather than
 * a raw-string key) would violate url-key.mjs's own "NO KEY IS NOT A KEY"
 * rule — every unparseable reference (e.g. a `local:jds/...` capture) would
 * collapse onto the same empty key and be miscounted as one shared posting.
 * The raw string is unique per reference, so two DIFFERENT unparseable
 * references still count as two, while the same reference appearing in both
 * scan-history and pipeline (the double-count case this exists to fix)
 * correctly collapses to one.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function jobIdentity(rawUrl) {
  const canonical = normalizeUrl(rawUrl);
  return canonical || `raw:${String(rawUrl ?? '').trim()}`;
}

/**
 * Count of DISTINCT openings across scan-history and pipeline candidate URLs,
 * deduped by jobIdentity(). Two genuinely different postings (different
 * canonical URLs) are never collapsed just because they share a company or
 * title — only a matching identity merges.
 *
 * @param {Array<string>} urls
 * @returns {number}
 */
function countDistinctOpenings(urls) {
  return new Set(urls.map(jobIdentity)).size;
}

/**
 * Build the rendered watchlist. Pure: every input is passed in, nothing is read
 * from disk here, so --self-test exercises the real join.
 *
 * @param {object} input
 * @param {Array<object>} input.targets - parseTargets() output.
 * @param {Array<object>} input.signals - parseSignals() output.
 * @param {Array<string>} input.trackedCompanies - loadTrackedCompanies() output.
 * @param {Array<object>} input.scanRows - parseScanHistory() output.
 * @param {Array<object>} input.pipelinePending - parsePipelinePending() output.
 * @param {Array<object>} input.portalHealth - loadPortalHealth() output (scan.mjs).
 * @param {string} input.today - YYYY-MM-DD.
 * @param {number} input.windowDays - Opening-evidence window.
 * @returns {Array<object>} One row per target, ready to render.
 */
export function buildWatchlist({
  targets = [],
  signals = [],
  trackedCompanies = [],
  scanRows = [],
  pipelinePending = [],
  portalHealth = [],
  today = localToday(),
  windowDays = DEFAULT_WINDOW_DAYS,
} = {}) {
  return targets.map((t) => {
    const monitored = trackedCompanies.some((name) => matches(t, name));

    // Opening evidence is DERIVED. No posting is copied into startup state.
    const scanHits = scanRows.filter((row) => {
      const stored = companyKey(row);
      if (!t.keys.has(stored) && !matches(t, row.company)) return false;
      return daysBetween(row.dateStr, today) <= windowDays;
    });
    const pipelineHits = pipelinePending.filter((e) => e.company && matches(t, e.company));
    // Deduped by canonical job identity — scan.mjs writes a new posting to
    // BOTH scan-history and pipeline at once, so a plain sum double-counts it.
    const openingCount = countDistinctOpenings([
      ...scanHits.map((r) => r.url),
      ...pipelineHits.map((e) => e.url),
    ]);

    // "Successfully checked" evidence (see module header): a portal-health
    // record for this company, within the window, with a status that means
    // the board actually answered. A skipped/unresolved/failed check leaves
    // no such record, and must never read as "checked, zero found".
    const hasSuccessfulCoverage = portalHealth.some((rec) => {
      if (!SUCCESSFUL_HEALTH_STATUSES.has(rec.status)) return false;
      if (!matches(t, rec.company)) return false;
      return daysBetween(String(rec.timestamp ?? '').slice(0, 10), today) <= windowDays;
    });

    let currentOpening;
    if (openingCount > 0) currentOpening = `yes (${openingCount})`;
    // A real posting is its own proof the board works, checked or not — so
    // this coverage check never overrides an actual opening above.
    else if (hasSuccessfulCoverage) currentOpening = 'none seen';
    // Absence of postings is not evidence when nothing successfully checked.
    else currentOpening = 'unmonitored';

    const mine = signals
      .filter((s) => matches(t, s.key))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const latest = mine[0];

    // Which alias (if any) actually did the matching — so a match is auditable
    // rather than something the reader has to take on trust.
    const matchedVia = new Set();
    for (const name of [...trackedCompanies, ...scanHits.map((r) => r.company), ...pipelineHits.map((e) => e.company)]) {
      if (!name || sameCompany(t.company, name)) continue;
      if (matches(t, name)) matchedVia.add(name);
    }

    return {
      company: t.company,
      aliases: t.aliases ?? [],
      matchedVia: [...matchedVia],
      stance: t.stance,
      stage: t.stage,
      wedge: t.wedge,
      usSignal: t.usSignal,
      roleFamily: t.roleFamily,
      currentOpening,
      lastSignal: latest ? `${latest.date} ${latest.type}` : '-',
      lastChecked: t.checked || '-',
      nextAction: t.nextAction,
      monitored,
      signalCount: mine.length,
      latestSignal: latest || null,
    };
  });
}

// ── Render ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  ['Company', 'company'],
  ['Stance', 'stance'],
  ['Stage', 'stage'],
  ['Product Wedge', 'wedge'],
  ['US Signal', 'usSignal'],
  ['Relevant Role Family', 'roleFamily'],
  ['Current Opening?', 'currentOpening'],
  ['Last Meaningful Signal', 'lastSignal'],
  ['Last Checked', 'lastChecked'],
  ['Next Action', 'nextAction'],
];

/**
 * Render rows as an aligned pipe table.
 *
 * @param {Array<object>} rows - buildWatchlist() output.
 * @param {number} [truncate] - Max cell width; 0 disables truncation.
 * @returns {string}
 */
export function renderTable(rows, truncate = 34) {
  if (rows.length === 0) return '(no startup targets)';
  const clip = (s) => {
    const v = String(s ?? '');
    if (!truncate || v.length <= truncate) return v;
    return `${v.slice(0, truncate - 1)}…`;
  };
  const header = COLUMNS.map(([label]) => label);
  const body = rows.map((r) => COLUMNS.map(([, field]) => clip(r[field])));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  const rule = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;
  return [line(header), rule, ...body.map(line)].join('\n');
}

// ── Disk ─────────────────────────────────────────────────────────────────────

function readOrEmpty(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

/**
 * Load every source from disk and build the watchlist. Offline by construction.
 *
 * @param {{windowDays?: number, today?: string}} [opts]
 * @returns {{rows: Array<object>, signals: Array<object>, missing: Array<string>}}
 */
export function loadWatchlist({ windowDays = DEFAULT_WINDOW_DAYS, today = localToday() } = {}) {
  const missing = [];
  for (const [label, path] of [
    ['data/startup-targets.md', TARGETS_PATH],
    ['data/startup-signals.tsv', SIGNALS_PATH],
    ['portals.yml', PORTALS_PATH],
    ['data/scan-history.tsv', SCAN_HISTORY_PATH],
    ['data/pipeline.md', PIPELINE_PATH],
    ['data/portal-health.tsv', PORTAL_HEALTH_PATH],
  ]) {
    if (!existsSync(path)) missing.push(label);
  }

  const targets = parseTargets(readOrEmpty(TARGETS_PATH));
  const signals = parseSignals(readOrEmpty(SIGNALS_PATH));
  const trackedCompanies = loadTrackedCompanies(PORTALS_PATH);
  const scanRows = parseScanHistory(readOrEmpty(SCAN_HISTORY_PATH));
  const pipelinePending = parsePipelinePending(readOrEmpty(PIPELINE_PATH));
  // loadPortalHealth() (scan.mjs) already degrades a missing file to [];
  // wrapped defensively so an unreadable-but-present file can't crash the
  // renderer either, matching every other source in this function.
  let portalHealth = [];
  try { portalHealth = loadPortalHealth(PORTAL_HEALTH_PATH); } catch { /* degrade to [] */ }

  const rows = buildWatchlist({
    targets, signals, trackedCompanies, scanRows, pipelinePending, portalHealth, today, windowDays,
  });
  return { rows, signals, missing };
}

// ── Self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond) => {
    if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}`); }
  };

  const targetsMd = [
    '| Company | Stance | Stage | Wedge | US Signal | Role Family | Checked | Next Action | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| Acme Labs | attack | series-a | widgets | us-hq | solutions-engineer | 2026-09-01 | Apply | n |',
    '| Beta Co | watch | unknown | gadgets | unknown | applications-engineer | - | Monitor | n |',
  ].join('\n');
  const targets = parseTargets(targetsMd);
  ok('parseTargets reads data rows only', targets.length === 2);
  ok('parseTargets keeps stance', targets[0].stance === 'attack');
  ok('parseTargets blanks a "-" checked cell', targets[1].checked === '');

  const signalsTsv = [
    'date\tcompany_key\tsignal_type\tsummary\tsource_url\trecommendation',
    '2026-09-09\tacme labs\tfunding\t$10M A\thttps://example.com/a\toutreach',
    '2026-01-02\tacme labs\tproduct\tlaunched\thttps://example.com/b\tresearch',
    '2026-02-02\tacme labs\tbogus\tbad row\tnot-a-url\tnope',
  ].join('\n');
  const signals = parseSignals(signalsTsv);
  ok('parseSignals skips the header', signals.length === 3);
  ok('parseSignals flags an unknown signal_type', signals[2].problems.some((p) => p.includes('signal_type')));
  ok('parseSignals flags a missing source_url', signals[2].problems.includes('missing source_url'));
  ok('parseSignals accepts a good row', signals[0].problems.length === 0);

  ok('identity: spacing variant matches', sameCompany('Landing AI', 'LandingAI'));
  ok('identity: legal suffix matches', sameCompany('Fero Labs, Inc.', 'Fero Labs'));
  ok('identity: distinct companies do not match', !sameCompany('Acme Labs', 'Beta Co'));

  const rows = buildWatchlist({
    targets,
    signals,
    trackedCompanies: ['Acme Labs'],
    scanRows: parseScanHistory('https://x/1\t2026-09-05\tgreenhouse\tSolutions Engineer\tAcme Labs\tadded\tRemote'),
    pipelinePending: parsePipelinePending('- [ ] https://x/2 | Beta Co | Applications Engineer'),
    today: '2026-09-10',
    windowDays: 60,
  });
  const acme = rows.find((r) => r.company === 'Acme Labs');
  const beta = rows.find((r) => r.company === 'Beta Co');
  ok('opening derived from scan-history', acme.currentOpening === 'yes (1)');
  ok('latest signal wins by date', acme.lastSignal === '2026-09-09 funding');
  ok('opening derived from pipeline', beta.currentOpening === 'yes (1)');
  ok('unmonitored company is not reported as "none"', beta.monitored === false);

  const stale = buildWatchlist({
    targets,
    trackedCompanies: ['Acme Labs'],
    scanRows: parseScanHistory('https://x/1\t2026-01-05\tgreenhouse\tSolutions Engineer\tAcme Labs\tadded\tRemote'),
    portalHealth: [{ timestamp: '2026-09-08T00:00:00.000Z', company: 'Acme Labs', status: 'reachable' }],
    today: '2026-09-10',
    windowDays: 60,
  });
  ok('out-of-window posting is not an opening', stale.find((r) => r.company === 'Acme Labs').currentOpening === 'none seen');

  const dir = mkdtempSync(join(tmpdir(), 'startup-watch-'));
  try {
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, 'tracked_companies:\n  - name: Acme Labs\n    careers_url: https://example.com\n');
    ok('portals.yml tracked_companies load', loadTrackedCompanies(portals).includes('Acme Labs'));
    writeFileSync(portals, 'tracked_companies: [oops\n');
    ok('malformed portals.yml degrades to empty', loadTrackedCompanies(portals).length === 0);
    ok('absent portals.yml degrades to empty', loadTrackedCompanies(join(dir, 'nope.yml')).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  ok('renderTable emits a header', renderTable(rows).startsWith('| Company'));
  ok('renderTable handles no targets', renderTable([]) === '(no startup targets)');

  // ── Alias resolution (Phase 1) ────────────────────────────────────────────
  const aliasMd = [
    '| Company | Aliases | Stance | Stage | Wedge | US Signal | Role Family | Checked | Next Action | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| Axion | Axion Ray | attack | series-b | quality | us-hq | solutions-architect | 2026-09-10 | Check | n |',
    '| Fero Labs |  | attack | unknown | process ML | unknown | solutions-engineer | - | Check | n |',
  ].join('\n');
  const aliasTargets = parseTargets(aliasMd);
  ok('parseTargets reads the Aliases cell', aliasTargets[0].aliases.length === 1 && aliasTargets[0].aliases[0] === 'Axion Ray');
  ok('empty Aliases cell yields no aliases', aliasTargets[1].aliases.length === 0);
  ok('alias key joins the record identity', aliasTargets[0].keys.has(normalizeCompanyName('Axion Ray')));
  ok('canonical key survives aliasing', aliasTargets[0].keys.has(normalizeCompanyName('Axion')));
  ok('an alias does not leak to another record', !aliasTargets[1].keys.has(normalizeCompanyName('Axion Ray')));

  // Comma must not split: "Fero Labs, Inc." is one name, not two aliases.
  const commaTargets = parseTargets([
    '| Acme | Fero Labs, Inc. | attack | unknown | w | u | r | - | n | n |',
  ].join('\n'));
  ok('comma is not an alias separator', commaTargets[0].aliases.length === 1);

  // Legacy 9-column file (a clone that has not taken the alias change).
  const legacy = parseTargets([
    '| Legacy Co | attack | unknown | wedge | us-hq | solutions-engineer | - | Check | notes |',
  ].join('\n'));
  ok('legacy 9-column row still loads', legacy.length === 1 && legacy[0].company === 'Legacy Co');
  ok('legacy row has no aliases', legacy[0].aliases.length === 0);
  ok('legacy row keeps its stance', legacy[0].stance === 'attack');

  // ── Phase 5 acceptance tests A-E ──────────────────────────────────────────
  const acceptMd = [
    '| Company | Aliases | Stance | Stage | Wedge | US Signal | Role Family | Checked | Next Action | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| Oden Technologies |  | attack | unknown | analytics | unknown | solutions-engineer | - | Check | n |',
    '| Tulip |  | attack | unknown | ops apps | unknown | solutions-engineer | - | Check | n |',
    '| SixSense |  | attack | unknown | defect AI | unknown | forward-deployed | - | Check | n |',
    '| Axion | Axion Ray | attack | series-b | quality | us-hq | solutions-architect | - | Check | n |',
  ].join('\n');
  const acceptTargets = parseTargets(acceptMd);
  const accept = buildWatchlist({
    targets: acceptTargets,
    signals: parseSignals('date\tcompany_key\tsignal_type\tsummary\tsource_url\trecommendation\n2025-12-15\taxion\tfunding\t$37M B\thttps://example.com/x\tresearch'),
    // Tulip and Oden have working boards; SixSense and Axion do not.
    trackedCompanies: ['Oden Technologies', 'Tulip'],
    scanRows: parseScanHistory([
      'https://ex/1\t2026-09-05\tgreenhouse\tSolutions Engineer\tOden Technologies\tadded\tRemote US',
      // TEST D: the posting carries the LEGAL name, the target the trading name.
      'https://ex/2\t2026-09-06\tgreenhouse\tForward Deployed Engineer\tAxion Ray\tadded\tNew York',
      // TEST E: an ordinary employer, in the same scan history.
      'https://ex/3\t2026-09-06\tworkday\tProcess Engineer\tSiemens\tadded\tMunich',
    ].join('\n')),
    // TEST B needs a real successful-check record for Tulip — without one,
    // V1.1's coverage rule (below) renders it "unmonitored", not "none seen".
    // SixSense/Axion deliberately have none: TEST C depends on that absence.
    portalHealth: [
      { timestamp: '2026-09-10T00:00:00.000Z', company: 'Oden Technologies', status: 'reachable' },
      { timestamp: '2026-09-10T00:00:00.000Z', company: 'Tulip', status: 'reachable' },
    ],
    today: '2026-09-10',
    windowDays: 60,
  });
  const byName = Object.fromEntries(accept.map((r) => [r.company, r]));

  ok('TEST A monitored + opening -> yes (N)', byName['Oden Technologies'].currentOpening === 'yes (1)');
  ok('TEST B monitored + no opening -> none seen', byName.Tulip.currentOpening === 'none seen');
  ok('TEST C no board -> unmonitored', byName.SixSense.currentOpening === 'unmonitored');
  ok('TEST C unmonitored is never rendered as none seen', byName.SixSense.currentOpening !== 'none seen');
  ok('TEST D "Axion Ray" posting resolves to Axion', byName.Axion.currentOpening === 'yes (1)');
  ok('TEST D the match is attributed to the alias', byName.Axion.matchedVia.includes('Axion Ray'));
  ok('TEST D no duplicate startup record created', accept.length === acceptTargets.length && acceptTargets.length === 4);
  ok('TEST D only one record claims the Axion Ray posting',
    accept.filter((r) => r.matchedVia.includes('Axion Ray')).length === 1);
  ok('TEST E Siemens creates no startup record', !accept.some((r) => r.company === 'Siemens'));
  ok('TEST E Siemens is not absorbed by any target',
    !accept.some((r) => r.matchedVia.some((n) => /siemens/i.test(n))));
  ok('TEST E an unrelated employer inflates no opening count',
    accept.reduce((n, r) => n + (r.currentOpening.startsWith('yes') ? 1 : 0), 0) === 2);

  // The lane stores no job records: nothing posting-shaped reaches company state.
  ok('no job fields land in startup state',
    acceptTargets.every((t) => !('url' in t) && !('title' in t) && !('jobs' in t)));

  // ── V1.1: coverage (none seen vs unmonitored) ─────────────────────────────
  const covMd = [
    '| Company | Aliases | Stance | Stage | Wedge | US Signal | Role Family | Checked | Next Action | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| Checked Co |  | attack | unknown | w | u | r | - | n | n |',
    '| Skipped Co |  | attack | unknown | w | u | r | - | n | n |',
    '| Failed Co |  | attack | unknown | w | u | r | - | n | n |',
    '| No Portal Co |  | attack | unknown | w | u | r | - | n | n |',
    '| Found Co |  | attack | unknown | w | u | r | - | n | n |',
  ].join('\n');
  const covTargets = parseTargets(covMd);
  const cov = buildWatchlist({
    targets: covTargets,
    scanRows: parseScanHistory('https://ex/found\t2026-09-05\tgreenhouse\tSolutions Engineer\tFound Co\tadded\tRemote'),
    portalHealth: [
      { timestamp: '2026-09-09T00:00:00.000Z', company: 'Checked Co', status: 'reachable' },
      // 'Skipped Co' — never entered scan.mjs's targets list (e.g. a
      // scan_method:'websearch' entry with no resolvable provider, like the
      // real Datanomix case): no record at all.
      { timestamp: '2026-09-09T00:00:00.000Z', company: 'Failed Co', status: 'network' },
      // 'No Portal Co' — no record either; same absence, different cause.
      { timestamp: '2026-09-09T00:00:00.000Z', company: 'Found Co', status: 'reachable' },
    ],
    today: '2026-09-10',
    windowDays: 60,
  });
  const covByName = Object.fromEntries(cov.map((r) => [r.company, r]));
  ok('coverage: successful scan + 0 openings -> none seen', covByName['Checked Co'].currentOpening === 'none seen');
  ok('coverage: skipped scan (no health record) + 0 openings -> unmonitored', covByName['Skipped Co'].currentOpening === 'unmonitored');
  ok('coverage: failed scan (error status) + 0 openings -> unmonitored', covByName['Failed Co'].currentOpening === 'unmonitored');
  ok('coverage: no portal at all + 0 openings -> unmonitored', covByName['No Portal Co'].currentOpening === 'unmonitored');
  ok('coverage: successful scan + relevant opening -> yes (1)', covByName['Found Co'].currentOpening === 'yes (1)');
  ok('coverage: a real opening is never demoted by missing health evidence',
    buildWatchlist({
      targets: parseTargets('| Unchecked Found Co |  | attack | unknown | w | u | r | - | n | n |'),
      scanRows: parseScanHistory('https://ex/uf\t2026-09-05\tgreenhouse\tSolutions Engineer\tUnchecked Found Co\tadded\tRemote'),
      today: '2026-09-10', windowDays: 60,
    })[0].currentOpening === 'yes (1)');

  // Datanomix's actual real-world shape: scan_method:'websearch' with no
  // resolvable provider means scan.mjs's appendPortalHealth() never fires for
  // it, so it must render "unmonitored", never "none seen".
  const datanomix = buildWatchlist({
    targets: parseTargets('| Datanomix |  | attack | unknown | w | u | r | - | n | n |'),
    trackedCompanies: ['Datanomix'], // configured, but scan.mjs could not resolve a provider
    today: '2026-09-10', windowDays: 60,
  })[0];
  ok('coverage: websearch-handoff-with-no-provider renders unmonitored, not none seen', datanomix.currentOpening === 'unmonitored');

  // ── V1.1: opening-count dedup ──────────────────────────────────────────────
  const dedupTargets = parseTargets('| Dup Co |  | attack | unknown | w | u | r | - | n | n |');
  const sameJobBothSources = buildWatchlist({
    targets: dedupTargets,
    scanRows: parseScanHistory('https://ex/dup1\t2026-09-05\tgreenhouse\tSolutions Engineer\tDup Co\tadded\tRemote'),
    pipelinePending: parsePipelinePending('- [ ] https://ex/dup1 | Dup Co | Solutions Engineer'),
    today: '2026-09-10', windowDays: 60,
  })[0];
  ok('dedup: same job in scan-history + pipeline -> yes (1), not yes (2)', sameJobBothSources.currentOpening === 'yes (1)');

  const twoDistinctJobs = buildWatchlist({
    targets: dedupTargets,
    scanRows: parseScanHistory([
      'https://ex/dup-a\t2026-09-05\tgreenhouse\tSolutions Engineer\tDup Co\tadded\tRemote',
      'https://ex/dup-b\t2026-09-06\tgreenhouse\tApplications Engineer\tDup Co\tadded\tRemote',
    ].join('\n')),
    today: '2026-09-10', windowDays: 60,
  })[0];
  ok('dedup: two different URLs for two distinct jobs -> yes (2)', twoDistinctJobs.currentOpening === 'yes (2)');

  const trackingParamVariant = buildWatchlist({
    targets: dedupTargets,
    scanRows: parseScanHistory('https://ex.com/jobs/1?utm_source=li\t2026-09-05\tgreenhouse\tSolutions Engineer\tDup Co\tadded\tRemote'),
    pipelinePending: parsePipelinePending('- [ ] https://ex.com/jobs/1 | Dup Co | Solutions Engineer'),
    today: '2026-09-10', windowDays: 60,
  })[0];
  ok('dedup: same canonical URL with tracking-param variation -> yes (1)', trackingParamVariant.currentOpening === 'yes (1)');

  // Two DIFFERENT postings must never collapse just for sharing company+title.
  const sameTitleDifferentReq = buildWatchlist({
    targets: dedupTargets,
    scanRows: parseScanHistory([
      'https://ex.com/jobs/req-111\t2026-09-05\tgreenhouse\tSolutions Engineer\tDup Co\tadded\tRemote',
      'https://ex.com/jobs/req-222\t2026-09-06\tgreenhouse\tSolutions Engineer\tDup Co\tadded\tRemote',
    ].join('\n')),
    today: '2026-09-10', windowDays: 60,
  })[0];
  ok('dedup: same title, different req/URL -> yes (2), never fuzzy-collapsed', sameTitleDifferentReq.currentOpening === 'yes (2)');

  // A URL that fails to normalize (e.g. a `local:jds/...` capture reference)
  // must not become a shared "no key" bucket that merges unrelated postings.
  ok('dedup: two different unparseable references stay distinct',
    countDistinctOpenings(['local:jds/a.md', 'local:jds/b.md']) === 2);
  ok('dedup: the SAME unparseable reference in both sources still collapses to one',
    countDistinctOpenings(['local:jds/a.md', 'local:jds/a.md']) === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node startup-watch.mjs [options]

Read-only, offline watchlist for tracked startup target companies.

  --stance <s>    Filter by stance: ${STANCES.join(' | ')}
  --open          Only companies with a current opening
  --monitored     Only companies with a working board in portals.yml
  --unmonitored   Only companies with no working board
  --window <n>    Opening-evidence window in days (default ${DEFAULT_WINDOW_DAYS})
  --json          Emit JSON instead of a table
  --wide          Do not truncate cells
  --self-test     Run the built-in checks
  --help, -h      This message

Reads data/startup-targets.md, data/startup-signals.tsv, portals.yml,
data/scan-history.tsv, data/pipeline.md and data/portal-health.tsv.
Writes nothing. No network.`;

function main(argv) {
  const args = argv.slice(2);
  validateFlags(
    args,
    ['--stance', '--open', '--monitored', '--unmonitored', '--window', '--json', '--wide', '--self-test', '--help', '-h'],
    USAGE,
    { valueFlags: ['--stance', '--window'] },
  );

  if (args.includes('--monitored') && args.includes('--unmonitored')) {
    console.error('Error: --monitored and --unmonitored are mutually exclusive');
    return 1;
  }

  if (args.includes('--self-test')) return selfTest();

  const stance = flagValue(args, '--stance');
  if (stance !== undefined && !STANCES.includes(stance)) {
    console.error(`Error: --stance must be one of: ${STANCES.join(', ')}`);
    return 1;
  }
  const windowRaw = flagValue(args, '--window');
  const windowDays = windowRaw === undefined ? DEFAULT_WINDOW_DAYS : Number(windowRaw);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error('Error: --window must be a positive number of days');
    return 1;
  }

  const { rows, signals, missing } = loadWatchlist({ windowDays });
  let filtered = stance ? rows.filter((r) => r.stance === stance) : rows;
  if (args.includes('--open')) filtered = filtered.filter((r) => r.currentOpening.startsWith('yes'));
  if (args.includes('--monitored')) filtered = filtered.filter((r) => r.monitored);
  if (args.includes('--unmonitored')) filtered = filtered.filter((r) => !r.monitored);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ rows: filtered, missing, windowDays }, null, 2));
    return 0;
  }

  console.log(renderTable(filtered, args.includes('--wide') ? 0 : 34));

  const counts = STANCES.map((s) => `${s} ${rows.filter((r) => r.stance === s).length}`).join(', ');
  console.log(`\n${filtered.length} shown of ${rows.length} targets (${counts}). Opening window: ${windowDays}d.`);

  const bad = signals.filter((s) => s.problems.length > 0);
  if (bad.length > 0) {
    console.log(`\n${bad.length} signal row(s) need attention:`);
    for (const s of bad) console.log(`  ${s.date} ${s.key}: ${s.problems.join('; ')}`);
  }
  if (missing.length > 0) {
    console.log(`\nNot found (columns fed by these are blank): ${missing.join(', ')}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv));
}
