#!/usr/bin/env node
/**
 * migrate-historical-applications.mjs — PASS 1: one-time migration of the
 * real historical application ledger from the CAREEROPS-DASHBOARD Google
 * Sheet's "Applications" tab into durable CareerOps state
 * (data/review-state.json). See docs/careerops-state-model.md for the state
 * contract this extends, and application-schema.mjs for the new
 * application_status/application_stage/application_last_update/
 * application_outcome vocabulary this adds.
 *
 * This is a bounded, one-time migration helper, not a recurring importer —
 * SOURCE_ROWS below is a fixed snapshot of the sheet's "Applications" table
 * as read on 2026-09-16 (30 rows, IDs 1-30). It is checked into the repo so
 * the migration is reproducible and reviewable, exactly like a SQL migration
 * file; it is not meant to be edited to add new rows (new applications go
 * through the normal review.mjs / outreach.mjs lifecycle from here on).
 *
 * What this does, per row:
 *   1. Resolve identity. Eight rows already exist in durable state — six
 *      from an earlier historical-migration pass (Oden, Siemens, Miro,
 *      Applied Materials, Overview, UptimeAI) and two from the CURRENT live
 *      application flow (IFS, Samsara) — matched here by their exact
 *      existing job_key (KNOWN_JOB_KEYS below), never by company-name alone
 *      (never promote a same-company/different-role job).
 *   2. IFS and Samsara (EXCLUDE_FROM_TOUCH) are left completely untouched —
 *      they are live current workflow, not historical migration targets.
 *   3. The other six known rows are ENRICHED (application_status/stage/
 *      last_update/outcome + legacy_sheet added) without touching
 *      fit_decision/execution_status/applied_at, and — only if outreach is
 *      still PENDING (the migration-artifact bug this pass fixes) — their
 *      outreach.decision is resolved to WAIVED/COMPLETE, the smallest safe
 *      terminal representation that stops them from resurfacing as fresh
 *      SEARCH_REQUIRED work, with the real historical outreach evidence
 *      preserved verbatim in legacy_sheet rather than discarded.
 *   4. The remaining 22 rows have no corresponding CareerOps job at all (they
 *      were submitted directly, outside the scan/review pipeline) — a new,
 *      minimal historical job record is created: fit_decision=APPLY,
 *      execution_status=APPLIED, applied_at=the ORIGINAL sheet date (never
 *      migration time), outreach=WAIVED/COMPLETE for the same reason as #3
 *      (this pass does not wire a live outreach state machine for historical
 *      rows — see AGENTS.md's Pass-1 scope list), and the same
 *      application_status/stage/last_update/outcome + legacy_sheet fields.
 *
 * Idempotency: every job this script creates or enriches carries
 * legacy_sheet.sheet_row_id. A re-run recognizes a job already tagged with
 * the row's id and treats it as a no-op (no duplicate, no overwritten
 * applied_at). The one exception is the outreach-decision fix in #3, which
 * only fires while outreach.decision is still PENDING — once resolved
 * (by this script or a human), re-runs leave it alone.
 *
 * Usage:
 *   node migrate-historical-applications.mjs           # run + report
 *   node migrate-historical-applications.mjs --dry-run  # report only, no write
 */

import { getCareerOpsRoot } from './path-resolver.mjs';
import { atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { reviewPaths, readJson, defaultState } from './review.mjs';
import { computeJobKey } from './review-schema.mjs';
import { DECISION_INITIAL_STATUS } from './outreach-schema.mjs';
import { mapSheetApplicationStatus, buildLegacySheetMeta } from './application-schema.mjs';

const DATA_ROOT = getCareerOpsRoot();
const MIGRATION_SOURCE = 'careerops-dashboard-applications-sheet-2026-09-16';

// ── Source snapshot: CAREEROPS-DASHBOARD > Applications, read 2026-09-16 ───
// Columns: ID | Applied Date | Company | Role | Source | Fit Bucket |
// Geography | Status | Stage | Last Update | Outreach Status | Outreach
// Date | Follow-up Due | Next Action | Outcome | Evidence / Basis | Notes
const SOURCE_ROWS = [
  { id: 1, appliedDate: '2026-07-31', company: 'AlisQI', title: 'Sales Engineer - US Based', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Rejected', stage: 'Final Round', lastUpdate: '2026-08-31', outreachStatus: 'Complete', outreachDate: '2026-09-02', followUpDue: '', nextAction: 'Optional: ask for finalist feedback / referral only if useful', outcome: 'Rejected', evidence: 'Gmail + prior process', notes: 'Reached final round; useful evidence that positioning can convert.' },
  { id: 2, appliedDate: '2026-08-18', company: 'SixSense', title: 'AI Solutions Manager', source: 'Direct', fitBucket: 'Strong', geography: 'US / founding role', status: 'Rejected', stage: 'Rejected', lastUpdate: '2026-09-15', outreachStatus: 'Not needed', outreachDate: '2026-09-14', followUpDue: '', nextAction: 'Closed — rejected; no further action.', outcome: 'Rejected', evidence: 'Gmail', notes: 'Rejection received 2026-09-15. SixSense is closed and removed from active priorities and outreach.' },
  { id: 4, appliedDate: '2026-08-25', company: 'Autodesk', title: 'Technical Sales Specialist, Product Development', source: 'Direct', fitBucket: 'Adjacent', geography: 'US', status: 'Closed', stage: 'Skipped', lastUpdate: '2026-09-13', outreachStatus: 'Not needed', outreachDate: '', followUpDue: '', nextAction: 'Closed — out of domain; HireVue intentionally not completed', outcome: 'Skipped', evidence: 'Gmail + user clarification', notes: 'Applied, received HireVue invite, then intentionally skipped because the role was outside the target domain.' },
  { id: 3, appliedDate: '2026-08-26', company: 'Siemens', title: 'PreSales Solution Consultant - US Based', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Rejected', stage: 'Rejected', lastUpdate: '2026-08-31', outreachStatus: 'Not needed', outreachDate: '', followUpDue: '', nextAction: 'Closed', outcome: 'Rejected', evidence: 'Gmail', notes: 'Application confirmation/assessment email on Aug 26; rejection Aug 31.' },
  { id: 5, appliedDate: '2026-09-02', company: 'Intuit', title: 'Concierge Associate', source: 'Direct', fitBucket: 'Bridge', geography: 'NY / Remote mix', status: 'Active', stage: 'Recruiter Routing', lastUpdate: '2026-09-11', outreachStatus: 'Complete', outreachDate: '2026-09-11', followUpDue: '2026-09-16', nextAction: 'Wait for recruiter ETA response; follow up Wed/Thu if silent', outcome: '', evidence: 'Gmail', notes: 'Candidate Portal team forwarded ETA inquiry to relevant recruiter.' },
  { id: 6, appliedDate: '2026-09-03', company: 'Miro', title: 'Forward Deployed Consultant, Manufacturing', source: 'Direct', fitBucket: 'Strong', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'Scrapped — no outreach', outreachDate: '', followUpDue: '', nextAction: 'Let application run passively; no proactive outreach', outcome: '', evidence: 'Gmail', notes: 'Outreach deprioritized 2026-09-14 due to extreme competition and lower expected value versus targeted startup touches.' },
  { id: 7, appliedDate: '2026-09-03', company: 'Kinaxis', title: 'Business Consultant', source: 'Direct', fitBucket: 'Adjacent', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-03', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-14', nextAction: 'Soft touch if still a priority', outcome: '', evidence: 'Gmail', notes: '' },
  { id: 8, appliedDate: '2026-09-03', company: 'GE Vernova', title: 'Automation Readiness Enablement Leader', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-03', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-15', nextAction: 'One outreach touch if still interested; otherwise disposition', outcome: '', evidence: 'User-reported', notes: 'No Gmail confirmation found in scrape.' },
  { id: 9, appliedDate: '2026-09-08', company: 'INFICON', title: 'Field Applications Engineer Leader', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Rejected', stage: 'Rejected', lastUpdate: '2026-09-11', outreachStatus: 'Not needed', outreachDate: '', followUpDue: '', nextAction: 'Closed', outcome: 'Rejected', evidence: 'Gmail', notes: '' },
  { id: 10, appliedDate: '2026-09-09', company: 'Propel Software Solutions', title: 'Presales Solution Architect', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-09', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-15', nextAction: 'Soft touch: hiring manager / presales leader', outcome: '', evidence: 'Gmail', notes: '' },
  { id: 11, appliedDate: '2026-09-09', company: 'Aegis', title: 'Sales Applications Engineer', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'Scrapped — no outreach', outreachDate: '', followUpDue: '', nextAction: 'No action; user not interested in company', outcome: '', evidence: 'User-reported', notes: 'Application remains pending, but outreach was scrapped on 2026-09-14 because company interest is too low to justify additional effort.' },
  { id: 12, appliedDate: '2026-09-10', company: 'Infosys', title: 'Senior Associate - Business Consulting', source: 'Direct', fitBucket: 'Adjacent', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-10', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-16', nextAction: 'Soft touch if role remains strategically worthwhile', outcome: '', evidence: 'Gmail', notes: '' },
  { id: 13, appliedDate: '2026-09-10', company: 'UptimeAI', title: 'Technical Consultant (US)', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-10', outreachStatus: 'Sent - no response', outreachDate: '2026-09-10', followUpDue: '2026-09-16', nextAction: 'One follow-up midweek; then downgrade / close mental loop', outcome: '', evidence: 'Gmail + user outreach', notes: '' },
  { id: 14, appliedDate: '2026-09-10', company: 'Gecko Robotics', title: 'Deployment Lead | Navy Manufacturing', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'LinkedIn invite sent — pending', outreachDate: '2026-09-14', followUpDue: '2026-09-21', nextAction: 'Wait for acceptance; send concise note only if accepted', outcome: '', evidence: 'Gmail', notes: '' },
  { id: 15, appliedDate: '2026-09-10', company: 'Applied Materials', title: 'Technical Consultant - Process Quality', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-15', outreachStatus: 'Sent - replied', outreachDate: '2026-09-14', followUpDue: '2026-09-21', nextAction: 'On follow-up, send a concise warm message asking whether the req/team is active and who the right person is to connect with.', outcome: '', evidence: 'User conversation / warm-contact context', notes: 'PJ is the warm contact for Technical Consultant - Process Quality (R2623145).' },
  { id: 17, appliedDate: '2026-09-10', company: 'Overview', title: 'Manufacturing / Industrial AI opportunity', source: 'Direct', fitBucket: 'Strong', geography: 'US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-10', outreachStatus: 'Sent - no response', outreachDate: '2026-09-10', followUpDue: '2026-09-16', nextAction: 'One follow-up next week; then close loop', outcome: '', evidence: 'User-reported', notes: 'Application date approximated from conversation history.' },
  { id: 16, appliedDate: '2026-09-11', company: 'Jobgether (QAD role)', title: 'AI Sales Executive & Solutions Engineer', source: 'Direct / QAD SmartRecruiters (originally Jobgether)', fitBucket: 'Stretch', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'LinkedIn invite sent — pending', outreachDate: '2026-09-14', followUpDue: '2026-09-18', nextAction: 'Wait for Carolina acceptance; if accepted, send concise role-specific note. No second QAD contact before follow-up date.', outcome: '', evidence: 'Direct QAD SmartRecruiters req + Carolina Bojorquez Almazán LinkedIn hiring post', notes: 'Direct employer req confirmed. Carolina Bojorquez Almazán, QAD Talent Acquisition Team Lead, posted the role ~6 days ago.' },
  { id: 18, appliedDate: '2026-09-13', company: 'Plataine', title: 'Solution Engineer', source: 'LinkedIn', fitBucket: 'Strong', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-13', outreachStatus: 'Sent - pending', outreachDate: '2026-09-13', followUpDue: '2026-09-18', nextAction: 'Check Clifford and Orly invitation status on 2026-09-18; message one if accepted. No third contact before then.', outcome: '', evidence: 'User-reported + LinkedIn/company careers', notes: 'High-priority manufacturing AI / digital twin / MES-adjacent Solution Engineer. Clifford is the active hiring-side route.' },
  { id: 19, appliedDate: '2026-09-13', company: 'RandomTrees', title: 'Junior Presales Associate', source: 'LinkedIn', fitBucket: 'Bridge', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-13', outreachStatus: 'Not needed', outreachDate: '', followUpDue: '', nextAction: 'No proactive follow-up; respond only if contacted', outcome: '', evidence: 'User-reported + LinkedIn screenshot', notes: 'Part-time junior presales opening; opportunistic application only.' },
  { id: 20, appliedDate: '2026-09-13', company: 'Notion', title: 'Mid-Market Solutions Consultant', source: 'LinkedIn / Ashby', fitBucket: 'Adjacent', geography: 'NYC', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-13', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-18', nextAction: 'One concise post-application touch to relevant SC leader / recruiter if easy to identify; otherwise let process run', outcome: '', evidence: 'User-confirmed submission + Ashby posting', notes: 'Strategic commercial/solutions shot; NYC.' },
  { id: 22, appliedDate: '2026-09-14', company: 'Augury', title: 'Sales and Value Engineer', source: 'Direct / Greenhouse', fitBucket: 'Strong', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-15', outreachStatus: 'Sent - replied', outreachDate: '2026-09-14', followUpDue: '2026-09-15', nextAction: 'Shane Couturier accepted the LinkedIn invitation on 2026-09-15. Send a concise follow-up.', outcome: '', evidence: 'Gmail application confirmation + Augury job ID 8409062002', notes: 'Applied role was Sales and Value Engineer (Remote US), job ID 8409062002.' },
  { id: 23, appliedDate: '2026-09-14', company: 'Axion', title: 'Business Development Representative', source: 'Direct / Ashby', fitBucket: 'Bridge', geography: 'NYC', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: '2 additional LinkedIn contacts reached out — pending', outreachDate: '2026-09-14', followUpDue: '2026-09-21', nextAction: 'Check replies/acceptances; no additional outreach before follow-up date', outcome: '', evidence: 'Gmail + employer Ashby', notes: 'Manufacturing-AI junior GTM bridge application. Two additional Axion contacts reached out on 2026-09-14.' },
  { id: 24, appliedDate: '2026-09-14', company: 'InstaLILY AI', title: 'Strategic Associate', source: 'Direct / Greenhouse', fitBucket: 'Strong', geography: 'NYC', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '', nextAction: 'Let process run; no outreach yet', outcome: '', evidence: 'Gmail application confirmation', notes: 'Industrial-AI customer/growth/ops role; compensation only viable at >=$120k base.' },
  { id: 26, appliedDate: '2026-09-14', company: 'Tulip Interfaces', title: 'Continuous Improvement Project Manager', source: 'Direct / Greenhouse', fitBucket: 'Strong', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-14', outreachStatus: 'Holly email sent; Scott + Marshall LinkedIn invites sent — pending', outreachDate: '2026-09-14', followUpDue: '2026-09-21', nextAction: 'Wait for Holly / invite responses; no more Tulip outreach before follow-up date', outcome: '', evidence: 'Gmail + employer careers + two Tulip submissions', notes: 'Direct manufacturing/CI background maps strongly; posted range requires >=$120k base.' },
  { id: 21, appliedDate: '2026-09-14', company: 'Uncountable', title: 'Solutions Engineer', source: '8VC / Direct Ashby', fitBucket: 'Strong', geography: 'NYC', status: 'Stale / Unverified', stage: 'Applied — orphaned Ashby req', lastUpdate: '2026-09-14', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-18', nextAction: 'No follow-up. Do not count as live unless Uncountable recruiter/hiring team confirms the Solutions Engineer req is active.', outcome: '', evidence: "User-confirmed submission + direct Ashby URL; role is absent from Uncountable's current first-party Open Positions page.", notes: 'Direct Ashby page still accepts applications but is not linked/listed by current careers inventory. Treat as orphaned/stale.' },
  { id: 25, appliedDate: '2026-09-15', company: 'Protiviti', title: 'Business Performance Improvement - Supply Chain & Operations (Manufacturing Artificial Intelligence) Manager', source: 'LinkedIn / Protiviti Workday', fitBucket: 'Strong', geography: 'NYC / Hybrid', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-15', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-19', nextAction: 'One targeted touch to relevant Protiviti leader or recruiter if easy to identify; otherwise let application run.', outcome: '', evidence: 'User-confirmed submission + Protiviti Workday posting', notes: 'NYC hybrid; comp listed $134k-$214k base + 12% target bonus.' },
  { id: 27, appliedDate: '2026-09-15', company: 'Salsify', title: 'Solutions Consultant II', source: 'LinkedIn / Direct', fitBucket: 'Strong', geography: 'Remote US', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-15', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-19', nextAction: 'One concise post-application touch to a relevant leader or recruiter if easy to identify; otherwise let the application run.', outcome: '', evidence: 'User-confirmed submission + LinkedIn posting', notes: "Posted base range ~$113.9k-$134k plus variable/stock." },
  { id: 28, appliedDate: '2026-09-15', company: 'Oden Technologies', title: 'Solutions Engineer', source: 'Direct / Ashby', fitBucket: 'Stretch', geography: 'NYC / Hybrid', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-15', outreachStatus: 'Not sent', outreachDate: '', followUpDue: '2026-09-19', nextAction: 'One targeted post-application touch to a relevant contact if easy to identify; otherwise let the application run.', outcome: '', evidence: 'User-confirmed submission + Oden Ashby posting', notes: 'https://jobs.ashbyhq.com/oden-technologies/0f318d59-9c59-4685-88dd-0de73940c008' },
  { id: 29, appliedDate: '2026-09-16', company: 'IFS', title: 'Customer Success Manager / Manufacturing', source: 'User-confirmed submission', fitBucket: 'Strong', geography: '', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-16', outreachStatus: 'Sent - no response', outreachDate: '2026-09-16', followUpDue: '2026-09-17', nextAction: 'Email Dirjke; Hannah B invite already sent.', outcome: '', evidence: 'User-confirmed submission', notes: 'Hannah B LinkedIn invite sent 2026-09-16.' },
  { id: 30, appliedDate: '2026-09-16', company: 'Samsara', title: 'Specialist Sales Engineer', source: 'User-confirmed submission', fitBucket: 'Strong', geography: '', status: 'Pending', stage: 'Applied', lastUpdate: '2026-09-16', outreachStatus: 'Sent - no response', outreachDate: '2026-09-16', followUpDue: '2026-09-21', nextAction: "Wait for James Jackson's LinkedIn acceptance; message him if accepted.", outcome: '', evidence: 'User-confirmed submission', notes: 'James Jackson LinkedIn invite sent 2026-09-16.' },
];

// job_key of the eight sheet rows already represented in durable state —
// matched by exact existing identity, never by company name alone. Six are
// the earlier historical-migration pass (the outreach-contamination bug this
// script fixes); two (29, 30 — IFS, Samsara) are the CURRENT live
// application flow and must never be touched by this script.
const KNOWN_JOB_KEYS = {
  3: 'cr:siemens digital industries software::presales solution consultant us based@@mobile al',
  6: 'cr:miro::forward deployed consultant manufacturing@@austin tx',
  13: 'url:https://jobs.ashbyhq.com/uptimeai/ed175af5-5e3f-4eb8-9704-08d218408e21',
  15: 'url:https://amat.wd1.myworkdayjobs.com/External/job/Home--MobileAZ-001/Technical-Consultant---Process-Quality-Products_R2623145',
  17: 'url:https://jobs.ashbyhq.com/overview/c597579f-4ad1-41d2-9c30-a981d295fcbd',
  28: 'cr:oden technologies::solutions engineer@@chicago il',
  29: 'url:https://jobs.smartrecruiters.com/ifs1/744000149374069-customer-success-manager-manufacturing',
  30: 'url:https://www.samsara.com/company/careers/roles/7341443?gh_jid=7341443',
};

// Live current workflow — never touched by this script, per Pass 1 scope.
const EXCLUDE_FROM_TOUCH = new Set([29, 30]);

function appliedAtIso(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`migrate-historical-applications: bad date "${dateStr}"`);
  return d.toISOString();
}

function toRow(sourceRow) {
  return {
    source: 'CAREEROPS-DASHBOARD:Applications',
    sheetRowId: sourceRow.id,
    appliedDateRaw: sourceRow.appliedDate,
    applicationSource: sourceRow.source,
    fitBucket: sourceRow.fitBucket,
    geography: sourceRow.geography,
    statusRaw: sourceRow.status,
    stageRaw: sourceRow.stage,
    lastUpdateRaw: sourceRow.lastUpdate,
    outreachStatusRaw: sourceRow.outreachStatus,
    outreachDateRaw: sourceRow.outreachDate,
    followUpDueRaw: sourceRow.followUpDue,
    nextActionRaw: sourceRow.nextAction,
    outcomeRaw: sourceRow.outcome,
    evidence: sourceRow.evidence,
    notes: sourceRow.notes,
  };
}

function applyEnrichment(job, sourceRow) {
  job.application_status = mapSheetApplicationStatus(sourceRow.status);
  job.application_stage = sourceRow.stage;
  job.application_last_update = sourceRow.lastUpdate || null;
  job.application_outcome = sourceRow.outcome || '';
  // Preserve the original migrated_at on a re-run (idempotent re-enrichment
  // reapplies the same evidence, not a fresh migration event) rather than
  // bumping it every time this script runs.
  const migratedAt = job.legacy_sheet?.migrated_at;
  job.legacy_sheet = buildLegacySheetMeta({ ...toRow(sourceRow), migratedAt });
}

/**
 * @param {{root?: string, dryRun?: boolean}} [opts]
 */
export async function migrateHistoricalApplications({ root = DATA_ROOT, dryRun = false } = {}) {
  const p = reviewPaths(root);
  const report = {
    totalRows: SOURCE_ROWS.length,
    matchedExisting: [],
    historicalCreated: [],
    outreachFixed: [],
    ambiguous: [],
    skippedLiveFlow: [],
    alreadyMigrated: [],
    statusCounts: { ACTIVE: 0, REJECTED: 0, CLOSED: 0, STALE: 0, WITHDRAWN: 0, UNKNOWN: 0 },
  };

  for (const row of SOURCE_ROWS) {
    report.statusCounts[mapSheetApplicationStatus(row.status)] += 1;
  }

  const run = async () => {
    const state = readJson(p.statePath, defaultState());

    for (const row of SOURCE_ROWS) {
      if (EXCLUDE_FROM_TOUCH.has(row.id)) {
        report.skippedLiveFlow.push({ id: row.id, company: row.company, title: row.title });
        continue;
      }

      const knownKey = KNOWN_JOB_KEYS[row.id];
      if (knownKey) {
        const job = state.jobs[knownKey];
        if (!job) {
          report.ambiguous.push({ id: row.id, company: row.company, title: row.title, reason: `expected existing job_key ${knownKey} not found in state` });
          continue;
        }
        if (job.legacy_sheet?.sheet_row_id === row.id && job.legacy_sheet?.source === 'CAREEROPS-DASHBOARD:Applications') {
          report.alreadyMigrated.push({ id: row.id, jobKey: knownKey, company: row.company });
          // Idempotent re-run: enrichment fields are safe to reapply (same
          // values), but do NOT re-touch outreach below.
          applyEnrichment(job, row);
          continue;
        }
        applyEnrichment(job, row);
        report.matchedExisting.push({ id: row.id, jobKey: knownKey, company: row.company, title: row.title });

        if (job.outreach && job.outreach.decision === 'PENDING') {
          job.outreach.decision = 'WAIVED';
          job.outreach.status = DECISION_INITIAL_STATUS.WAIVED;
          report.outreachFixed.push({ id: row.id, jobKey: knownKey, company: row.company });
        }
        continue;
      }

      // No known existing job_key for this row — a genuinely new historical
      // record. Compute identity the same way review-schema.mjs does, so a
      // future real posting for the same company+role+location would
      // collide (and be caught below) instead of silently duplicating.
      const jobKey = computeJobKey({ company: row.company, title: row.title, location: row.geography });
      if (!jobKey) {
        report.ambiguous.push({ id: row.id, company: row.company, title: row.title, reason: 'could not derive a job_key (no URL, no usable company/title)' });
        continue;
      }

      const existing = state.jobs[jobKey];
      if (existing) {
        if (existing.legacy_sheet?.sheet_row_id === row.id) {
          report.alreadyMigrated.push({ id: row.id, jobKey, company: row.company });
          applyEnrichment(existing, row);
          continue;
        }
        // Collided with a job this script did not expect (e.g. a real
        // scanned posting for the same company+role+location). Never
        // silently overwrite it — flag for manual review instead.
        report.ambiguous.push({ id: row.id, company: row.company, title: row.title, reason: `job_key ${jobKey} already exists and is not a prior migration of this row` });
        continue;
      }

      const applied = appliedAtIso(row.appliedDate);
      const job = {
        fit_decision: 'APPLY',
        execution_status: 'APPLIED',
        reason: 'Historical migration from CAREEROPS-DASHBOARD Applications sheet — submitted outside the CareerOps review pipeline.',
        company: row.company,
        title: row.title,
        url: '',
        batch_id: MIGRATION_SOURCE,
        decided_at: applied,
        applied_at: applied,
        outreach: { decision: 'WAIVED', status: DECISION_INITIAL_STATUS.WAIVED, candidates: [], selected_contacts: [] },
      };
      applyEnrichment(job, row);
      state.jobs[jobKey] = job;
      report.historicalCreated.push({ id: row.id, jobKey, company: row.company, title: row.title, appliedAt: applied });
    }

    if (!dryRun) {
      state.updated_at = new Date().toISOString();
      atomicWriteFile(p.statePath, JSON.stringify(state, null, 2) + '\n');
    }
  };

  if (dryRun) {
    await run();
  } else {
    await withPipelineLock(p.statePath, run);
  }

  return report;
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = await migrateHistoricalApplications({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${dryRun ? '[dry run] ' : ''}total=${report.totalRows} matchedExisting=${report.matchedExisting.length} historicalCreated=${report.historicalCreated.length} outreachFixed=${report.outreachFixed.length} alreadyMigrated=${report.alreadyMigrated.length} skippedLiveFlow=${report.skippedLiveFlow.length} ambiguous=${report.ambiguous.length}`);
  if (report.ambiguous.length) {
    console.log('\nAMBIGUOUS — manual review required:');
    for (const a of report.ambiguous) console.log(`  #${a.id} ${a.company} — ${a.title}: ${a.reason}`);
  }
}

import { isMainModule } from './lib/is-main-module.mjs';
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`migrate-historical-applications.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
