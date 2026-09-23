#!/usr/bin/env node
/**
 * LinkedIn paste qualification orchestration.
 *
 * A paste is discovery evidence, not Review admission. This module takes the
 * dry-run receipt from linkedin-paste-intake.mjs, records the existing cheap
 * gates, resolves an exact posting identity, hydrates the JD, then invokes the
 * existing CareerOps triage contract. Only TRIAGE: PASS rows enter Review.
 * Missing/ambiguous evidence is written to a retry queue; it is never treated
 * as PASS and never pushed to manual Review.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import * as yaml from 'js-yaml';

import { fetchJdViaKnownApi } from './browser-extract.mjs';
import { resolveCliTarget } from './cli-exec.mjs';
import { decodeEntities } from './providers/_html-entities.mjs';
import {
  buildLaneTitleFilter,
  buildTitleFilterOverrides,
  buildTitleFilterWithOverrides,
  buildTitleLanes,
  compileKeyword,
  matchedTitleKeywords,
  atomicWriteFile,
} from './scan.mjs';
import { classifyGeography } from './location-tier.mjs';
import { buildShadowTitleRule } from './linkedin-title-shadow.mjs';
import { createBatchFromJobs } from './review.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  linkedinGuestSearchResolver,
  localHistoryResolver,
} from './linkedin-paste-intake.mjs';

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const AUDIT_CLASSES = [
  'TRUE_REJECT',
  'MATERIAL_FALSE_NEGATIVE',
  'BORDERLINE_SHOULD_REACH_REVIEW',
  'WRONG_REASON',
  'UNRESOLVED',
];

const ACTIONABLE_GEOGRAPHY = new Set(['REMOTE_US', 'NYC_COMPATIBLE']);
const TITLE_DUPLICATE_MARKER = /\s*\(verified job\)\s*/ig;
const SELECTED_PREFIX = /^selected,\s*/i;
const companyAliases = (name) => [String(name).trim().toLowerCase(), ...String(name).split(/[()]/).map((s) => s.trim().toLowerCase()).filter(Boolean)];

export function cleanLinkedInTitle(raw) {
  let title = String(raw || '').replace(TITLE_DUPLICATE_MARKER, '').replace(SELECTED_PREFIX, '').trim();
  // LinkedIn's copied accessibility text often renders the same title twice
  // with no delimiter. Prefer the exact repeated half; never guess a split.
  if (title.length % 2 === 0) {
    const half = title.length / 2;
    if (title.slice(0, half).trim().toLowerCase() === title.slice(half).trim().toLowerCase()) {
      title = title.slice(0, half).trim();
    }
  }
  return title.replace(/\s+/g, ' ').trim();
}

function readConfig(root) {
  const file = path.join(root, 'portals.yml');
  if (!existsSync(file)) return {};
  return yaml.load(readFileSync(file, 'utf8')) || {};
}

function buildNegativeOnlyGate(titleFilter, entries, resolveAliases = false) {
  const byCompany = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const negative = (Array.isArray(entry?.negative_extra) ? entry.negative_extra : [])
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => compileKeyword(x.trim().toLowerCase()));
    for (const company of Array.isArray(entry?.companies) ? entry.companies : []) {
      if (typeof company === 'string' && company.trim()) for (const alias of (resolveAliases ? companyAliases(company) : [company.trim().toLowerCase()])) byCompany.set(alias, negative);
    }
  }
  const globalNegative = (Array.isArray(titleFilter?.negative) ? titleFilter.negative : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => compileKeyword(x.trim().toLowerCase()));
  return (title, company) => {
    const extra = byCompany.get(String(company || '').trim().toLowerCase());
    if (!extra) return false;
    const lower = String(title || '').toLowerCase();
    return !globalNegative.some((m) => m(lower)) && !extra.some((m) => m(lower));
  };
}

export function evaluateExistingTitleGate(candidate, config = {}, { proposed = false, allowShadowTitleRules = false } = {}) {
  const title = cleanLinkedInTitle(candidate.title);
  const company = String(candidate.company || '').trim();
  const titleFilter = config.title_filter || {};
  const base = buildTitleFilterWithOverrides(titleFilter, buildTitleFilterOverrides(config.title_filter_overrides));
  const lane = buildLaneTitleFilter(titleFilter, buildTitleLanes(config.title_filter_lanes));
  const negativeOnly = buildNegativeOnlyGate(titleFilter, config.title_filter_negative_only, proposed);
  const matched = matchedTitleKeywords(title, titleFilter);
  if (base(title, company)) return { decision: 'PASS', reason: 'existing_title_filter', evidence: { matched_keywords: matched } };
  const laneName = lane(title, company);
  if (laneName) return { decision: 'PASS', reason: `existing_title_lane:${laneName}`, evidence: { lane: laneName } };
  if (negativeOnly(title, company)) return { decision: 'PASS', reason: 'existing_negative_only_override', evidence: { company } };
  const extra = (config.title_filter_negative_only || []).filter((entry) => (entry.companies || []).some((name) => companyAliases(name).includes(company.toLowerCase()))).flatMap((entry) => entry.negative_extra || []);
  const negatives = [...(titleFilter.negative || []), ...extra].filter((keyword) => compileKeyword(keyword.toLowerCase())(title.toLowerCase()));
  if (negatives.length) return { decision: 'REJECT', reason: 'existing_title_filter_negative_match', evidence: { title, company, matched_keywords: negatives } };
  // Manual discovery already has search context. Absence of a positive keyword
  // is insufficient evidence of a mismatch; defer role shape to existing triage.
  //
  // Shadow-rule fallback (manual-paste path ONLY — never scan.mjs/nightly
  // discovery, and never when a caller wants the pure baseline verdict for
  // audit comparison, i.e. row.baseline_title_gate below). Consulted only
  // here, after the production gate has already rejected on no positive
  // match, exactly matching linkedin-title-shadow.mjs's own contract: a
  // narrow title pattern AND real JD evidence, never pattern alone. The
  // shadow rule re-checks title_filter.negative itself, so a genuine
  // negative-control title (Recruiter, Intern, etc.) cannot be admitted this
  // way even if it happens to match a rule's title pattern.
  if (allowShadowTitleRules && !proposed) {
    const shadowRule = buildShadowTitleRule(config);
    const shadowHit = shadowRule({ title: candidate.title, description: candidate.description || '' });
    if (shadowHit) return { decision: 'PASS', reason: `shadow_title_rule:${shadowHit}`, evidence: { title, company, shadow_rule: shadowHit } };
  }
  return { decision: proposed ? 'PASS' : 'REJECT', reason: proposed ? 'title_unknown_requires_jd_evaluation' : 'existing_title_filter_no_positive_match', evidence: { title, company, positive_match: false } };
}

function normalizeComparable(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolve against history, then the already-existing bounded LinkedIn guest search. */
export async function resolveCandidate(candidate, { root, fetchImpl = globalThis.fetch, maxRequests = 1, knownIndex } = {}) {
  const attempts = [];
  const card = { ...candidate, title: cleanLinkedInTitle(candidate.title) };
  const local = localHistoryResolver({ root, knownIndex });
  let out = await local.resolve(card);
  attempts.push({ via: local.name, ...out });
  if (out.status === 'resolved') return { ...out, via: local.name, attempts };

  const guest = linkedinGuestSearchResolver({ fetchImpl, maxRequests, timeoutMs: 12000 });
  out = await guest.resolve(card);
  attempts.push({ via: guest.name, ...out });
  return out.status === 'resolved' ? { ...out, via: guest.name, attempts } : { status: out.status || 'unresolved', attempts };
}

function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

export function parseLinkedInPostingHtml(html, fallbackUrl = '') {
  const markup = /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(String(html || ''))?.[1] || '';
  const title = stripHtml(/class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(String(html || ''))?.[1] || '');
  const company = stripHtml(/class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(String(html || ''))?.[1] || '');
  const location = stripHtml(/class="[^"]*topcard__flavor[^"\n]*topcard__flavor--bullet[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(String(html || ''))?.[1] || '');
  return { url: fallbackUrl, title, company, location, text: stripHtml(markup), source: 'linkedin_guest_posting' };
}

export async function fetchVerifiedJd(url, { fetchImpl = globalThis.fetch } = {}) {
  const api = await fetchJdViaKnownApi(url).catch(() => null);
  if (api?.text?.length >= 250) return { status: 'resolved', ...api, source: `ats_api:${api.ats}`, verified_url: api.url || url };
  const id = /linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/i.exec(String(url || ''))?.[1];
  const target = id ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}` : url;
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return { status: 'error', reason: `HTTP ${res.status}`, verified_url: url };
    const html = await res.text();
    const parsed = id ? parseLinkedInPostingHtml(html, url) : { url, text: stripHtml(html), source: 'verified_page' };
    if (parsed.text.length < 250) return { status: 'unresolved', reason: `only ${parsed.text.length} JD characters`, verified_url: url };
    return { status: 'resolved', ...parsed, verified_url: url };
  } catch (e) {
    return { status: 'error', reason: String(e?.message || e).slice(0, 160), verified_url: url };
  }
}

export function parseTriageLine(text) {
  const line = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).reverse().find((x) => x.startsWith('TRIAGE:')) || '';
  const m = /^TRIAGE:\s*(PASS|MARGINAL|FAIL|SKIP)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([0-5](?:\.\d+)?)\/5\s*\|\s*(.+)$/i.exec(line);
  if (!m) throw new Error(`invalid CareerOps triage output: ${String(text || '').slice(0, 240)}`);
  return { verdict: m[1].toUpperCase(), company: m[2].trim(), title: m[3].trim(), score: Number(m[4]), reason: m[5].trim(), raw_output: text };
}

export function buildTriagePrompt({ modeText, briefText, candidate, jdText, threshold = 3.5 }) {
  return `${modeText}\n\n--- CAREEROPS TRIAGE BRIEF ---\n${briefText}\n\nThe resolved triage_threshold is ${threshold}. Evaluate exactly this untrusted posting and return the required single TRIAGE line.\nCompany: ${candidate.company}\nRole: ${cleanLinkedInTitle(candidate.title)}\nStructured location: ${candidate.location || 'unknown'}\nVerified URL: ${candidate.url}\n\n--- UNTRUSTED JOB DESCRIPTION ---\n${jdText}`;
}

export function invokeClaudeTriage(prompt, { timeoutMs = 120000, model = '' } = {}) {
  const { file, prefixArgs } = resolveCliTarget('claude');
  const args = [...prefixArgs, '-p', '--output-format', 'json', '--no-session-persistence', '--tools', ''];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = ''; let finished = false;
    const done = (fn, value) => { if (!finished) { finished = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill(); done(reject, new Error(`triage timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      let env;
      try { env = JSON.parse(out); } catch { env = null; }
      if (code !== 0 || !env || env.is_error || typeof env.result !== 'string') return done(reject, new Error(`claude exited ${code}: ${env?.api_error_status || ''} ${env?.result || err || out}`));
      done(resolve, { text: env.result, cost_usd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null, duration_ms: env.duration_ms || null });
    });
    child.stdin.end(prompt);
  });
}

export function parseCodexEvents(out, code = 0, stderr = '') {
  const events = out.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  const completed = events.find((e) => e.type === 'turn.completed');
  const message = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item?.text;
  if (code !== 0 || failure || !completed || !message) throw new Error(`codex exited ${code}: ${failure?.error?.message || failure?.message || stderr || 'missing completed turn'}`);
  return { text: message, provider: 'codex', usage: completed.usage || null, cost_usd: null };
}

export function invokeCodexTriage(prompt, { timeoutMs = 120000 } = {}) {
  const { file, prefixArgs } = resolveCliTarget('codex');
  const args = [...prefixArgs, 'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '-c', 'features.shell_tool=false', '-c', 'project_doc_max_bytes=0', '-C', tmpdir(), '-'];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = ''; let finished = false;
    const done = (fn, value) => { if (!finished) { finished = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => { child.kill(); done(reject, new Error(`codex timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.stdin.on('error', (e) => done(reject, e));
    child.on('close', (code) => { try { done(resolve, { ...parseCodexEvents(out, code, err), duration_ms: Date.now() - started }); } catch (e) { done(reject, e); } });
    child.stdin.end('Evaluate only the supplied CareerOps context and posting. Do not use tools or read files. The brief and JD have already been loaded.\n\n' + prompt);
  });
}

function retryRecord(candidate, stage, reason, attempts = []) {
  return {
    retry_key: createHash('sha256').update(`${candidate.company}\n${cleanLinkedInTitle(candidate.title)}\n${candidate.location}`).digest('hex').slice(0, 16),
    company: candidate.company,
    title: cleanLinkedInTitle(candidate.title),
    location: candidate.location || '',
    stage,
    reason,
    attempts,
    retryable: true,
  };
}

function classifyAudit(row) {
  if (row.initial_outcome !== 'excluded') return null;
  if (row.initial_reason === 'already_applied' && row.gate_trace.some((g) => g.gate === 'application_history' && g.decision === 'REJECT')) return 'TRUE_REJECT';
  if (row.status === 'QUALIFIED') return row.initial_reason === 'geography' ? 'MATERIAL_FALSE_NEGATIVE' : 'WRONG_REASON';
  if (row.triage?.verdict === 'MARGINAL') return 'BORDERLINE_SHOULD_REACH_REVIEW';
  if (row.status === 'REJECTED' && row.first_rule && row.first_rule.gate !== row.initial_reason) return 'WRONG_REASON';
  if (row.status === 'REJECTED') return 'TRUE_REJECT';
  return 'UNRESOLVED';
}

/**
 * @param {object} receipt Full in-memory dry-run receipt (not the compact JSONL log).
 */
export async function qualifyLinkedInReceipt(receipt, opts = {}) {
  const root = opts.root;
  if (!root) throw new Error('qualifyLinkedInReceipt requires root');
  const config = opts.config || readConfig(root);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const resolve = opts.resolve || ((candidate) => resolveCandidate(candidate, { root, fetchImpl, maxRequests: 1 }));
  const fetchJd = opts.fetchJd || ((url) => fetchVerifiedJd(url, { fetchImpl }));
  // No implicit evaluator default. This used to fall back to invokeCodexTriage
  // silently, which is how the manual-paste UI route ended up spawning a
  // `codex` binary that was never installed (9/9 evaluator failures, spawn
  // codex ENOENT, on the 25-job UI test). Every caller — production route,
  // CLI, retry/audit scripts, tests — must now say explicitly which
  // evaluator it wants; invokeClaudeTriage and invokeCodexTriage are both
  // still exported for that explicit choice.
  if (typeof opts.invoke !== 'function') {
    throw new Error('qualifyLinkedInReceipt requires an explicit `invoke` evaluator (e.g. invokeClaudeTriage) — there is no default provider.');
  }
  const invoke = opts.invoke;
  const modeText = opts.modeText ?? readFileSync(path.join(REPO_ROOT, 'modes', 'triage.md'), 'utf8');
  const briefPath = path.join(root, 'modes', '_brief.md');
  const briefText = opts.briefText ?? (existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '');
  if (!briefText) throw new Error(`CareerOps triage brief missing: ${briefPath}`);
  const threshold = Number(config?.pipeline?.triage_threshold || 3.5);
  const rows = [];
  const retries = [];
  const survivors = [];
  let evaluatorBlock = '';
  const counts = { input: receipt.items.length, history_lookups: 0, searches: 0, jd_fetches: 0, llm_calls: 0, llm_succeeded: 0, llm_failed: 0, qualified: 0, rejected: 0, retry: 0 };

  for (const source of receipt.items) {
    const candidate = { ...source, title: cleanLinkedInTitle(source.title) };
    const gateTrace = [];
    if (source.reason === 'already_applied') gateTrace.push({ gate: 'application_history', decision: 'REJECT', evidence: source.detail || source.reason });
    else if (source.reason === 'blacklist') gateTrace.push({ gate: 'blacklist', decision: 'REJECT', evidence: source.detail || source.reason });
    else if (source.reason === 'discard_suppressed' || source.reason === 'suppressed_pass') gateTrace.push({ gate: 'suppression', decision: 'REJECT', evidence: source.detail || source.reason });
    else if (source.outcome === 'duplicate') gateTrace.push({ gate: 'duplicate', decision: 'REJECT', evidence: source.detail || source.reason });

    const row = { company: candidate.company, title: candidate.title, raw_title: source.title, location: candidate.location || '', candidate: { ...candidate }, initial_outcome: source.outcome, initial_reason: source.reason, gate_trace: gateTrace };

    if (gateTrace[0]?.decision === 'REJECT' && gateTrace[0].gate !== 'geography') {
      row.status = 'REJECTED'; row.first_rule = gateTrace[0]; row.audit_classification = classifyAudit(row); counts.rejected++; rows.push(row); continue;
    }
    // Confirmed discovery geography rejects are terminal before any title test.
    if (source.reason === 'geography' && /^REJECT\b/.test(source.detail || '')) {
      gateTrace.push({gate:'geography',decision:'REJECT',evidence:source.detail});
      row.status='REJECTED'; row.first_rule=gateTrace.at(-1); counts.rejected++; rows.push(row); continue;
    }

    counts.history_lookups++;
    const resolution = await resolve(candidate);
    counts.searches += (resolution.attempts || []).filter((a) => a.via === 'linkedin_search').length;
    gateTrace.push({ gate: 'identity_url', decision: resolution.status === 'resolved' ? 'PASS' : 'RETRY', evidence: resolution });
    if (resolution.status !== 'resolved' || !resolution.url) {
      row.status = 'RETRY'; row.first_rule = gateTrace.find((g) => g.decision !== 'PASS'); row.retry = retryRecord(candidate, 'identity_url', resolution.status || 'unresolved', resolution.attempts); row.audit_classification = classifyAudit(row); retries.push(row.retry); counts.retry++; rows.push(row); continue;
    }
    candidate.url = resolution.url;

    counts.jd_fetches++;
    const jd = await fetchJd(resolution.url);
    gateTrace.push({ gate: 'jd_fetch', decision: jd.status === 'resolved' ? 'PASS' : 'RETRY', evidence: { source: jd.source || '', reason: jd.reason || '', chars: jd.text?.length || 0, verified_url: jd.verified_url || resolution.url } });
    if (jd.status !== 'resolved') {
      row.status = 'RETRY'; row.url = resolution.url; row.first_rule = gateTrace.find((g) => g.decision !== 'PASS'); row.retry = retryRecord(candidate, 'jd_fetch', jd.reason || jd.status, resolution.attempts); row.audit_classification = classifyAudit(row); retries.push(row.retry); counts.retry++; rows.push(row); continue;
    }
    candidate.description = jd.text;
    candidate.url = jd.verified_url || resolution.url;
    row.url = candidate.url;
    row.jd = jd;

    const geography = classifyGeography({ ...candidate, workplaceTypes: candidate.arrangement ? [candidate.arrangement] : [] }, jd.text);
    gateTrace.push({ gate: 'geography', decision: ACTIONABLE_GEOGRAPHY.has(geography.state) ? 'PASS' : (geography.state === 'UNKNOWN' ? 'RETRY' : 'REJECT'), evidence: geography });
    if (!ACTIONABLE_GEOGRAPHY.has(geography.state)) {
      if (geography.state === 'UNKNOWN') {
        row.status = 'RETRY'; row.url = candidate.url; row.retry = retryRecord(candidate, 'geography', geography.reason, resolution.attempts); retries.push(row.retry); counts.retry++;
      } else { row.status = 'REJECTED'; counts.rejected++; }
      row.first_rule = gateTrace.find((g) => g.decision !== 'PASS'); row.audit_classification = classifyAudit(row); rows.push(row); continue;
    }

    const titleGate = evaluateExistingTitleGate(candidate, config, {proposed: opts.titlePolicy === 'proposed', allowShadowTitleRules: !!opts.allowShadowTitleRules});
    // Pure baseline, shadow rules OFF — the audit-trail comparison point.
    row.baseline_title_gate = evaluateExistingTitleGate(candidate, config);
    gateTrace.push({ gate: 'title', ...titleGate });
    if (titleGate.decision === 'REJECT' && !opts.auditTitleRejects) {
      row.status = 'REJECTED'; row.first_rule = gateTrace.at(-1); counts.rejected++; rows.push(row); continue;
    }
    if (titleGate.decision === 'REJECT') gateTrace.push({gate:'title_audit',decision:'PASS',evidence:'Shadow JD evaluation only; original title decision retained.'});

    try {
      if (evaluatorBlock) throw new Error(`Evaluator paused after provider limit: ${evaluatorBlock}`);
      counts.llm_calls++;
      const invoked = await invoke(buildTriagePrompt({ modeText, briefText, candidate, jdText: jd.text, threshold }), opts.invokeOptions || {});
      const triage = parseTriageLine(invoked.text);
      counts.llm_succeeded++;
      row.triage = { ...triage, provider: invoked.provider || 'injected', usage: invoked.usage || null, cost_usd: invoked.cost_usd ?? null, duration_ms: invoked.duration_ms ?? null };
      gateTrace.push({ gate: 'careerops_triage', decision: triage.verdict === 'PASS' ? 'PASS' : 'REJECT', evidence: { verdict: triage.verdict, score: triage.score, reason: triage.reason } });
      if (triage.verdict === 'PASS') {
        if (!ACTIONABLE_GEOGRAPHY.has(geography.state)) {
          row.status = 'RETRY'; row.retry = retryRecord(candidate, 'geography', geography.reason, resolution.attempts); retries.push(row.retry); counts.retry++;
        } else {
          row.status = 'QUALIFIED'; counts.qualified++;
          survivors.push({ ...candidate, source: 'linkedin_paste_qualified', intake: { kind: 'linkedin_paste', receipt_id: receipt.receipt_id, qualification: { score: triage.score, verdict: triage.verdict, reason: triage.reason, gate_trace: gateTrace } } });
        }
      } else { row.status = 'REJECTED'; counts.rejected++; }
    } catch (e) {
      if (!evaluatorBlock) counts.llm_failed++;
      if (/usage limit|session limit|429|rate.limit/i.test(String(e?.message || e))) evaluatorBlock = String(e.message);
      row.status = 'RETRY'; row.retry = retryRecord(candidate, 'careerops_triage', String(e?.message || e), resolution.attempts); retries.push(row.retry); counts.retry++;
      gateTrace.push({ gate: 'careerops_triage', decision: 'RETRY', evidence: String(e?.message || e) });
    }
    row.url = candidate.url;
    row.first_rule = gateTrace.find((g) => g.decision !== 'PASS') || null;
    row.audit_classification = classifyAudit(row);
    rows.push(row);
    if (!opts.dryRun) {
      const checkpointDir = path.join(root, 'data', 'linkedin-qualification'); mkdirSync(checkpointDir, { recursive: true });
      atomicWriteFile(path.join(checkpointDir, `${receipt.receipt_id}-progress.json`), JSON.stringify({ counts, rows, updated_at: new Date().toISOString() }, null, 2));
    }
  }

  let batchId = null;
  if (survivors.length && !opts.dryRun) batchId = createBatchFromJobs(survivors, { root, source: 'linkedin_paste_qualified' }).batchId;
  const result = { schema_version: 1, receipt_id: receipt.receipt_id, source_batch_id: receipt.batch_id || null, created_at: new Date().toISOString(), batch_id: batchId, counts, rows, retry_queue: retries };
  if (!opts.dryRun) {
    const dir = path.join(root, 'data', 'linkedin-qualification'); mkdirSync(dir, { recursive: true });
    atomicWriteFile(path.join(dir, `${receipt.receipt_id}.json`), JSON.stringify(result, null, 2) + '\n');
    atomicWriteFile(path.join(dir, `${receipt.receipt_id}-retry.json`), JSON.stringify({ receipt_id: receipt.receipt_id, jobs: retries }, null, 2) + '\n');
  }
  return result;
}

/** Rehydrate the compact durable receipt with richer fields from its frozen batch. */
export function loadReceiptBaseline(receiptLogPath, receiptId, batchPath = '') {
  const entries = readFileSync(receiptLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const receipt = entries.find((entry) => entry.receipt_id === receiptId && (!batchPath || entry.batch_id));
  if (!receipt) throw new Error(`receipt ${receiptId} not found in ${receiptLogPath}`);
  let batch = null;
  if (batchPath) batch = JSON.parse(readFileSync(batchPath, 'utf8'));
  const jobs = batch?.jobs || [];
  receipt.items = receipt.items.map((item) => {
    const clean = cleanLinkedInTitle(item.title);
    const job = jobs.find((j) => j.company === item.company && cleanLinkedInTitle(j.title) === clean && String(j.location || '') === String(item.location || ''));
    return {
      ...item,
      title: clean,
      arrangement: job?.intake?.arrangement || '',
      compensation: job?.compensation || null,
      posting_age: job?.intake?.posting_age || '',
      labels: job?.intake?.labels || [],
      detail: item.detail || '',
    };
  });
  return receipt;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'replay-receipt' || !argv[1]) {
    console.log('Usage: node linkedin-qualification.mjs replay-receipt <linkedin-paste-imports.jsonl> --receipt <id> --batch <batch.json> --root <isolated-data-root> [--dry-run]');
    return;
  }
  const receiptId = flagValue(argv, '--receipt');
  const batchPath = flagValue(argv, '--batch') || '';
  const root = flagValue(argv, '--root');
  if (!receiptId || !root) throw new Error('--receipt and --root are required');
  const receipt = loadReceiptBaseline(argv[1], receiptId, batchPath);
  const result = await qualifyLinkedInReceipt(receipt, { root, dryRun: argv.includes('--dry-run'), invoke: invokeClaudeTriage });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) main().catch((err) => { console.error(err.stack || err.message); process.exitCode = 1; });
