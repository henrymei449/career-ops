// application-schema.mjs — canonical vocabulary for the application lifecycle
// axis of a durable CareerOps job record (data/review-state.json).
//
// Extends the existing job record additively, the same way outreach-schema.mjs
// extends it with an `outreach` sub-object: this module adds four flat fields
// application_status / application_stage / application_last_update /
// application_outcome, plus an optional `legacy_sheet` provenance block for a
// record whose lifecycle truth originates outside CareerOps (a migrated
// external tracker row) rather than the review/outreach state machine above.
//
// Pure data/validation functions only — no filesystem access here, mirroring
// review-schema.mjs's own split from review.mjs.

// Canonical, deliberately small — mirrors templates/states.yml's convention
// of one closed vocabulary as the source of truth, kept separate from that
// file because it describes a different axis (the *application's* real-world
// lifecycle, not the CareerOps review/execution decision).
export const APPLICATION_STATUSES = ['ACTIVE', 'REJECTED', 'CLOSED', 'STALE', 'WITHDRAWN', 'UNKNOWN'];

/**
 * Conservative mapping from an external tracker's free-text status into the
 * canonical vocabulary above. Never invents a lifecycle conclusion the
 * source text doesn't support — anything not explicitly recognized maps to
 * UNKNOWN rather than being guessed into ACTIVE/CLOSED/etc.
 *
 * @param {string} rawStatus
 * @returns {'ACTIVE'|'REJECTED'|'CLOSED'|'STALE'|'WITHDRAWN'|'UNKNOWN'}
 */
export function mapSheetApplicationStatus(rawStatus) {
  const s = String(rawStatus ?? '').trim().toLowerCase();
  if (!s) return 'UNKNOWN';
  if (s === 'rejected') return 'REJECTED';
  if (s === 'closed') return 'CLOSED';
  if (s === 'withdrawn') return 'WITHDRAWN';
  if (s === 'active' || s === 'pending') return 'ACTIVE';
  if (s.startsWith('stale') || s.includes('unverified')) return 'STALE';
  return 'UNKNOWN';
}

/**
 * Build the `legacy_sheet` provenance block attached to a job record created
 * or enriched from an external tracker row. Kept as a single well-labeled
 * object (never merged into the top-level record) so a reader can always
 * tell "this is imported evidence" from "this is CareerOps-native state."
 *
 * @param {object} row - source row fields, already in this shape.
 */
export function buildLegacySheetMeta(row) {
  return {
    source: row.source ?? '',
    sheet_row_id: row.sheetRowId ?? null,
    applied_date_raw: row.appliedDateRaw ?? '',
    application_source: row.applicationSource ?? '',
    fit_bucket: row.fitBucket ?? '',
    geography: row.geography ?? '',
    status_raw: row.statusRaw ?? '',
    stage_raw: row.stageRaw ?? '',
    last_update_raw: row.lastUpdateRaw ?? '',
    outreach_status_raw: row.outreachStatusRaw ?? '',
    outreach_date_raw: row.outreachDateRaw ?? '',
    follow_up_due_raw: row.followUpDueRaw ?? '',
    next_action_raw: row.nextActionRaw ?? '',
    outcome_raw: row.outcomeRaw ?? '',
    evidence: row.evidence ?? '',
    notes: row.notes ?? '',
    migrated_at: row.migratedAt ?? new Date().toISOString(),
  };
}
