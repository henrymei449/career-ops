#!/usr/bin/env node
/**
 * migrate-action-board-top8.mjs — one-time bounded migration of the current
 * top eight CAREEROPS-DASHBOARD Google Sheet Action Board rows (spreadsheet
 * 12PGKh8g-lDQ-KMT09MWwSsUJ1-iZja8ytRkc4dB8EEM, "Action Board" tab, read
 * 2026-09-16) into CareerOps job-level Home operating metadata
 * (outreach.mjs's updateJobOperatingMetadata / followup-schema.mjs's
 * OPERATING_FIELDS: priority, last_touch, next_action, waiting_on,
 * follow_up_due, notes).
 *
 * SOURCE_ROWS below is a fixed, checked-in snapshot of the Action Board's
 * Priority/Action/Company-Person/Related Role/Status/Priority/Due/Last
 * Touch/Next Action/Waiting On/Follow-Up Due/Notes columns for exactly the
 * eight rows named in the migration request — never re-scanned or re-synced
 * from here, same convention as migrate-historical-applications.mjs's
 * SOURCE_ROWS and reconcile-live-state.mjs's RECONCILIATION_SOURCE.
 * Next Action / Waiting On / Notes are copied verbatim — no paraphrasing,
 * no shortening.
 *
 * One canonical Home date only (see AGENTS.md's migration rule): the
 * Sheet's separate "Due" column is legacy source context, not a second Home
 * field. collapseDue() decides per row whether Due and Follow-Up Due are the
 * same operational date (collapse silently to Follow-Up Due) or materially
 * different (flag it — never guess, never silently overwrite either value).
 *
 * Elastic is the one row with no matching CareerOps job at all (not even
 * non-APPLIED) — see MANUAL_REVIEW_KEYS. updateJobOperatingMetadata() itself
 * refuses any job whose execution_status isn't APPLIED
 * (outreach.mjs:658-660), and there is no application_stage field anywhere
 * in the schema to preserve Elastic's "Recruiter Routing" context in — both
 * are pre-existing, deliberate constraints this migration does not touch
 * (out of scope: new Home schema architecture). Elastic is skipped, not
 * bypassed or faked into a job record.
 *
 * Idempotent by construction: updateJobOperatingMetadata is a full-value
 * PATCH keyed by the fields present, so re-running with the same
 * SOURCE_ROWS produces byte-identical `operating` objects (see
 * tests/migrate-action-board-top8.test.mjs's rerun test).
 *
 * Usage:
 *   node migrate-action-board-top8.mjs --dry-run
 *   node migrate-action-board-top8.mjs --apply
 */

import { getCareerOpsRoot } from './path-resolver.mjs';
import { reviewPaths, readJson, defaultState } from './review.mjs';
import { updateJobOperatingMetadata } from './outreach.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DATA_ROOT = getCareerOpsRoot();

// ── Source snapshot: CAREEROPS-DASHBOARD > Action Board, rows 1-8 as read
// 2026-09-16. jobKey is the job's OWN existing identity in
// data/review-state.json, resolved by hand (never fuzzy-matched at run
// time) — null means no matching job record exists.
export const SOURCE_ROWS = [
  {
    company: 'Elastic', role: 'Solutions Architect — General Business, East (Presales)',
    jobKey: null, matchState: 'MANUAL_REVIEW',
    priority: 'P0', due: '2026-09-17', lastTouch: '2026-09-15',
    nextAction: 'Thursday 2026-09-17: casually bump Russell only if there is no update; ask whether he was able to submit internally. Tell him about resume formatting , not major but reason to nudge lol',
    waitingOn: 'Russell internal submission', followUpDue: '2026-09-17',
    notes: 'Russell said it was better for him to submit internally; resume sent. Internal referral pending.',
  },
  {
    company: 'Augury', role: 'Sales and Value Engineer',
    jobKey: 'cr:augury::sales and value engineer@@remote us', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-17', lastTouch: '2026-09-15',
    nextAction: 'Wait on Andreea through 2026-09-17. Do not activate Aimee yet; keep Aimee as the reserve path only if Andreea remains silent.',
    waitingOn: 'Andreea acceptance / Shane heads-up', followUpDue: '2026-09-17',
    notes: 'Shane + Andreea is the current double tap. Avoid a premature third Augury contact; Aimee remains the warmer reserve route.',
  },
  {
    company: 'Plataine', role: 'Solution Engineer',
    jobKey: 'cr:plataine::solution engineer@@remote us', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-18', lastTouch: '2026-09-15',
    nextAction: 'Friday: check both invitations; message one if accepted. No third contact.',
    waitingOn: 'Clifford / Orly acceptance', followUpDue: '2026-09-18',
    notes: 'Posting closed after application. Clifford is the active hiring-side route; Orly remains pending.',
  },
  {
    company: 'Tulip', role: 'Continuous Improvement Project Manager / Sr CSM',
    jobKey: 'cr:tulip interfaces::continuous improvement project manager@@remote us', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-21', lastTouch: '2026-09-14',
    nextAction: 'Wait for responses; no additional Tulip contact before 2026-09-21.',
    waitingOn: 'Holly response / Marshall acceptance', followUpDue: '2026-09-21',
    notes: 'One Tulip outreach thread covers both applications.',
  },
  {
    company: 'Applied Materials', role: 'Technical Consultant - Process Quality (R2623145)',
    jobKey: 'url:https://amat.wd1.myworkdayjobs.com/External/job/Home--MobileAZ-001/Technical-Consultant---Process-Quality-Products_R2623145', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '9/17', lastTouch: '2026-09-15',
    nextAction: 'On follow-up, send a concise warm message asking whether the req/team is active and who the right person is to connect with.',
    waitingOn: 'PJ internal req/team check', followUpDue: '2026-09-21',
    notes: 'PJ is the warm contact. Keep the touch focused on active status plus routing.',
  },
  {
    company: 'InstaLILY', role: 'Strategic Associate / BDR',
    jobKey: 'cr:instalily ai::strategic associate@@nyc', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-21', lastTouch: '2026-09-16',
    nextAction: "Wait for Jeffrey's reply. If silent, send one final concise follow-up on 2026-09-21, then close.",
    waitingOn: 'Jeffrey reply', followUpDue: '2026-09-21',
    notes: 'Follow-up sent 2026-09-16. Clarified that Strategic Associate is the primary interest and strongest fit; still one thread covering both applications.',
  },
  {
    company: 'Gecko Robotics', role: 'Deployment Lead | Navy Manufacturing',
    jobKey: 'cr:gecko robotics::deployment lead navy manufacturing@@us', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-21', lastTouch: '2026-09-14',
    nextAction: 'If the invitation is accepted, send the role-specific message. No multi-contact chase.',
    waitingOn: 'LinkedIn invitation acceptance', followUpDue: '2026-09-21',
    notes: 'Strong-fit application; Outreach rank #7.',
  },
  {
    company: 'Propel', role: 'Presales Solution Architect',
    jobKey: 'cr:propel software solutions::presales solution architect@@us', matchState: 'MATCHED_APPLIED',
    priority: 'P3', due: '2026-09-21', lastTouch: '2026-09-14',
    nextAction: 'Wait for a response; send no more than one follow-up.',
    waitingOn: 'Shane Callaghan response', followUpDue: '2026-09-21',
    notes: 'Strong-fit application; Outreach rank #8.',
  },
];

/**
 * One canonical Home date. Identical Due/Follow-Up Due (or either blank)
 * collapses silently to Follow-Up Due. A materially different Due (e.g. a
 * hard external deadline) is flagged, never guessed at or silently dropped.
 */
export function collapseDue(due, followUpDue) {
  if (!due || !followUpDue || due === followUpDue) {
    return { canonical: followUpDue || due || null, flagged: false };
  }
  return {
    canonical: followUpDue,
    flagged: true,
    reason: `Due (${due}) differs from Follow-Up Due (${followUpDue}); Follow-Up Due used as canonical per default rule, legacy Due not migrated`,
  };
}

/** Build the operating-metadata PATCH for a MATCHED_APPLIED row. */
export function buildOperatingPatch(row) {
  const { canonical } = collapseDue(row.due, row.followUpDue);
  return {
    priority: row.priority,
    last_touch: row.lastTouch,
    next_action: row.nextAction,
    waiting_on: row.waitingOn,
    follow_up_due: canonical,
    notes: row.notes,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const p = reviewPaths(DATA_ROOT);
  const state = readJson(p.statePath, defaultState());

  const report = { matchedApplied: [], manualReview: [], dueFlags: [], applied: [] };

  for (const row of SOURCE_ROWS) {
    const { flagged, reason } = collapseDue(row.due, row.followUpDue);
    if (flagged) report.dueFlags.push({ company: row.company, reason });

    if (row.matchState !== 'MATCHED_APPLIED') {
      report.manualReview.push({ company: row.company, role: row.role, reason: 'no matching APPLIED job in review-state.json' });
      continue;
    }
    const job = state.jobs[row.jobKey];
    if (!job || job.execution_status !== 'APPLIED') {
      report.manualReview.push({ company: row.company, role: row.role, reason: `job_key ${row.jobKey} not APPLIED in current state` });
      continue;
    }
    report.matchedApplied.push({ company: row.company, jobKey: row.jobKey });

    if (apply) {
      const patch = buildOperatingPatch(row);
      await updateJobOperatingMetadata(row.jobKey, patch, { root: DATA_ROOT });
      report.applied.push(row.jobKey);
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
