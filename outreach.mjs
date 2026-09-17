#!/usr/bin/env node
/**
 * outreach.mjs — Pass 2: application execution + outreach lifecycle
 * (READY_TO_APPLY -> APPLIED -> explicit outreach decision -> contact
 * discovery -> human contact selection).
 *
 * Extends review.mjs's durable state store (data/review-state.json)
 * additively — same file, same lock (pipeline-lock.mjs's withPipelineLock on
 * the state path), same reviewPaths()/readJson()/defaultState() helpers.
 * Never touches fit_decision, batch_id, or anything review.mjs's own
 * ingestFinalizedReviewBatches() writes; only adds/updates
 * execution_status, applied_at, and outreach on an existing job record.
 *
 * Pure logic (vocab, persona classification, query generation, candidate
 * normalization/ranking) lives in outreach-schema.mjs — this file is the
 * filesystem/lock/CLI layer on top of it, mirroring review.mjs's own split
 * from review-schema.mjs.
 *
 * Storage: no new files. Everything lives under the existing
 * data/review-state.json job record:
 *   {
 *     "fit_decision": "APPLY",
 *     "execution_status": "APPLIED",
 *     "applied_at": "...",
 *     "outreach": {
 *       "decision": "REQUIRED",
 *       "status": "SEARCH_REQUIRED",
 *       "candidates": [],
 *       "selected_contacts": []
 *     }
 *   }
 *
 * Search provider: contact discovery never calls a search API directly.
 * discoverContacts() takes a `searchProvider(query) -> Promise<rawResult[]>`
 * function (rawResult: {title, url, snippet}) — the interface stayed frozen
 * across Pass 2B. The CLI's resolveSearchProvider() (below) wires exactly one
 * real provider behind it: lib/outreach-search-serper.mjs (Serper, gated on
 * SERPER_API_KEY from .env), used automatically when CAREER_OPS_SEARCH_PROVIDER
 * is not set to something else. Either way, a missing/misconfigured provider
 * throws a clear error rather than silently returning zero candidates.
 *
 * Live search is bounded to at most 2 queries per lane (MAX_QUERIES_PER_LANE
 * below) regardless of how many queries buildDiscoveryQueries() generates —
 * persona/query generation itself is untouched (outreach-schema.mjs), this
 * just caps how many of its queries actually go out over the network per
 * discover() call.
 *
 * Failure handling: a thrown searchProvider error propagates out of
 * discoverContacts() BEFORE any state is written (see the function below —
 * all provider calls happen before the single withJobState() write), so a
 * provider/network failure leaves the job at SEARCH_REQUIRED, never
 * CANDIDATES_FOUND with []. Pass 2's OUTREACH_STATUSES vocabulary is not
 * extended with a SEARCH_FAILED state for this — the existing throw-and-leave-
 * retryable behavior already satisfies "provider failure must never silently
 * look like no relevant contacts exist" without touching the frozen state
 * model; the CLI's outer catch (isMainModule block, bottom of this file) is
 * the reporting mechanism.
 *
 * Usage:
 *   node outreach.mjs applied <job_key> [--outreach required|optional|waived] [--reviewer name] [--applied-at ISO date]
 *   node outreach.mjs pass <job_key>
 *   node outreach.mjs decide <job_key> <required|optional|waived>
 *   node outreach.mjs start <job_key>
 *   node outreach.mjs discover <job_key>
 *   node outreach.mjs select <job_key> <candidate_id...>
 *   node outreach.mjs list [--filter required-search|required-found|optional]
 */

import path from 'path';

import { getCareerOpsRoot } from './path-resolver.mjs';
import { atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadDotenvOnce } from './plugins/_engine.mjs';
import { reviewPaths, readJson, defaultState } from './review.mjs';
import {
  OUTREACH_DECISIONS,
  DECISION_INITIAL_STATUS,
  freshOutreach,
  classifyRoleFamily,
  buildDiscoveryQueries,
  normalizeCandidate,
  dedupeCandidates,
  rankCandidates,
} from './outreach-schema.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  freshContactAction,
  withContactActionDefaults,
  buildFollowUpAction,
  buildApplicationPendingAction,
  sortFollowUpActions,
  actionId as followUpActionId,
  NEXT_ACTIONS,
  OPERATING_FIELDS,
  OPERATING_TEXT_FIELDS,
  OPERATING_DATE_FIELDS,
  MAX_OPERATING_TEXT_LEN,
  isValidPriority,
  isValidDateStr,
  withOperatingDefaults,
} from './followup-schema.mjs';
import { mapUiApplicationStatus, HIRING_STAGES, isKnownHiringStage } from './application-schema.mjs';

// Reuses the plugin engine's own dotenv loader (plugins/_engine.mjs) rather
// than a second copy: it reads .env from the resolved Data Root
// (getCareerOpsRoot()) — the SAME file the apify plugin's APIFY_TOKEN and
// doctor.mjs's other keys already come from — not the repo checkout and not
// process.cwd(). SERPER_API_KEY belongs in that one canonical secrets file.
await loadDotenvOnce();

const DATA_ROOT = getCareerOpsRoot();

// Live search is bounded regardless of how many queries a persona family
// generates (some functional lists chunk to 3 queries) — see the header
// comment above for why this lives here rather than in outreach-schema.mjs.
const MAX_QUERIES_PER_LANE = 2;

/** Cap `queries` (buildDiscoveryQueries() output) to MAX_QUERIES_PER_LANE per lane. */
function capQueriesPerLane(queries) {
  const counts = {};
  return queries.filter(({ lane }) => {
    counts[lane] = (counts[lane] ?? 0) + 1;
    return counts[lane] <= MAX_QUERIES_PER_LANE;
  });
}

/**
 * Read-modify-write one job's durable state under the shared lock. `mutate`
 * receives the job record (or throws if it does not exist) and returns the
 * result the caller wants back; the whole state file is atomically rewritten
 * once, same as ingestFinalizedReviewBatches() in review.mjs.
 *
 * @param {string} jobKey
 * @param {(job: object, state: object) => any} mutate
 * @param {{root?: string}} [opts]
 */
async function withJobState(jobKey, mutate, { root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  return withPipelineLock(p.statePath, async () => {
    const state = readJson(p.statePath, defaultState());
    const job = state.jobs[jobKey];
    if (!job) {
      throw new Error(`outreach: no durable state for job_key ${jobKey} — has it been through review.mjs ingest?`);
    }
    const result = mutate(job, state);
    state.updated_at = new Date().toISOString();
    atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
    return result;
  });
}

/**
 * Human-driven transition: a finalized APPLY, currently READY_TO_APPLY,
 * becomes APPLIED. Idempotent — calling this again on an already-APPLIED job
 * is a safe no-op (returns {alreadyApplied: true}) rather than an error, so
 * a retried/duplicate invocation never throws.
 *
 * `appliedAt` defaults to now (the normal path: a human just submitted the
 * application). Pass an explicit past ISO date only for a historical
 * reconciliation (a job confirmed already submitted through some
 * out-of-band record) — never a future date, which can only be a data-entry
 * mistake. Either way `outreach` is always set via freshOutreach() (decision
 * PENDING, status NOT_STARTED), so a historical import never appears as
 * fresh SEARCH_REQUIRED work — the human resolves the outreach decision
 * afterward exactly as they would for any other APPLIED job.
 *
 * @param {string} jobKey
 * @param {{reviewer?: string, appliedAt?: string, root?: string}} [opts]
 */
export async function markApplied(jobKey, { reviewer = null, appliedAt = null, root = DATA_ROOT } = {}) {
  if (appliedAt != null) {
    const parsed = new Date(appliedAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`outreach: markApplied appliedAt "${appliedAt}" is not a valid date`);
    }
    if (parsed.getTime() > Date.now()) {
      throw new Error(`outreach: markApplied appliedAt "${appliedAt}" is in the future — refusing`);
    }
  }
  return withJobState(jobKey, (job) => {
    if (job.fit_decision !== 'APPLY') {
      throw new Error(`outreach: ${jobKey} has fit_decision=${job.fit_decision}, not APPLY — cannot mark applied`);
    }
    if (job.execution_status === 'APPLIED') {
      return { alreadyApplied: true, job: { ...job } };
    }
    if (job.execution_status !== 'READY_TO_APPLY') {
      throw new Error(`outreach: ${jobKey} has execution_status=${job.execution_status}, not READY_TO_APPLY — cannot mark applied`);
    }
    job.execution_status = 'APPLIED';
    job.applied_at = appliedAt ? new Date(appliedAt).toISOString() : new Date().toISOString();
    job.outreach = freshOutreach();
    if (reviewer) job.applied_by = reviewer;
    return { alreadyApplied: false, job: { ...job } };
  }, { root });
}

/**
 * Human-driven transition: a finalized APPLY, currently READY_TO_APPLY,
 * becomes NOT_APPLYING — the human later decided not to pursue it after all.
 * Never touches fit_decision (stays APPLY, preserving the original review
 * judgment); only the execution axis moves. Idempotent — calling this again
 * on an already-NOT_APPLYING job is a safe no-op (returns
 * {alreadyPassed: true}) that does not rewrite closed_at/closed_reason.
 *
 * @param {string} jobKey
 * @param {{root?: string}} [opts]
 */
export async function passOnApplication(jobKey, { root = DATA_ROOT } = {}) {
  return withJobState(jobKey, (job) => {
    if (job.fit_decision !== 'APPLY') {
      throw new Error(`outreach: ${jobKey} has fit_decision=${job.fit_decision}, not APPLY — cannot pass on it via this transition`);
    }
    if (job.execution_status === 'NOT_APPLYING') {
      return { alreadyPassed: true, job: { ...job } };
    }
    if (job.execution_status !== 'READY_TO_APPLY') {
      throw new Error(`outreach: ${jobKey} has execution_status=${job.execution_status}, not READY_TO_APPLY — cannot pass on it`);
    }
    job.execution_status = 'NOT_APPLYING';
    job.closed_at = new Date().toISOString();
    job.closed_reason = 'USER_PASS';
    return { alreadyPassed: false, job: { ...job } };
  }, { root });
}

/**
 * Applications -> Update Status (Pass 5): a small, human-confirmed mutation
 * on the application lifecycle axis (application_status/outcome/stage/
 * last_update) — a different axis from fit_decision/execution_status above,
 * same additive-extension pattern application-schema.mjs already documents.
 *
 * Mutates ONLY the exact job_key given. No company/role matching, no
 * fuzzy resolution — the caller (the Applications card the operator has
 * open) already knows which job_key it means, and this function trusts
 * that identity rather than re-deriving it, so it is structurally
 * impossible for this call to "help" by updating a different requisition.
 *
 * Requires execution_status === 'APPLIED' — an application's outcome cannot
 * be recorded before the application exists.
 *
 * `updateDate` defaults to today (local) and must be a real, non-future
 * YYYY-MM-DD date — mirrors markApplied()'s appliedAt guard above, applied
 * to a plain date instead of an ISO timestamp.
 *
 * `note` is optional free-text evidence. It is never used to overwrite prior
 * evidence: each Save appends one entry to job.application_history (created
 * on first use) rather than replacing a single field, so a later correction
 * never erases what an earlier one recorded. Resubmitting the IDENTICAL
 * (uiStatus, date, note) is a safe no-op on that history — the flat fields
 * are still rewritten to match (never skipped), but no duplicate entry is
 * appended.
 *
 * @param {string} jobKey
 * @param {'ACTIVE'|'REJECTED'|'ROLE_CLOSED'|'WITHDRAWN'} uiStatus
 * @param {{updateDate?: string|null, note?: string|null, root?: string}} [opts]
 */
export async function updateApplicationStatus(jobKey, uiStatus, { updateDate = null, note = null, root = DATA_ROOT } = {}) {
  const mapped = mapUiApplicationStatus(uiStatus); // throws on an invalid uiStatus, before anything is touched
  const date = updateDate || localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`outreach: updateApplicationStatus updateDate "${date}" is not a valid YYYY-MM-DD date`);
  }
  if (date > localToday()) {
    throw new Error(`outreach: updateApplicationStatus updateDate "${date}" is in the future — refusing`);
  }
  const trimmedNote = note != null ? String(note).trim() : '';

  return withJobState(jobKey, (job) => {
    if (job.execution_status !== 'APPLIED') {
      throw new Error(`outreach: ${jobKey} has execution_status=${job.execution_status}, not APPLIED — cannot update application status`);
    }
    job.application_status = mapped.application_status;
    job.application_outcome = mapped.application_outcome;
    job.application_stage = mapped.application_stage;
    job.application_last_update = date;

    if (!Array.isArray(job.application_history)) job.application_history = [];
    const entry = { at: new Date().toISOString(), ui_status: uiStatus, update_date: date, note: trimmedNote || null };
    const last = job.application_history[job.application_history.length - 1];
    const isDuplicate = last && last.ui_status === entry.ui_status
      && last.update_date === entry.update_date && last.note === entry.note;
    if (!isDuplicate) job.application_history.push(entry);

    return { ...job };
  }, { root });
}

/**
 * Resolve the PENDING outreach decision into REQUIRED / OPTIONAL / WAIVED,
 * setting the initial status per DECISION_INITIAL_STATUS. Existing
 * candidates/selected_contacts are preserved (a decision change is not a
 * reset) — only decision and status are ever touched here.
 *
 * @param {string} jobKey
 * @param {'REQUIRED'|'OPTIONAL'|'WAIVED'} decision
 */
export async function setOutreachDecision(jobKey, decision, { root = DATA_ROOT } = {}) {
  if (!OUTREACH_DECISIONS.includes(decision) || decision === 'PENDING') {
    throw new Error(`outreach: invalid decision "${decision}" — must be REQUIRED, OPTIONAL, or WAIVED`);
  }
  return withJobState(jobKey, (job) => {
    if (!job.outreach) throw new Error(`outreach: ${jobKey} has no outreach record — mark it applied first`);
    job.outreach.decision = decision;
    job.outreach.status = DECISION_INITIAL_STATUS[decision];
    return { ...job.outreach };
  }, { root });
}

/**
 * Later action for an OPTIONAL opportunity: NOT_STARTED -> SEARCH_REQUIRED.
 * Never requires flipping OPTIONAL to REQUIRED first (task's explicit
 * instruction). Idempotent on a job already past NOT_STARTED.
 */
export async function startOutreach(jobKey, { root = DATA_ROOT } = {}) {
  return withJobState(jobKey, (job) => {
    if (!job.outreach) throw new Error(`outreach: ${jobKey} has no outreach record — mark it applied first`);
    if (job.outreach.decision === 'WAIVED' || job.outreach.decision === 'PENDING') {
      throw new Error(`outreach: ${jobKey} outreach.decision=${job.outreach.decision} — decide REQUIRED or OPTIONAL before starting`);
    }
    if (job.outreach.status !== 'NOT_STARTED') {
      return { alreadyStarted: true, outreach: { ...job.outreach } };
    }
    job.outreach.status = 'SEARCH_REQUIRED';
    return { alreadyStarted: false, outreach: { ...job.outreach } };
  }, { root });
}

/**
 * Contact discovery: generate persona-based queries, run them through
 * `searchProvider`, normalize/dedupe/rank the results, and persist up to 3
 * recruiting + 3 functional candidates. Requires outreach.status ===
 * SEARCH_REQUIRED (i.e. a REQUIRED decision, or an OPTIONAL one that has
 * been started). Never automates anything past finding candidates.
 *
 * @param {string} jobKey
 * @param {{searchProvider: (query: string) => Promise<Array<{title?:string,url?:string,snippet?:string}>>, root?: string}} opts
 */
export async function discoverContacts(jobKey, { searchProvider, root = DATA_ROOT } = {}) {
  if (typeof searchProvider !== 'function') {
    throw new Error('outreach: discoverContacts requires a searchProvider(query) function — see resolveSearchProvider()');
  }
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  const job = state.jobs[jobKey];
  if (!job) throw new Error(`outreach: no durable state for job_key ${jobKey}`);
  if (!job.outreach || job.outreach.status !== 'SEARCH_REQUIRED') {
    throw new Error(`outreach: ${jobKey} outreach.status=${job.outreach?.status ?? '(none)'} — expected SEARCH_REQUIRED`);
  }

  const persona = classifyRoleFamily(job.title);
  const queries = capQueriesPerLane(buildDiscoveryQueries({ company: job.company, persona }));

  const rawByLane = [];
  for (const { lane, query } of queries) {
    const results = await searchProvider(query);
    for (const raw of results || []) rawByLane.push({ raw, lane });
  }

  const normalized = rawByLane
    .map(({ raw, lane }) => normalizeCandidate(raw, { company: job.company, lane }))
    .filter(Boolean);
  const deduped = dedupeCandidates(normalized);
  const ranked = rankCandidates(deduped, { company: job.company, persona });

  return withJobState(jobKey, (freshJob) => {
    if (!freshJob.outreach || freshJob.outreach.status !== 'SEARCH_REQUIRED') {
      throw new Error(`outreach: ${jobKey} outreach.status changed to ${freshJob.outreach?.status} before discovery finished — re-run discover`);
    }
    freshJob.outreach.candidates = ranked;
    freshJob.outreach.status = 'CANDIDATES_FOUND';
    return { persona, queries, candidates: ranked, outreach: { ...freshJob.outreach } };
  }, { root });
}

/**
 * Human contact selection: copy the chosen candidates (by candidate_id) into
 * outreach.selected_contacts and move to CONTACTS_SELECTED. No hard
 * count requirement (task explicitly says not to require exact counts).
 *
 * A candidate_id already present in job.outreach.selected_contacts that is
 * NOT in the discovered outreach.candidates pool (a manually-added contact,
 * or one added outside discovery entirely — e.g. Pass 6's reconciled sheet
 * contacts) is preserved verbatim rather than validated against the pool:
 * it was never discovery output, so "unknown candidate id" is the wrong
 * failure mode for re-saving a selection that still includes it, and
 * rebuilding it via freshContactAction() would wipe its real
 * status/channel/next_action history. Only a genuinely new id that is in
 * neither the pool nor the existing selection still fails loudly.
 *
 * @param {string} jobKey
 * @param {string[]} candidateIds
 */
export async function selectContacts(jobKey, candidateIds, { root = DATA_ROOT } = {}) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new Error('outreach: selectContacts requires at least one candidate id');
  }
  return withJobState(jobKey, (job) => {
    if (!job.outreach || !['CANDIDATES_FOUND', 'CONTACTS_SELECTED'].includes(job.outreach.status)) {
      throw new Error(`outreach: ${jobKey} outreach.status=${job.outreach?.status ?? '(none)'} — expected CANDIDATES_FOUND`);
    }
    const byId = new Map(job.outreach.candidates.map((c) => [c.candidate_id, c]));
    const preservedById = new Map(
      (job.outreach.selected_contacts || [])
        .filter((c) => !byId.has(c.candidate_id))
        .map((c) => [c.candidate_id, c])
    );
    const missing = candidateIds.filter((id) => !byId.has(id) && !preservedById.has(id));
    if (missing.length) {
      throw new Error(`outreach: ${jobKey} — unknown candidate id(s): ${missing.join(', ')}`);
    }
    job.outreach.selected_contacts = candidateIds.map((id) =>
      byId.has(id) ? { ...freshContactAction(), ...byId.get(id) } : preservedById.get(id)
    );
    job.outreach.status = 'CONTACTS_SELECTED';
    return { ...job.outreach };
  }, { root });
}

/**
 * Derive the operator's Home queue from durable state — no second source of
 * truth (docs/careerops-state-model.md's Pass 4 addendum, extended by the
 * Pass 5 scope amendment). Every job's outreach.selected_contacts is the
 * read model for per-contact rows; the OVERDUE/TODAY/UPCOMING/WAITING bucket
 * is computed at read time from each contact's own
 * status/next_action/next_action_due (followup-schema.mjs's deriveBucket).
 * `today` is injectable for deterministic tests.
 *
 * Scoped to execution_status === 'APPLIED' — Home represents live submitted
 * applications only, never a READY_TO_APPLY/NONE/PASS/INVESTIGATE job.
 *
 * Pass 5 amendment: "every live application is represented on Home" is now
 * unconditional, not merely "whichever jobs happen to have a pending contact
 * action." A job contributes its real per-contact rows when it has any; when
 * it has none (outreach not started, fully resolved, or WAIVED with no
 * contacts at all) it instead gets exactly one synthetic
 * WAITING/APPLICATION_PENDING placeholder (buildApplicationPendingAction) so
 * the application itself never silently disappears from the board. Both
 * builders apply the same closed-application suppression, so a closed job
 * contributes neither kind of row.
 *
 * @param {{root?: string, today?: string}} [opts]
 */
export function listFollowUpActions({ root = DATA_ROOT, today = localToday() } = {}) {
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  const actions = [];
  for (const [jobKey, job] of Object.entries(state.jobs)) {
    if (job.execution_status !== 'APPLIED') continue;
    let hasAction = false;
    for (const contact of job.outreach?.selected_contacts || []) {
      const action = buildFollowUpAction({ jobKey, job, contact, todayStr: today });
      if (action) { actions.push(action); hasAction = true; }
    }
    if (!hasAction) {
      const pending = buildApplicationPendingAction({ jobKey, job });
      if (pending) actions.push(pending);
    }
  }
  return sortFollowUpActions(actions);
}

/**
 * Resolve a follow-up action_id back to its (job_key, contact index) by
 * recomputing followUpActionId() over every current candidate — action_id
 * is a one-way hash (see followup-schema.mjs), so this is the lookup
 * instead of a second id->record table that could drift.
 */
function findFollowUpTarget(state, targetActionId) {
  for (const [jobKey, job] of Object.entries(state.jobs)) {
    const contacts = job.outreach?.selected_contacts || [];
    for (let i = 0; i < contacts.length; i++) {
      if (followUpActionId(jobKey, contacts[i].candidate_id) === targetActionId) {
        return { jobKey, index: i };
      }
    }
  }
  return null;
}

/**
 * Mark Done: resolves the CURRENT action on this contact. Never chains to a
 * next action automatically (no follow-up-generation engine in this pass).
 * If the contact's status was still CONTACT_SELECTED, this action WAS the
 * initial outreach, so it also transitions CONTACT_SELECTED -> OUTREACH_SENT
 * and stamps sent_at; any other status is left as-is.
 *
 * @param {string} targetActionId
 */
export async function completeFollowUpAction(targetActionId, { root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  return withPipelineLock(p.statePath, async () => {
    const state = readJson(p.statePath, defaultState());
    const target = findFollowUpTarget(state, targetActionId);
    if (!target) throw new Error(`follow-up: no action found for action_id ${targetActionId}`);
    const job = state.jobs[target.jobKey];
    const contact = withContactActionDefaults(job.outreach.selected_contacts[target.index]);
    const now = new Date().toISOString();
    contact.last_action_at = now;
    contact.next_action = null;
    contact.next_action_due = null;
    if (contact.status === 'CONTACT_SELECTED') {
      contact.status = 'OUTREACH_SENT';
      contact.sent_at = now;
    }
    job.outreach.selected_contacts[target.index] = contact;
    state.updated_at = now;
    atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
    return { job_key: target.jobKey, contact: { ...contact } };
  });
}

/**
 * Skip: no snooze, no rescheduling — the contact's action is simply
 * dismissed and the row disappears from the queue.
 *
 * @param {string} targetActionId
 */
export async function skipFollowUpAction(targetActionId, { root = DATA_ROOT } = {}) {
  const p = reviewPaths(root);
  return withPipelineLock(p.statePath, async () => {
    const state = readJson(p.statePath, defaultState());
    const target = findFollowUpTarget(state, targetActionId);
    if (!target) throw new Error(`follow-up: no action found for action_id ${targetActionId}`);
    const job = state.jobs[target.jobKey];
    const contact = withContactActionDefaults(job.outreach.selected_contacts[target.index]);
    const now = new Date().toISOString();
    contact.status = 'SKIPPED';
    contact.last_action_at = now;
    contact.next_action = null;
    contact.next_action_due = null;
    job.outreach.selected_contacts[target.index] = contact;
    state.updated_at = now;
    atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
    return { job_key: target.jobKey, contact: { ...contact } };
  });
}

/**
 * Home inline editing: change a real contact's next_action/next_action_due
 * directly — the same two fields deriveBucket() (followup-schema.mjs) reads
 * to compute that contact's OVERDUE/TODAY/UPCOMING/WAITING bucket, so Status
 * recomputes on the very next read with no separate step. Resolves
 * targetActionId via the identical one-way-hash lookup completeFollowUpAction
 * /skipFollowUpAction already use (findFollowUpTarget), so this can only ever
 * touch the ONE contact that action_id names — a job's other (folded)
 * contacts are untouched by construction, not by convention.
 *
 * A synthetic APPLICATION_PENDING row's 'ap-' id never resolves here (it
 * names no selected_contacts entry), so this correctly refuses to invent a
 * contact for a job that has none — the caller (ui-server.mjs's route) is
 * expected to only offer this control on a row with a real contact_id.
 *
 * `nextAction === null` clears both fields together — a due date with no
 * action is display-meaningless (nothing would show in Home's "Next Action"
 * column to explain why a date is there), so there is no canonical reason
 * to keep one without the other, per this pass's stated default.
 *
 * @param {string} targetActionId
 * @param {{nextAction: string|null, nextActionDue?: string|null}} edit
 */
export async function updateFollowUpAction(targetActionId, { nextAction, nextActionDue = null }, { root = DATA_ROOT } = {}) {
  if (nextAction !== null && !NEXT_ACTIONS.includes(nextAction)) {
    throw new Error(`outreach: updateFollowUpAction invalid next_action "${nextAction}" — must be one of ${NEXT_ACTIONS.join(', ')}, or null`);
  }
  const due = nextAction === null ? null : (nextActionDue || null);
  if (due !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(new Date(`${due}T00:00:00`).getTime())) {
      throw new Error(`outreach: updateFollowUpAction next_action_due "${due}" is not a valid YYYY-MM-DD date`);
    }
  }
  const p = reviewPaths(root);
  return withPipelineLock(p.statePath, async () => {
    const state = readJson(p.statePath, defaultState());
    const target = findFollowUpTarget(state, targetActionId);
    if (!target) throw new Error(`follow-up: no action found for action_id ${targetActionId}`);
    const job = state.jobs[target.jobKey];
    const contact = withContactActionDefaults(job.outreach.selected_contacts[target.index]);
    contact.next_action = nextAction;
    contact.next_action_due = due;
    contact.last_action_at = new Date().toISOString();
    job.outreach.selected_contacts[target.index] = contact;
    state.updated_at = new Date().toISOString();
    atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
    return { job_key: target.jobKey, contact: { ...contact } };
  });
}

/**
 * Home inline editing: change a job's hiring-process stage
 * (application_stage) from Home without touching application_status/outcome
 * — a deliberately narrower sibling of updateApplicationStatus() above, for
 * the axis this pass actually needs to edit. `stage` must be one of
 * application-schema.mjs's HIRING_STAGES (isKnownHiringStage) — an existing
 * out-of-list value (e.g. a historical "Recruiter Routing") is left exactly
 * as-is unless the caller explicitly requests one of the canonical stages;
 * this function never invents a wider stage vocabulary or a new stage-state
 * engine, it only ever writes the one flat field.
 *
 * @param {string} jobKey
 * @param {string} stage - one of HIRING_STAGES
 */
export async function updateApplicationStage(jobKey, stage, { root = DATA_ROOT } = {}) {
  if (!isKnownHiringStage(stage)) {
    throw new Error(`outreach: updateApplicationStage invalid stage "${stage}" — must be one of ${HIRING_STAGES.join(', ')}`);
  }
  return withJobState(jobKey, (job) => {
    if (job.execution_status !== 'APPLIED') {
      throw new Error(`outreach: ${jobKey} has execution_status=${job.execution_status}, not APPLIED — cannot update stage`);
    }
    job.application_stage = stage;
    return { job_key: jobKey, application_stage: job.application_stage };
  }, { root });
}

/**
 * Home operating-metadata MVP: patch a job's Priority/Last Touch/Next
 * Action/Waiting On/Follow-Up Due/Notes — the same operating loop the user's
 * Action Board spreadsheet ran, moved onto the applied job itself so it
 * works even when the job has no contact yet (see followup-schema.mjs's
 * buildHomeRows for how these fields override the contact-derived display).
 *
 * `patch` is a genuine PATCH: only keys present are written, so a caller
 * editing just `notes` cannot accidentally clear `priority`. To explicitly
 * clear a field, pass it as `null` (or `''`, normalized to `null`) —
 * omitting the key entirely leaves it untouched. Repeating the same patch is
 * a safe no-op (idempotent), and every field not named in OPERATING_FIELDS
 * (fit_decision, execution_status, outreach, ...) is left byte-for-byte
 * alone because `mutate` only ever assigns `job.operating`.
 *
 * @param {string} jobKey
 * @param {{priority?: string|null, last_touch?: string|null, next_action?: string|null, waiting_on?: string|null, follow_up_due?: string|null, notes?: string|null}} patch
 */
export async function updateJobOperatingMetadata(jobKey, patch, { root = DATA_ROOT } = {}) {
  const p = patch || {};
  for (const key of Object.keys(p)) {
    if (!OPERATING_FIELDS.includes(key)) {
      throw new Error(`outreach: updateJobOperatingMetadata unknown field "${key}" — must be one of ${OPERATING_FIELDS.join(', ')}`);
    }
  }
  if ('priority' in p && p.priority != null && p.priority !== '' && !isValidPriority(p.priority)) {
    throw new Error(`outreach: updateJobOperatingMetadata invalid priority "${p.priority}" — must be one of P0, P1, P2, P3, —, or null`);
  }
  for (const field of OPERATING_DATE_FIELDS) {
    if (field in p && p[field] != null && p[field] !== '' && !isValidDateStr(p[field])) {
      throw new Error(`outreach: updateJobOperatingMetadata ${field} "${p[field]}" is not a valid YYYY-MM-DD date`);
    }
  }
  for (const field of OPERATING_TEXT_FIELDS) {
    if (field in p && p[field] != null && String(p[field]).length > MAX_OPERATING_TEXT_LEN) {
      throw new Error(`outreach: updateJobOperatingMetadata ${field} exceeds ${MAX_OPERATING_TEXT_LEN} characters`);
    }
  }
  return withJobState(jobKey, (job) => {
    if (job.execution_status !== 'APPLIED') {
      throw new Error(`outreach: ${jobKey} has execution_status=${job.execution_status}, not APPLIED — cannot update operating metadata`);
    }
    const current = withOperatingDefaults(job.operating);
    const next = { ...current };
    for (const field of OPERATING_FIELDS) {
      if (field in p) next[field] = p[field] === '' ? null : p[field];
    }
    job.operating = next;
    return { job_key: jobKey, operating: { ...job.operating } };
  }, { root });
}

/**
 * List every job with an outreach record, optionally filtered. Distinguishes
 * REQUIRED/SEARCH_REQUIRED from REQUIRED/CANDIDATES_FOUND from
 * OPTIONAL/NOT_STARTED, per the task's explicit anti-forgotten-row goal.
 *
 * @param {{root?: string, filter?: 'required-search'|'required-found'|'optional'}} [opts]
 */
export function listOutreach({ root = DATA_ROOT, filter } = {}) {
  const p = reviewPaths(root);
  const state = readJson(p.statePath, defaultState());
  let entries = Object.entries(state.jobs)
    .filter(([, job]) => job.outreach)
    .map(([jobKey, job]) => ({
      job_key: jobKey,
      company: job.company,
      title: job.title,
      execution_status: job.execution_status,
      decision: job.outreach.decision,
      status: job.outreach.status,
    }));
  if (filter === 'required-search') entries = entries.filter((e) => e.decision === 'REQUIRED' && e.status === 'SEARCH_REQUIRED');
  else if (filter === 'required-found') entries = entries.filter((e) => e.decision === 'REQUIRED' && e.status === 'CANDIDATES_FOUND');
  else if (filter === 'optional') entries = entries.filter((e) => e.decision === 'OPTIONAL');
  return entries;
}

// ── Search provider resolution (CLI only — library callers pass their own) ─

/**
 * Resolves a search provider for the CLI:
 *   1. CAREER_OPS_SEARCH_PROVIDER, if set, names a module path whose default
 *      export is an async function (query) => rawResult[] — an explicit
 *      override always wins, so a different provider can be dropped in
 *      later without touching this file.
 *   2. Otherwise, if SERPER_API_KEY is set (.env or environment), the
 *      built-in lib/outreach-search-serper.mjs is used — the one real
 *      provider wired for this MVP (Pass 2B).
 *   3. Otherwise, discovery cannot run. Throwing a clear explanation is
 *      preferred over silently returning zero candidates, which would look
 *      like "nobody found" rather than "not configured".
 */
export async function resolveSearchProvider() {
  const modulePath = process.env.CAREER_OPS_SEARCH_PROVIDER;
  if (modulePath) {
    const resolved = path.isAbsolute(modulePath) ? modulePath : path.join(DATA_ROOT, modulePath);
    const mod = await import(`file://${resolved.replace(/\\/g, '/')}`);
    if (typeof mod.default !== 'function') {
      throw new Error(`outreach: ${modulePath} does not export a default async function`);
    }
    return mod.default;
  }
  if (process.env.SERPER_API_KEY) {
    const mod = await import('./lib/outreach-search-serper.mjs');
    return mod.default;
  }
  throw new Error(
    'outreach: no search provider configured. Set SERPER_API_KEY in your career-ops data ' +
    'root\'s .env (see .env.example, https://serper.dev for a key) to use the built-in Serper ' +
    'provider, or set CAREER_OPS_SEARCH_PROVIDER to a module path whose default export is ' +
    'async (query) => [{title, url, snippet}, ...] to use a different one.',
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function promptOutreachDecision() {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('\nApplication marked APPLIED.\n\nOutreach?\n[R] Required\n[O] Optional\n[W] Waive\n\n> ')).trim().toLowerCase();
    if (answer.startsWith('r')) return 'REQUIRED';
    if (answer.startsWith('o')) return 'OPTIONAL';
    if (answer.startsWith('w')) return 'WAIVED';
    return null;
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'applied') {
    const jobKey = argv[1];
    if (!jobKey) { console.error('Usage: node outreach.mjs applied <job_key> [--outreach required|optional|waived] [--applied-at ISO date]'); process.exitCode = 1; return; }
    const reviewer = flagValue(argv, '--reviewer') || null;
    const appliedAt = flagValue(argv, '--applied-at') || null;
    const { alreadyApplied, job } = await markApplied(jobKey, { reviewer, appliedAt });
    console.log(alreadyApplied
      ? `${jobKey} is already APPLIED (applied_at: ${job.applied_at}).`
      : `Application marked APPLIED. execution_status=APPLIED, applied_at=${job.applied_at}`);

    let decisionFlag = (flagValue(argv, '--outreach') || '').toUpperCase();
    if (!decisionFlag && !alreadyApplied) decisionFlag = (await promptOutreachDecision()) || '';
    if (decisionFlag) {
      if (!['REQUIRED', 'OPTIONAL', 'WAIVED'].includes(decisionFlag)) {
        console.error(`Unknown --outreach value "${decisionFlag}" — expected required, optional, or waived. Decision left PENDING; run 'node outreach.mjs decide ${jobKey} <required|optional|waived>'.`);
        return;
      }
      const outreach = await setOutreachDecision(jobKey, decisionFlag, {});
      console.log(`outreach.decision=${outreach.decision}, outreach.status=${outreach.status}`);
    } else if (!alreadyApplied) {
      console.log(`outreach.decision=PENDING. Resolve later: node outreach.mjs decide ${jobKey} <required|optional|waived>`);
    }
    return;
  }

  if (cmd === 'pass') {
    const jobKey = argv[1];
    if (!jobKey) { console.error('Usage: node outreach.mjs pass <job_key>'); process.exitCode = 1; return; }
    const { alreadyPassed, job } = await passOnApplication(jobKey, {});
    console.log(alreadyPassed
      ? `${jobKey} is already NOT_APPLYING (closed_at: ${job.closed_at}).`
      : `Application passed. execution_status=NOT_APPLYING, closed_at=${job.closed_at}, closed_reason=${job.closed_reason}`);
    return;
  }

  if (cmd === 'decide') {
    const [, jobKey, decision] = argv;
    if (!jobKey || !decision) { console.error('Usage: node outreach.mjs decide <job_key> <required|optional|waived>'); process.exitCode = 1; return; }
    const outreach = await setOutreachDecision(jobKey, decision.toUpperCase(), {});
    console.log(`outreach.decision=${outreach.decision}, outreach.status=${outreach.status}`);
    return;
  }

  if (cmd === 'start') {
    const jobKey = argv[1];
    if (!jobKey) { console.error('Usage: node outreach.mjs start <job_key>'); process.exitCode = 1; return; }
    const { alreadyStarted, outreach } = await startOutreach(jobKey, {});
    console.log(alreadyStarted
      ? `${jobKey} outreach is already past NOT_STARTED (status=${outreach.status}).`
      : `outreach.status=${outreach.status}`);
    return;
  }

  if (cmd === 'discover') {
    const jobKey = argv[1];
    if (!jobKey) { console.error('Usage: node outreach.mjs discover <job_key>'); process.exitCode = 1; return; }
    const searchProvider = await resolveSearchProvider();
    const { candidates } = await discoverContacts(jobKey, { searchProvider });
    const recruiting = candidates.filter((c) => c.lane === 'RECRUITING');
    const functional = candidates.filter((c) => c.lane === 'FUNCTIONAL');
    console.log('RECRUITING');
    recruiting.forEach((c, i) => console.log(`${i + 1}. ${c.candidate_id}  ${c.name} — ${c.title || '(title unknown)'}  ${c.linkedin_url} (score ${c.score})`));
    console.log('\nFUNCTIONAL');
    functional.forEach((c, i) => console.log(`${recruiting.length + i + 1}. ${c.candidate_id}  ${c.name} — ${c.title || '(title unknown)'}  ${c.linkedin_url} (score ${c.score})`));
    return;
  }

  if (cmd === 'select') {
    const [, jobKey, ...ids] = argv;
    if (!jobKey || ids.length === 0) { console.error('Usage: node outreach.mjs select <job_key> <candidate_id...>'); process.exitCode = 1; return; }
    const outreach = await selectContacts(jobKey, ids, {});
    console.log(`outreach.status=${outreach.status}; selected: ${outreach.selected_contacts.map((c) => `${c.name} (${c.lane})`).join(', ')}`);
    return;
  }

  if (cmd === 'list') {
    const filterRaw = flagValue(argv, '--filter');
    const entries = listOutreach({ filter: filterRaw });
    if (entries.length === 0) { console.log('No outreach records.'); return; }
    for (const e of entries) {
      console.log(`${e.job_key}\t${e.company} — ${e.title}\t${e.decision}/${e.status}`);
    }
    return;
  }

  console.log(`Usage:
  node outreach.mjs applied <job_key> [--outreach required|optional|waived] [--reviewer name]
  node outreach.mjs pass <job_key>
  node outreach.mjs decide <job_key> <required|optional|waived>
  node outreach.mjs start <job_key>
  node outreach.mjs discover <job_key>
  node outreach.mjs select <job_key> <candidate_id...>
  node outreach.mjs list [--filter required-search|required-found|optional]`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`outreach.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
