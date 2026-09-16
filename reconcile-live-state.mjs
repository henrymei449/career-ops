#!/usr/bin/env node
/**
 * reconcile-live-state.mjs — PASS 6: one-time reconciliation of live
 * submitted applications' outreach/contact evidence from the
 * CAREEROPS-DASHBOARD Google Sheet's "Action Board" and "Outreach" tabs
 * (spreadsheet 12PGKh8g-lDQ-KMT09MWwSsUJ1-iZja8ytRkc4dB8EEM) into durable
 * CareerOps state (data/review-state.json), so Home
 * (outreach.mjs's listFollowUpActions) stops showing a generic
 * WAITING/APPLICATION_PENDING row for an application that already has real,
 * evidenced contact activity.
 *
 * This is a bounded, one-time reconciliation helper, not a recurring
 * importer or a Sheet sync — RECONCILIATION_SOURCE below is a fixed
 * snapshot of the sheet's Action Board + Outreach tabs as read 2026-09-16,
 * checked into the repo exactly like migrate-historical-applications.mjs's
 * SOURCE_ROWS, for the same reason: reproducible, reviewable, and never
 * silently re-synced. New applications/outreach go through the normal
 * outreach.mjs lifecycle from here on; CareerOps remains the state/workflow
 * authority (the Sheet is visibility/reporting only, per the Pass 5 backlog
 * item "CareerOps → Sheet projection").
 *
 * Scope (spec sections 2-3): only jobs with execution_status=APPLIED AND
 * application_status in (ACTIVE, STALE) — i.e. exactly
 * APPLICATION_ALIVE_STATUSES from application-schema.mjs. Never reopens a
 * REJECTED/CLOSED/WITHDRAWN job, never creates a new application record,
 * never merges same-company/different-role jobs. Every job this script
 * touches is matched by ITS OWN EXISTING job_key (JOB_KEYS below) — resolved
 * by hand against data/review-state.json's already-migrated Pass 1 records,
 * the same way migrate-historical-applications.mjs's KNOWN_JOB_KEYS worked,
 * never by fuzzy company-name matching at run time. IFS and Samsara are
 * intentionally absent from RECONCILIATION_SOURCE: they already carry real
 * outreach.selected_contacts from the live Pass 2/3 workflow and need no
 * reconciliation.
 *
 * What this does, per job: appends any CONTACT_KEYS entries not already
 * present (matched by candidate_id — the idempotency key) to
 * outreach.selected_contacts, and — only the first time a job gains a
 * contact this way — flips outreach.decision/status from the Pass 1
 * WAIVED/COMPLETE placeholder to REQUIRED/CONTACTS_SELECTED (the same shape
 * IFS/Samsara already use), so deriveOutreachCompletion() and Home's
 * per-contact rows work exactly like the live-flow jobs. It never touches
 * application_status/stage/last_update/outcome — sheet evidence read this
 * session showed no drift from what Pass 1 already captured (see AGENTS.md
 * Pass 6 section 5) — and never touches fit_decision/execution_status/
 * applied_at/url/company/title.
 *
 * Idempotent by construction: a contact is only appended if no existing
 * selected_contacts entry shares its candidate_id. A second run is a
 * no-op — every job reports alreadyReconciled instead of updated.
 *
 * Usage:
 *   node reconcile-live-state.mjs --dry-run
 *   node reconcile-live-state.mjs --apply
 */

import { getCareerOpsRoot } from './path-resolver.mjs';
import { atomicWriteFile } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { reviewPaths, readJson, defaultState } from './review.mjs';
import { APPLICATION_ALIVE_STATUSES, APPLICATION_CLOSED_STATUSES } from './application-schema.mjs';
import { freshContactAction } from './followup-schema.mjs';

const DATA_ROOT = getCareerOpsRoot();
const RECONCILIATION_RUN_ID = 'careerops-dashboard-action-board-outreach-2026-09-16';

// ── Source snapshot: CAREEROPS-DASHBOARD > Action Board + Outreach tabs,
// read 2026-09-16. One entry per live job that carries confirmed contact
// activity beyond what Pass 1's Applications-tab snapshot captured. Jobs
// with no confirmed contact evidence (Oden, Kinaxis, GE Vernova, Aegis,
// Infosys, RandomTrees, Notion, Uncountable, Protiviti, Salsify) and Miro
// (outreach explicitly scrapped) are deliberately absent — NO_CHANGE.
const RECONCILIATION_SOURCE = [
  {
    jobKey: 'url:https://amat.wd1.myworkdayjobs.com/External/job/Home--MobileAZ-001/Technical-Consultant---Process-Quality-Products_R2623145',
    company: 'Applied Materials', role: 'Technical Consultant - Process Quality',
    evidence: 'Outreach tab #5 + Action Board #5: PJ (Pi Jeng Khor), warm contact active, follow-up due 2026-09-21 — "send a concise warm message asking whether the req/team is active."',
    contacts: [
      { candidateId: 'cand-manual-pj-amat', name: 'PJ (Pi Jeng Khor)', title: 'Warm contact / adjacent team', lane: 'FUNCTIONAL', status: 'CONTACT_SELECTED', channel: 'DIRECT_MESSAGE', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-21' },
    ],
  },
  {
    jobKey: 'url:https://jobs.ashbyhq.com/overview/c597579f-4ad1-41d2-9c30-a981d295fcbd',
    company: 'Overview', role: 'Vision Sales Engineer (U.S. – Expansion)',
    evidence: 'Outreach tab #11: Marcela Ríos Bravo, LinkedIn invite/message sent — pending, no response yet, follow-up due 2026-09-16 ("send one final concise follow-up, then close").',
    contacts: [
      { candidateId: 'cand-manual-marcela-overview', name: 'Marcela Ríos Bravo', title: 'Technical Recruiter', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-16' },
    ],
  },
  {
    jobKey: 'url:https://jobs.ashbyhq.com/uptimeai/ed175af5-5e3f-4eb8-9704-08d218408e21',
    company: 'UptimeAI', role: 'Technical Consultant (US)',
    evidence: 'Outreach tab #9: original contact, sent, no response, follow-up due 2026-09-16 ("send one final concise follow-up, then close").',
    contacts: [
      { candidateId: 'cand-manual-original-uptimeai', name: 'Original contact', title: '', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: null, nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-16' },
    ],
  },
  {
    jobKey: 'cr:intuit::concierge associate@@ny+remote mix',
    company: 'Intuit', role: 'Concierge Associate',
    evidence: 'Outreach tab #13: recruiter routing active, complete outreach on file, follow-up due 2026-09-16 ("one courtesy ETA follow-up only if silent").',
    contacts: [
      { candidateId: 'cand-manual-recruiter-intuit', name: 'Recruiter', title: '', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'EMAIL', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-16' },
    ],
  },
  {
    jobKey: 'cr:propel software solutions::presales solution architect@@us',
    company: 'Propel Software Solutions', role: 'Presales Solution Architect',
    evidence: 'Outreach tab #8 + Action Board #8: Shane Callaghan, LinkedIn message sent — pending, follow-up due 2026-09-21 ("wait for a response; send no more than one follow-up").',
    contacts: [
      { candidateId: 'cand-manual-shane-propel', name: 'Shane Callaghan', title: 'External GTM recruiting consultant / routing contact', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'LINKEDIN_MESSAGE', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-21' },
    ],
  },
  {
    jobKey: 'cr:gecko robotics::deployment lead navy manufacturing@@us',
    company: 'Gecko Robotics', role: 'Deployment Lead | Navy Manufacturing',
    evidence: 'Outreach tab #7 + Action Board #7: Navy Manufacturing contact (name not captured), LinkedIn invite sent — pending ("if accepted, send concise Deployment Lead follow-up; otherwise no additional touch").',
    contacts: [
      { candidateId: 'cand-manual-navy-gecko', name: 'Navy Manufacturing contact', title: 'Employer / hiring-side contact', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
    ],
  },
  {
    jobKey: 'cr:jobgether (qad role)::ai sales executive solutions engineer@@remote us',
    company: 'Jobgether (QAD role)', role: 'AI Sales Executive & Solutions Engineer',
    evidence: 'Outreach tab #10 + Action Board: Carolina Bojorquez Almazán (QAD Talent Acquisition Team Lead), hiring manager LinkedIn invite pending ("wait for acceptance; if accepted, send the role-specific note").',
    contacts: [
      { candidateId: 'cand-manual-carolina-qad', name: 'Carolina Bojorquez Almazán', title: 'Talent Acquisition Team Lead', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
    ],
  },
  {
    jobKey: 'cr:plataine::solution engineer@@remote us',
    company: 'Plataine', role: 'Solution Engineer',
    evidence: 'Outreach tab #3 + Action Board #3: two LinkedIn invitations pending (Orly Sanovsky, Clifford Burton — the active hiring-side route); "check acceptances Friday; message one if accepted."',
    contacts: [
      { candidateId: 'cand-manual-orly-plataine', name: 'Orly Sanovsky', title: 'VP Human Resources / Talent Acquisition', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
      { candidateId: 'cand-manual-clifford-plataine', name: 'Clifford Burton', title: 'Head of North American Sales', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
    ],
  },
  {
    jobKey: 'cr:augury::sales and value engineer@@remote us',
    company: 'Augury', role: 'Sales and Value Engineer',
    evidence: 'Outreach tab #2 + Action Board #2 + contact detail: Shane Couturier accepted the LinkedIn invite 2026-09-15, message pending; Andreea Florescu warm-handoff invite pending through 2026-09-17.',
    contacts: [
      { candidateId: 'cand-manual-shane-augury', name: 'Shane Couturier', title: 'Field Engineering Manager', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_MESSAGE', nextAction: 'SEND_MESSAGE', nextActionDue: null },
      { candidateId: 'cand-manual-andreea-augury', name: 'Andreea Florescu', title: 'Warm handoff contact', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: '2026-09-17' },
    ],
  },
  {
    jobKey: 'cr:axion::business development representative@@nyc',
    company: 'Axion', role: 'Business Development Representative',
    evidence: 'Outreach tab #12 + contact detail: two additional Axion contacts (names not captured) reached out via LinkedIn 2026-09-14, sent — pending ("check replies/acceptances; no additional outreach before follow-up date").',
    contacts: [
      { candidateId: 'cand-manual-two-contacts-axion', name: 'Two Axion contacts (names not captured)', title: 'Employer / targeted outreach', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
    ],
  },
  {
    jobKey: 'cr:instalily ai::strategic associate@@nyc',
    company: 'InstaLILY AI', role: 'Strategic Associate',
    evidence: 'Action Board #6 (Last Touch 2026-09-16): "follow-up sent 2026-09-16" to Jeffrey Perkins, awaiting reply; if silent, one final follow-up on 2026-09-21, then close. Supersedes Pass 1\'s "Not sent" snapshot, which predates this 2026-09-16 touch.',
    contacts: [
      { candidateId: 'cand-manual-jeffrey-instalily', name: 'Jeffrey Perkins', title: 'Talent Acquisition Lead', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'LINKEDIN_MESSAGE', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-21' },
    ],
  },
  {
    jobKey: 'cr:tulip interfaces::continuous improvement project manager@@remote us',
    company: 'Tulip Interfaces', role: 'Continuous Improvement Project Manager',
    evidence: 'Outreach tab #4 + Action Board #4 + contact detail: Holly Coode email sent — pending (due 2026-09-21); Marshall Riccardi LinkedIn invite sent — pending, backup hiring-side touch.',
    contacts: [
      { candidateId: 'cand-manual-holly-tulip', name: 'Holly Coode', title: 'Recruiter / prior application contact', lane: 'RECRUITING', status: 'OUTREACH_SENT', channel: 'EMAIL', nextAction: 'FOLLOW_UP', nextActionDue: '2026-09-21' },
      { candidateId: 'cand-manual-marshall-tulip', name: 'Marshall Riccardi', title: 'Adoption Manager / customer digital transformation', lane: 'FUNCTIONAL', status: 'OUTREACH_SENT', channel: 'LINKEDIN_INVITE', nextAction: 'CHECK_CONNECTION', nextActionDue: null },
    ],
  },
];

function buildContactRecord(spec) {
  return {
    ...freshContactAction(),
    candidate_id: spec.candidateId,
    name: spec.name,
    title: spec.title || '',
    company: '',
    linkedin_url: '',
    lane: spec.lane,
    source: 'MANUAL',
    score: 0,
    status: spec.status,
    channel: spec.channel,
    next_action: spec.nextAction,
    next_action_due: spec.nextActionDue,
  };
}

/**
 * @param {{root?: string, dryRun?: boolean}} [opts]
 */
export async function reconcileLiveState({ root = DATA_ROOT, dryRun = false } = {}) {
  const p = reviewPaths(root);
  const report = {
    runId: RECONCILIATION_RUN_ID,
    totalEntries: RECONCILIATION_SOURCE.length,
    updated: [],
    alreadyReconciled: [],
    manualReview: [],
    skippedNotLive: [],
    applicationPendingBefore: 0,
    applicationPendingAfter: 0,
  };

  const isLive = (job) => job && job.execution_status === 'APPLIED' && APPLICATION_ALIVE_STATUSES.includes(job.application_status);
  const hasActionableContact = (job) => (job.outreach?.selected_contacts || []).length > 0;

  const run = async () => {
    const state = readJson(p.statePath, defaultState());

    // Baseline: how many live jobs currently have zero selected_contacts
    // (i.e. would surface as the generic APPLICATION_PENDING fallback).
    for (const job of Object.values(state.jobs)) {
      if (isLive(job) && !hasActionableContact(job)) report.applicationPendingBefore += 1;
    }

    for (const entry of RECONCILIATION_SOURCE) {
      const job = state.jobs[entry.jobKey];
      if (!job) {
        report.manualReview.push({ jobKey: entry.jobKey, company: entry.company, role: entry.role, reason: 'expected job_key not found in state' });
        continue;
      }
      if (job.execution_status !== 'APPLIED') {
        report.skippedNotLive.push({ jobKey: entry.jobKey, company: entry.company, reason: `execution_status=${job.execution_status}` });
        continue;
      }
      if (APPLICATION_CLOSED_STATUSES.includes(job.application_status)) {
        report.skippedNotLive.push({ jobKey: entry.jobKey, company: entry.company, reason: `application_status=${job.application_status} is closed — never reopened by reconciliation` });
        continue;
      }

      job.outreach = job.outreach || { decision: 'PENDING', status: 'NOT_STARTED', candidates: [], selected_contacts: [] };
      job.outreach.selected_contacts = job.outreach.selected_contacts || [];
      const existingIds = new Set(job.outreach.selected_contacts.map((c) => c.candidate_id));

      const toAdd = entry.contacts.filter((c) => !existingIds.has(c.candidateId));
      if (toAdd.length === 0) {
        report.alreadyReconciled.push({ jobKey: entry.jobKey, company: entry.company, role: entry.role });
        continue;
      }

      const priorStage = job.application_stage;
      for (const spec of toAdd) job.outreach.selected_contacts.push(buildContactRecord(spec));
      // Flip the Pass 1 WAIVED/COMPLETE placeholder to the real live-flow
      // shape (matching IFS/Samsara) now that this job carries actual
      // contact evidence — never touched for a job that already had its own
      // decision/status (there are none in RECONCILIATION_SOURCE, but this
      // guards against a future re-run finding a job whose outreach was
      // independently advanced by the live workflow in the meantime).
      if (job.outreach.decision === 'WAIVED' && job.outreach.status === 'COMPLETE') {
        job.outreach.decision = 'REQUIRED';
        job.outreach.status = 'CONTACTS_SELECTED';
      }

      report.updated.push({
        jobKey: entry.jobKey,
        company: entry.company,
        role: entry.role,
        priorApplicationStage: priorStage,
        contactsAdded: toAdd.map((c) => ({ name: c.name, status: c.status, channel: c.channel, next_action: c.nextAction, next_action_due: c.nextActionDue })),
        evidence: entry.evidence,
      });
    }

    for (const job of Object.values(state.jobs)) {
      if (isLive(job) && !hasActionableContact(job)) report.applicationPendingAfter += 1;
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
  const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--apply');
  const report = await reconcileLiveState({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${dryRun ? '[dry run] ' : ''}total=${report.totalEntries} updated=${report.updated.length} alreadyReconciled=${report.alreadyReconciled.length} skippedNotLive=${report.skippedNotLive.length} manualReview=${report.manualReview.length}`);
  console.log(`APPLICATION_PENDING before=${report.applicationPendingBefore} after=${report.applicationPendingAfter}`);
  if (report.manualReview.length) {
    console.log('\nMANUAL_REVIEW:');
    for (const m of report.manualReview) console.log(`  ${m.company} — ${m.role || ''}: ${m.reason}`);
  }
  if (dryRun) console.log('\nThis was a dry run. Re-run with --apply to write changes.');
}

import { isMainModule } from './lib/is-main-module.mjs';
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`reconcile-live-state.mjs failed: ${err.message}`);
    process.exit(1);
  });
}
