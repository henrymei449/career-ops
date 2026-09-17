// followup-schema.mjs — pure data model, bucket derivation, and action
// assembly for the Pass 4 Follow-up dashboard. No filesystem access here,
// mirroring outreach-schema.mjs's own split: this file defines "what is a
// valid contact-action" and "which bucket does it belong in today";
// outreach.mjs's listFollowUpActions/completeFollowUpAction/
// skipFollowUpAction own reading and mutating data/review-state.json.
//
// Design lock (career-ops Pass 4 spec): CONTACT_STATUSES are durable states
// stored on outreach.selected_contacts[i]; OVERDUE/TODAY/UPCOMING/WAITING
// are DERIVED read-time buckets, never persisted — there is exactly one
// source of truth (the contact's own status/next_action/next_action_due),
// and the Follow-up queue is a view over it, not a second store.
//
// Pass 5 extends the same derived-view discipline several ways, all
// read-time only, none adding a new durable field:
//   - deriveOutreachCompletion(): the job-level outreach completion badge
//     (COMPLETE/IN_PROGRESS) is computed from selected_contacts, never
//     written back — see its own doc comment below.
//   - buildFollowUpAction() suppresses a row once the job's application is
//     closed (REJECTED/CLOSED/WITHDRAWN), so a dead application stops
//     generating operator work without ever touching the contact's own
//     status (never manufactures SKIPPED history).
//   - buildApplicationPendingAction() (the Pass 5 scope amendment): the
//     Follow-up tab becomes Home, the operator's single live-application
//     board. Every non-terminal APPLIED job must be represented there even
//     when it has no explicit contact action right now — this synthesizes
//     the display-only WAITING/APPLICATION_PENDING fallback row for exactly
//     that case. See outreach.mjs's listFollowUpActions for where the two
//     row kinds (real per-contact actions vs. this fallback) are combined.

import { APPLICATION_CLOSED_STATUSES } from './application-schema.mjs';
import { localToday } from './lib/local-today.mjs';

export const CONTACT_STATUSES = ['CONTACT_SELECTED', 'OUTREACH_SENT', 'REPLIED', 'COMPLETE', 'SKIPPED'];
export const NEXT_ACTIONS = ['SEND_EMAIL', 'SEND_MESSAGE', 'CHECK_CONNECTION', 'FOLLOW_UP'];
export const FOLLOWUP_BUCKETS = ['OVERDUE', 'TODAY', 'UPCOMING', 'WAITING'];

// Contact statuses that count as "executed/dispositioned" for job-level
// outreach completion — the operator has actually done something with this
// contact, as opposed to merely having selected them.
export const EXECUTED_CONTACT_STATUSES = ['OUTREACH_SENT', 'COMPLETE', 'SKIPPED', 'REPLIED'];

/** Fresh contact-action fields for a newly-selected contact. */
export function freshContactAction() {
  return {
    status: 'CONTACT_SELECTED',
    channel: null,
    sent_at: null,
    replied_at: null,
    last_action_at: null,
    next_action: null,
    next_action_due: null,
  };
}

/**
 * Backfill missing contact-action fields without overwriting any already
 * present. Every selected_contacts entry written before Pass 4 has none of
 * these fields — defaulting them here (rather than migrating the file) is
 * what keeps every untouched historical contact producing NO follow-up row:
 * CONTACT_SELECTED + next_action=null matches neither actionable rule in
 * deriveBucket() below.
 */
export function withContactActionDefaults(contact) {
  return { ...freshContactAction(), ...contact };
}

/**
 * Which of the 4 derived buckets a contact belongs in today, or null if it
 * is not actionable right now.
 *
 * A next_action with a due date buckets by date (OVERDUE/TODAY/UPCOMING).
 * A next_action assigned but with NO due date yet (e.g. a real-world
 * "check if they accepted the LinkedIn invite" with no fabricated deadline)
 * still surfaces as WAITING as long as the contact's status is
 * OUTREACH_SENT — this is a deliberate minimal choice: the Pass 4 spec's
 * production seed data explicitly forbids inventing a due date for a
 * CHECK_CONNECTION action that has none, but its own acceptance test still
 * expects that contact to show up as a "sent/waiting" row. Falling through
 * to WAITING (rather than hiding the row) is what satisfies both.
 *
 * @param {object} contact - already passed through withContactActionDefaults
 * @param {string} todayStr - YYYY-MM-DD, from lib/local-today.mjs
 */
export function deriveBucket(contact, todayStr) {
  if (contact.status === 'COMPLETE' || contact.status === 'SKIPPED') return null;
  if (contact.next_action && contact.next_action_due) {
    if (contact.next_action_due < todayStr) return 'OVERDUE';
    if (contact.next_action_due === todayStr) return 'TODAY';
    return 'UPCOMING';
  }
  if (contact.status === 'OUTREACH_SENT') return 'WAITING';
  return null;
}

/**
 * Short, stable local id for one (job, contact) follow-up action — the same
 * imul-hash shape outreach-schema.mjs's candidateId() uses. One-way by
 * design: resolving an action_id back to its job/contact means recomputing
 * this hash over the current state (see outreach.mjs's findFollowUpTarget),
 * never a second id->record table that could drift out of sync.
 */
export function actionId(jobKey, candidateId) {
  const s = `${jobKey}::${candidateId}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `fu-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Assemble one operator-facing follow-up row from a job + one of its
 * selected_contacts. Returns null if the contact is not currently
 * actionable (see deriveBucket).
 *
 * @param {{jobKey: string, job: object, contact: object, todayStr: string}} args
 */
export function buildFollowUpAction({ jobKey, job, contact, todayStr }) {
  // A closed/dead application generates no operator work — suppressed at
  // read time only. The contact's own status/next_action are left exactly
  // as they were, so re-opening the application (Applications -> Update
  // Status -> ACTIVE) makes the row reappear with its real history intact.
  const applicationStatus = job.application_status || 'ACTIVE';
  if (APPLICATION_CLOSED_STATUSES.includes(applicationStatus)) return null;

  const withDefaults = withContactActionDefaults(contact);
  const bucket = deriveBucket(withDefaults, todayStr);
  if (!bucket) return null;
  return {
    action_id: actionId(jobKey, contact.candidate_id),
    job_key: jobKey,
    company: job.company,
    role: job.title,
    contact_id: contact.candidate_id,
    contact_name: contact.name,
    contact_role: contact.title || '',
    action: withDefaults.next_action,
    channel: withDefaults.channel,
    due_at: withDefaults.next_action_due,
    bucket,
    contact_status: withDefaults.status,
    application_status: job.application_status || 'ACTIVE',
    application_stage: job.application_stage || 'Applied',
    applied_at: job.applied_at || null,
    operating: withOperatingDefaults(job.operating),
    outreach_decision: job.outreach?.decision || null,
    outreach_status: job.outreach?.status || null,
  };
}

/**
 * Stable id for the synthetic "no explicit action yet" Home row a live
 * APPLIED application gets when none of its selected_contacts currently
 * produce an actionable row (see outreach.mjs's listFollowUpActions). Same
 * one-way imul-hash shape as actionId()/candidateId(), namespaced 'ap-'
 * (never 'fu-') so a synthetic row's id can never collide with, or be
 * mistaken for, a real per-contact action id — completeFollowUpAction/
 * skipFollowUpAction correctly fail to resolve it (there is no contact to
 * act on; the row is display-only).
 */
export function applicationPendingActionId(jobKey) {
  const s = String(jobKey ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `ap-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Home-row fallback (Pass 5 scope amendment): a live, non-terminal APPLIED
 * application with no current explicit contact action still needs to be
 * represented on Home — "every live submitted application accounted for" is
 * a hard requirement now, not merely a follow-up-if-outreach-needs-it view.
 * APPLICATION_PENDING is a derived Home label only, never written back as a
 * durable application or contact status, and this row has nothing for Mark
 * Done/Skip to act on (contact_id is null).
 *
 * Same closure suppression as buildFollowUpAction: a closed application
 * (REJECTED/CLOSED/WITHDRAWN) gets no row here either.
 *
 * @param {{jobKey: string, job: object}} args
 */
export function buildApplicationPendingAction({ jobKey, job }) {
  const applicationStatus = job.application_status || 'ACTIVE';
  if (APPLICATION_CLOSED_STATUSES.includes(applicationStatus)) return null;
  return {
    action_id: applicationPendingActionId(jobKey),
    job_key: jobKey,
    company: job.company,
    role: job.title,
    contact_id: null,
    contact_name: null,
    contact_role: '',
    action: 'APPLICATION_PENDING',
    channel: null,
    due_at: null,
    bucket: 'WAITING',
    contact_status: null,
    application_status: applicationStatus,
    application_stage: job.application_stage || 'Applied',
    applied_at: job.applied_at || null,
    operating: withOperatingDefaults(job.operating),
    outreach_decision: job.outreach?.decision || null,
    outreach_status: job.outreach?.status || null,
  };
}

/**
 * Whether a job's outreach needs operator attention — the single predicate
 * shared by Home's OUTREACH NEEDED filter and the Outreach page's default
 * active-queue filter (AGENTS.md one-shot spec, Home section + Outreach P0
 * section): decision is REQUIRED or OPTIONAL (never PENDING — undecided is
 * not yet "needed", it is a decision to make first) and outreach hasn't
 * already reached COMPLETE (which also covers WAIVED, whose initial status
 * per outreach-schema.mjs's DECISION_INITIAL_STATUS is COMPLETE).
 *
 * @param {string|null} decision
 * @param {string|null} status
 */
export function isOutreachNeeded(decision, status) {
  return (decision === 'REQUIRED' || decision === 'OPTIONAL') && status !== 'COMPLETE';
}

const BUCKET_ORDER = { OVERDUE: 0, TODAY: 1, UPCOMING: 2, WAITING: 3 };

/** Stable queue order: bucket severity first, then due date, then action_id as a tie-breaker. */
export function sortFollowUpActions(actions) {
  return [...actions].sort((a, b) => {
    const cmp = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (cmp !== 0) return cmp;
    const dueCmp = String(a.due_at || '').localeCompare(String(b.due_at || ''));
    return dueCmp !== 0 ? dueCmp : a.action_id.localeCompare(b.action_id);
  });
}

/**
 * Job-level outreach completion (Pass 5): whether contact work is ACTUALLY
 * finished, derived from outreach.selected_contacts — never a second durable
 * status. "Save Selected Contacts" only sets outreach.status=CONTACTS_SELECTED
 * once, and that status never advances on its own as contacts get worked, so
 * a job could look permanently unfinished (or permanently "selected but
 * untouched") without this derivation.
 *
 * Only CONTACTS_SELECTED is re-derived — every other durable status already
 * says what it means (NOT_STARTED/SEARCH_REQUIRED/CANDIDATES_FOUND: no
 * contacts chosen yet; COMPLETE: already true, e.g. a WAIVED decision's
 * initial status per outreach-schema.mjs's DECISION_INITIAL_STATUS) and is
 * passed through unchanged.
 *
 *   any selected contact still CONTACT_SELECTED, or carrying a pending
 *   next_action (regardless of its own status) -> IN_PROGRESS
 *   every selected contact executed/dispositioned (EXECUTED_CONTACT_STATUSES)
 *   with no pending next_action -> COMPLETE
 *
 * @param {{status?: string, selected_contacts?: object[]}|null|undefined} outreach
 * @returns {string|null} one of OUTREACH_STATUSES, plus the derived
 *   'IN_PROGRESS' value, or null if there is no outreach record at all.
 */
export function deriveOutreachCompletion(outreach) {
  if (!outreach) return null;
  if (outreach.status !== 'CONTACTS_SELECTED') return outreach.status;
  const contacts = (outreach.selected_contacts || []).map(withContactActionDefaults);
  if (contacts.length === 0) return outreach.status; // defensive: CONTACTS_SELECTED implies contacts exist
  const hasPending = contacts.some((c) => c.status === 'CONTACT_SELECTED' || c.next_action != null);
  if (hasPending) return 'IN_PROGRESS';
  const allExecuted = contacts.every((c) => EXECUTED_CONTACT_STATUSES.includes(c.status));
  return allExecuted ? 'COMPLETE' : 'IN_PROGRESS';
}

// ── Job-level operating metadata (Home operating-board MVP) ──────────────
//
// The Action Board spreadsheet's operating loop (Last Touch -> Next Action
// -> Waiting On -> Follow-Up Due -> Notes) belongs to the APPLIED job itself,
// not to any one contact — a job with zero contacts still needs an operator
// action. `operating` is a small durable object stored directly on the job
// record (job.operating), read/written by outreach.mjs's
// updateJobOperatingMetadata; everything here is pure validation/defaulting,
// mirroring withContactActionDefaults' backfill-without-overwrite shape.

export const OPERATING_PRIORITIES = ['P0', 'P1', 'P2', 'P3', '—'];
export const OPERATING_TEXT_FIELDS = ['next_action', 'waiting_on', 'notes'];
export const OPERATING_DATE_FIELDS = ['last_touch', 'follow_up_due'];
export const OPERATING_FIELDS = ['priority', 'last_touch', 'next_action', 'waiting_on', 'follow_up_due', 'notes'];
export const MAX_OPERATING_TEXT_LEN = 500;

/** @param {string} p @returns {boolean} */
export function isValidPriority(p) {
  return OPERATING_PRIORITIES.includes(p);
}

/** @param {string} s @returns {boolean} true for a real, parseable YYYY-MM-DD date */
export function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
}

/** Fresh job-level operating fields for a job that has never had any set. */
export function freshOperating() {
  return { priority: null, last_touch: null, next_action: null, waiting_on: null, follow_up_due: null, notes: null };
}

/** Backfill missing operating fields without overwriting any already present — same pattern as withContactActionDefaults. */
export function withOperatingDefaults(operating) {
  return { ...freshOperating(), ...(operating || {}) };
}

/** OVERDUE/TODAY/UPCOMING for a raw due date against today, or null if there is no date. */
export function deriveDueBucket(dueDate, todayStr) {
  if (!dueDate) return null;
  if (dueDate < todayStr) return 'OVERDUE';
  if (dueDate === todayStr) return 'TODAY';
  return 'UPCOMING';
}

// ── Home job-level rows (presentation/aggregation patch) ────────────────
//
// listFollowUpActions() is deliberately granular: one row per (job, contact)
// action, plus at most one synthetic APPLICATION_PENDING fallback for a job
// with none. That is the correct source of truth for outreach work, but it
// is the wrong unit for Home, whose contract is "one row per applied job."
// The functions below are a pure read-time re-grouping of that same list —
// no new durable state, no change to what listFollowUpActions returns.

export const HOME_STATUSES = ['ACTION DUE', 'WAITING', 'STALE'];

/**
 * Priority for picking the single action a job-level Home row represents:
 * OVERDUE -> TODAY -> nearest UPCOMING -> an undated real (contact-backed)
 * WAITING action -> the synthetic no-action/WAITING fallback. A job's
 * fallback row and its real rows never coexist (listFollowUpActions only
 * emits the fallback when the job has zero real actionable rows), so the
 * real-vs-fallback tiebreak below is a documentation of intent more than a
 * case that occurs in practice.
 */
function homeActionRank(action) {
  const bucketRank = BUCKET_ORDER[action.bucket] ?? BUCKET_ORDER.WAITING;
  const isFallback = action.contact_id == null ? 1 : 0;
  return [bucketRank, isFallback];
}

/** Pick the one action a job's actions collapse to on Home. `jobActions` must be non-empty. */
export function selectHomeAction(jobActions) {
  return [...jobActions].sort((a, b) => {
    const [aBucket, aFallback] = homeActionRank(a);
    const [bBucket, bFallback] = homeActionRank(b);
    if (aBucket !== bBucket) return aBucket - bBucket;
    if (aFallback !== bFallback) return aFallback - bFallback;
    const dueCmp = String(a.due_at || '').localeCompare(String(b.due_at || ''));
    return dueCmp !== 0 ? dueCmp : a.action_id.localeCompare(b.action_id);
  })[0];
}

/**
 * Operator-facing status for a Home row. STALE reflects the job's own
 * durable application_status (set by historical-sheet migration or a future
 * staleness check — never invented here); otherwise ACTION DUE means the
 * EFFECTIVE due date (job-level operating.follow_up_due when set, else the
 * selected contact action's own due date — see buildHomeRows) is due now
 * (OVERDUE/TODAY), and everything else (an undated action, a future
 * UPCOMING date, or no action at all) is WAITING.
 *
 * @param {{application_status: string, bucket: string}} row - a value
 *   already carrying the EFFECTIVE bucket (buildHomeRows computes this
 *   before calling in), not necessarily the raw contact-action bucket.
 */
export function deriveHomeStatus(row) {
  if (row.application_status === 'STALE') return 'STALE';
  if (row.bucket === 'OVERDUE' || row.bucket === 'TODAY') return 'ACTION DUE';
  return 'WAITING';
}

/**
 * Group listFollowUpActions()'s granular actions into one row per job_key —
 * Home's required unit of work. Each row carries the full set of that job's
 * actions (`actions`) for row-detail rendering (Mark Done/Skip stay
 * per-contact, resolved against their own action_id, unchanged), plus
 * `extra_count` = how many additional actionable rows that job has beyond
 * the one selected to represent it, so the UI can show "(+N)" without
 * hiding that work exists.
 *
 * Display precedence (Home operating-metadata MVP): NEXT ACTION and
 * FOLLOW-UP are job-level operating fields FIRST, falling back to the
 * selected contact action's own action/due date when no job-level value is
 * set, and to null for a fallback (APPLICATION_PENDING) job with neither.
 * This is what lets a job with zero contacts still be managed from Home.
 * `bucket`/`status` are derived from that EFFECTIVE due date, not the raw
 * contact bucket, so setting a job-level Follow-Up Due recomputes severity
 * immediately (a job-level date has no precomputed bucket of its own — see
 * deriveDueBucket — while a contact-sourced date keeps the bucket
 * deriveBucket already computed against the same `todayStr`).
 *
 * @param {object[]} actions
 * @param {string} [todayStr] - YYYY-MM-DD; defaults to the local calendar day.
 */
export function buildHomeRows(actions, todayStr = localToday()) {
  const byJob = new Map();
  for (const action of actions) {
    if (!byJob.has(action.job_key)) byJob.set(action.job_key, []);
    byJob.get(action.job_key).push(action);
  }
  const rows = [];
  for (const [jobKey, jobActions] of byJob) {
    const primary = selectHomeAction(jobActions);
    const isFallback = primary.contact_id == null;
    const operating = withOperatingDefaults(primary.operating);

    const nextAction = operating.next_action || (isFallback ? null : primary.action);
    let dueAt;
    let bucket;
    if (operating.follow_up_due) {
      dueAt = operating.follow_up_due;
      bucket = deriveDueBucket(dueAt, todayStr) || 'WAITING';
    } else {
      dueAt = isFallback ? null : primary.due_at;
      bucket = primary.bucket;
    }

    const row = {
      job_key: jobKey,
      company: primary.company,
      role: primary.role,
      applied_at: primary.applied_at,
      application_stage: primary.application_stage,
      application_status: primary.application_status,
      priority: operating.priority || null,
      last_touch: operating.last_touch || null,
      waiting_on: operating.waiting_on || null,
      notes: operating.notes || null,
      // Raw job-level operating fields (unmerged) — for an editor to prefill
      // FROM, so a contact-derived fallback value never gets echoed back as
      // if it were a saved operating field. `next_action`/`due_at` below are
      // the DISPLAY/status values (job-level override, else contact
      // fallback); `contact_next_action`/`contact_due_at` are the raw
      // per-contact values alone, for the contact-level editor to prefill.
      operating,
      next_action: nextAction,
      due_at: dueAt,
      bucket,
      contact_next_action: isFallback ? null : primary.action,
      contact_due_at: isFallback ? null : primary.due_at,
      action_id: primary.action_id,
      contact_id: primary.contact_id,
      extra_count: jobActions.length - 1,
      actions: sortFollowUpActions(jobActions),
      outreach_decision: primary.outreach_decision,
      outreach_status: primary.outreach_status,
      home_kind: 'APPLIED',
    };
    row.status = deriveHomeStatus(row);
    rows.push(row);
  }
  return sortHomeRows(rows);
}

/** Stable Home order: same severity-first rule as sortFollowUpActions, applied to the one row per job. */
export function sortHomeRows(rows) {
  return [...rows].sort((a, b) => {
    const cmp = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (cmp !== 0) return cmp;
    const dueCmp = String(a.due_at || '').localeCompare(String(b.due_at || ''));
    return dueCmp !== 0 ? dueCmp : a.job_key.localeCompare(b.job_key);
  });
}
