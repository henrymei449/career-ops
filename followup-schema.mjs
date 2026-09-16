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

export const CONTACT_STATUSES = ['CONTACT_SELECTED', 'OUTREACH_SENT', 'REPLIED', 'COMPLETE', 'SKIPPED'];
export const NEXT_ACTIONS = ['SEND_EMAIL', 'SEND_MESSAGE', 'CHECK_CONNECTION', 'FOLLOW_UP'];
export const FOLLOWUP_BUCKETS = ['OVERDUE', 'TODAY', 'UPCOMING', 'WAITING'];

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
  };
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
