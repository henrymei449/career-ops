// linkedin-title-shadow.mjs — SHADOW-ONLY contextual title rules for LinkedIn
// discovery (2026-09-22 Coregent challenger replay). NOT imported by scan.mjs and
// not referenced by portals.yml: activating any rule needs explicit approval.
// Each rule = narrow title pattern AND JD evidence; no rule
// admits a title by pattern alone, and the global title_filter.negative list
// is still applied first by the caller (replayJob only consults a rule after
// the production gate rejected; negatives are re-checked here explicitly).
import { compileKeyword } from './scan.mjs';

// Widened 2026-09-22 (100-card manual sample): real JDs for Banner
// Engineering and ATS Corporation describe the presales function using the
// singular "pre-sale"/"presale", not just the plural "pre-sales"/"presales"
// the rule previously required verbatim. Both are literal, unambiguous
// evidence of a presales function -- not a broadening of what counts as
// evidence, just closing a singular/plural gap in the same literal check.
const PRESALES_LITERAL = /\bpre-?sales?\b|\bpresales?\b/i;
const CUSTOMER_TECHNICAL = /\bpre-?sales\b|\bpresales\b|customer[- ]facing|technical (?:sales|discovery|evaluation)s?\b|proof[- ]of[- ](?:concept|value)|\bdemo(?:s|nstrations?)?\b|solution (?:design|architecture)|deploy(?:ment|ing)? (?:at|with|for) customers?/i;
const MFG_DOMAIN = /manufactur|semiconductor|\bindustrial\b|process (?:industr|control|manufactur|optimi[sz])|refiner|petrochem|chemical plant|\bfactor(?:y|ies)\b|\bplants?\b|\bMES\b|\bSCADA\b|\bPLC\b|industrial automation/;
const MFG_DOMAIN_I = new RegExp(MFG_DOMAIN.source.replace('\\bMES\\b|\\bSCADA\\b|\\bPLC\\b|', ''), 'i');
// Added 2026-09-23 (TAM/CSM false-negative audit): real Tractian, AssetWatch
// and iBase-t JDs are reliability/predictive-maintenance/EAM software for
// manufacturing and aerospace-manufacturing customers, but describe the
// domain in those exact terms rather than restating "manufacturing" or
// "industrial" every time. Distinct, precise technical terms, not a
// broadening of what counts as manufacturing-adjacent.
const RELIABILITY_EAM_DOMAIN = /reliability engineer|predictive maintenance|condition monitoring|\bCMMS\b|\bEAM\b|enterprise asset management|asset performance management|maintenance (?:strategy|strategies|program)/i;
const mfg = (d) => MFG_DOMAIN_I.test(d) || /\bMES\b|\bSCADA\b|\bPLC\b/.test(d) || RELIABILITY_EAM_DOMAIN.test(d);
// Added 2026-09-23 (TAM/CSM false-negative audit): the real Tractian,
// AssetWatch and iBase-t JDs never use CUSTOMER_TECHNICAL's presales/demo/
// solution-design vocabulary -- they describe the same substantive,
// customer-facing technical-advisory function as "trusted advisor",
// "value realization", "business outcomes", "measurable adoption", account
// growth via QBRs. This is the evidence bar for TAM/CSM/CVP-style titles
// specifically: business-value/advisory language, not routine account
// admin. Never satisfied by the mere word "customer" or "success" alone.
const ADVISORY_VALUE_RE = /trusted advisor|strategic advisor|value realization|business[- ]value|business outcomes?|quarterly business reviews?|\bQBR\b|account growth|measurable adoption|adoption (?:outcomes?|milestones?)|operational consulting/i;
// Negative control (2026-09-23): a role that reads as routine support/
// ticket-handling should never be rescued by a shadow rule even if the
// employer happens to be manufacturing-adjacent and the title superficially
// matches -- explicit veto, checked once for every rule in
// buildShadowTitleRule, not per-rule.
const GENERIC_SUPPORT_ONLY_RE = /\bhelp ?desk\b|\btier[- ]?1 support\b|\bticket(?:ing)? queue\b|\bpassword resets?\b|\border status\b|\brefunds?\b/i;

export const TITLE_RULES = [
  {
    id: 'customer_success_engineer+technical+mfg',
    title: /\bcustomer success engineer\b/i,
    context: (d) => CUSTOMER_TECHNICAL.test(d) && mfg(d),
  },
  {
    id: 'solution_manager+technical+mfg',
    title: /\bsolutions? manager\b/i,
    context: (d) => CUSTOMER_TECHNICAL.test(d) && mfg(d),
  },
  {
    // Strictest: "Applications Engineer" is overwhelmingly a lab/support or
    // FAE role, so it needs the literal words pre-sales/presales in the JD.
    id: 'applications_engineer+presales_literal+mfg',
    title: /\bapplications? engineer\b/i,
    context: (d) => PRESALES_LITERAL.test(d) && mfg(d),
  },
  {
    // Added 2026-09-22 (100-card manual sample): real Kinaxis JD ("market
    // domain expertise... during all pre-sales engagements", "construct and
    // deliver custom demos") is a genuine presales/solutions-consulting
    // role in the manufacturing/supply-chain domain, and no existing rule's
    // title pattern covers "Business Consultant" at all. Same evidence bar
    // as solution_manager: JD context AND mfg domain both required, so a
    // bare "Business Consultant" (e.g. finance/accounting consulting) still
    // needs the same technical-presales signal to be admitted.
    id: 'business_consultant+technical+mfg',
    title: /\bbusiness consultant\b/i,
    context: (d) => CUSTOMER_TECHNICAL.test(d) && mfg(d),
  },
  {
    // Added 2026-09-23 (bulk-intake canary prep): real Tulip Interfaces JD
    // ("bridge... technical expertise and customer success", "technical
    // customer-facing roles", MES/Industry 4.0 domain throughout) satisfies
    // the same CUSTOMER_TECHNICAL+mfg bar every other rule uses. No rule
    // previously covered "Technical Account Manager" at all.
    //
    // Widened 2026-09-23 (TAM/CSM false-negative audit): the real Tractian
    // TAM JD ("trusted advisors, helping customers optimize maintenance
    // strategies... account growth, and measurable business outcomes",
    // explicit "manufacturing facilities") never uses CUSTOMER_TECHNICAL's
    // vocabulary -- ADVISORY_VALUE_RE closes that evidence gap for the same
    // title, same domain requirement.
    id: 'technical_account_manager+technical+mfg',
    title: /\btechnical account manager\b/i,
    context: (d) => (CUSTOMER_TECHNICAL.test(d) || ADVISORY_VALUE_RE.test(d)) && mfg(d),
  },
  {
    // Added 2026-09-23 (TAM/CSM false-negative audit): real AssetWatch JD
    // ("strategic advisors who help manufacturers transform... reliability
    // and maintenance", "measurable business outcomes through... adoption
    // of our predictive maintenance solutions") is a genuine manufacturing-
    // reliability advisory role. No existing rule's title pattern covers
    // "Customer Success Manager" at all -- this rule matches the substring
    // in both "Customer Success Manager" and "Technical Customer Success
    // Manager". Negative-control check: a Driivz/Vontier "Technical
    // Customer Success Manager" JD audited the same day describes generic
    // SaaS/API/integrations account work with no manufacturing, industrial,
    // MES, EAM/CMMS or reliability signal anywhere in the JD -- mfg(d) is
    // false for it, so it correctly stays rejected on domain, not admitted
    // on title pattern alone.
    id: 'customer_success_manager+advisory_value+mfg',
    title: /\bcustomer success manager\b/i,
    context: (d) => (CUSTOMER_TECHNICAL.test(d) || ADVISORY_VALUE_RE.test(d)) && mfg(d),
  },
  {
    // Added 2026-09-23 (TAM/CSM false-negative audit): real iBase-t JD is
    // explicit and unambiguous manufacturing-domain evidence ("Manufacturing
    // Execution System (MES)", "aerospace manufacturing domain", "advanced
    // manufacturing enterprise accounts") plus a fully-specified business-
    // value advisory function (Value Realization Framework, ROI commitments,
    // measurable adoption outcomes, QBRs). No existing rule's title pattern
    // covers "Customer Value Partner" at all.
    id: 'customer_value_partner+advisory_value+mfg',
    title: /\bcustomer value partner\b/i,
    context: (d) => (CUSTOMER_TECHNICAL.test(d) || ADVISORY_VALUE_RE.test(d)) && mfg(d),
  },
];

export function buildShadowTitleRule(config, rules = TITLE_RULES) {
  const negative = (config.title_filter?.negative || []).filter(k => typeof k === 'string' && k.trim()).map(k => compileKeyword(k.trim().toLowerCase()));
  return (job) => {
    const lower = String(job.title || '').toLowerCase();
    if (negative.some(m => m(lower))) return null;
    const d = String(job.description || '').replace(/<[^>]*>/g, ' ');
    // Hard veto for every rule: routine support/ticket-handling language
    // never gets rescued, regardless of title pattern or domain match.
    if (GENERIC_SUPPORT_ONLY_RE.test(d)) return null;
    const hit = rules.find(r => r.title.test(job.title || '') && r.context(d));
    return hit ? hit.id : null;
  };
}
