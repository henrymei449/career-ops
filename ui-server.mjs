#!/usr/bin/env node
/**
 * ui-server.mjs — minimal local operator UI for the CareerOps workflow
 * locked in docs/careerops-state-model.md.
 *
 * The CLI (review.mjs / outreach.mjs) is the test/admin surface; this is the
 * smallest usable page a human can run the same proven workflow from without
 * typing job keys, JSON, or CLI commands. It is a thin HTTP adapter only —
 * every transition below calls the EXACT function the CLI calls
 * (finalizeBatch, markApplied, setOutreachDecision, startOutreach,
 * discoverContacts, selectContacts). No transition rule, validation, or
 * state write is duplicated here; this file only reads state to render it
 * and forwards button clicks to those functions.
 *
 * No new system of record: every GET re-reads data/review-state.json (and
 * review/open/*.json) fresh, and the browser holds nothing durable — a
 * reload always reflects the actual file on disk.
 *
 * Usage: node ui-server.mjs [--port 5173]
 */

import { createServer } from 'http';
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import {
  reviewPaths,
  readJson,
  defaultState,
  finalizeAndIngestBatch,
} from './review.mjs';
import {
  markApplied,
  setOutreachDecision,
  startOutreach,
  discoverContacts,
  selectContacts,
  listOutreach,
  resolveSearchProvider,
} from './outreach.mjs';

const DATA_ROOT = getCareerOpsRoot();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'ui');

// ── Read helpers (pure reads over existing storage — no new state) ─────────

/** Every open review batch, each job_key already tagged with its batch_id. */
function listOpenReviewJobs() {
  const p = reviewPaths(DATA_ROOT);
  if (!existsSync(p.open)) return [];
  const files = readdirSync(p.open).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const file of files) {
    const batch = readJson(path.join(p.open, file), null);
    if (!batch) continue;
    for (const job of batch.jobs) {
      out.push({
        batch_id: batch.batch_id,
        job_key: job.job_key,
        company: job.company,
        title: job.title,
        location: job.location || '',
        url: job.url || '',
        proposed_decision: job.review.proposed_decision,
        reason: job.review.reason || '',
        final_decision: job.review.final_decision,
      });
    }
  }
  return out;
}

/** Durable jobs with fit_decision=APPLY, execution_status=READY_TO_APPLY. */
function listReadyToApply() {
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());
  return Object.entries(state.jobs)
    .filter(([, job]) => job.fit_decision === 'APPLY' && job.execution_status === 'READY_TO_APPLY')
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      url: job.url || '',
    }));
}

/** Every APPLIED job with its full outreach record (candidates included). */
function listOutreachDetailed() {
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());
  return Object.entries(state.jobs)
    .filter(([, job]) => job.outreach)
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      decision: job.outreach.decision,
      status: job.outreach.status,
      candidates: job.outreach.candidates || [],
      selected_contacts: job.outreach.selected_contacts || [],
    }));
}

// ── HTTP plumbing ────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = path.extname(filePath);
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(body);
}

const API_ROUTES = [
  ['GET', '/api/review', async () => ({ jobs: listOpenReviewJobs() })],
  ['POST', '/api/review/finalize', async (body) => {
    const { batch_id: batchId, overrides = {}, reviewer } = body;
    if (!batchId) throw new Error('batch_id required');
    const { batch, ingestion } = await finalizeAndIngestBatch(batchId, { overrides, reviewer: reviewer || null, root: DATA_ROOT });
    return {
      batch_id: batch.batch_id,
      status: batch.status,
      ingested: ingestion.ingested.includes(batchId),
      ingestion_errors: ingestion.errors,
    };
  }],
  ['GET', '/api/ready', async () => ({ jobs: listReadyToApply() })],
  ['POST', '/api/ready/applied', async (body) => {
    const { job_key: jobKey, reviewer } = body;
    if (!jobKey) throw new Error('job_key required');
    const { alreadyApplied, job } = await markApplied(jobKey, { reviewer: reviewer || null, root: DATA_ROOT });
    return { alreadyApplied, execution_status: job.execution_status, applied_at: job.applied_at };
  }],
  ['GET', '/api/outreach', async () => ({ jobs: listOutreachDetailed() })],
  ['POST', '/api/outreach/decision', async (body) => {
    const { job_key: jobKey, decision } = body;
    if (!jobKey || !decision) throw new Error('job_key and decision required');
    const outreach = await setOutreachDecision(jobKey, decision, { root: DATA_ROOT });
    return { decision: outreach.decision, status: outreach.status };
  }],
  ['POST', '/api/outreach/start', async (body) => {
    const { job_key: jobKey } = body;
    if (!jobKey) throw new Error('job_key required');
    const { alreadyStarted, outreach } = await startOutreach(jobKey, { root: DATA_ROOT });
    return { alreadyStarted, status: outreach.status };
  }],
  ['POST', '/api/outreach/discover', async (body) => {
    const { job_key: jobKey } = body;
    if (!jobKey) throw new Error('job_key required');
    const searchProvider = await resolveSearchProvider();
    const { candidates } = await discoverContacts(jobKey, { searchProvider, root: DATA_ROOT });
    return { candidates };
  }],
  ['POST', '/api/outreach/select', async (body) => {
    const { job_key: jobKey, candidate_ids: candidateIds } = body;
    if (!jobKey || !Array.isArray(candidateIds) || candidateIds.length === 0) {
      throw new Error('job_key and a non-empty candidate_ids array are required');
    }
    const outreach = await selectContacts(jobKey, candidateIds, { root: DATA_ROOT });
    return { status: outreach.status, selected_contacts: outreach.selected_contacts };
  }],
  // Follow-up workflow is not implemented (docs/careerops-state-model.md) —
  // this queue is read-only/empty by design, never a source of invented state.
  ['GET', '/api/followup', async () => ({ jobs: [] })],
];

function matchRoute(method, urlPath) {
  return API_ROUTES.find(([m, p]) => m === method && p === urlPath);
}

async function handleApi(req, res, urlPath) {
  const route = matchRoute(req.method, urlPath);
  if (!route) { sendJson(res, 404, { error: `no route ${req.method} ${urlPath}` }); return; }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await route[2](body);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

function main() {
  const port = Number(flagValue(process.argv.slice(2), '--port')) || 5173;
  const server = createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    if (urlPath.startsWith('/api/')) { handleApi(req, res, urlPath); return; }
    serveStatic(req, res, urlPath);
  });
  server.listen(port, () => {
    console.log(`CareerOps operator UI: http://localhost:${port}  (data root: ${DATA_ROOT})`);
  });
}

if (isMainModule(import.meta.url)) main();
