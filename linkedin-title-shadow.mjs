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
const mfg = (d) => MFG_DOMAIN_I.test(d) || /\bMES\b|\bSCADA\b|\bPLC\b/.test(d);

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
    id: 'technical_account_manager+technical+mfg',
    title: /\btechnical account manager\b/i,
    context: (d) => CUSTOMER_TECHNICAL.test(d) && mfg(d),
  },
];

export function buildShadowTitleRule(config, rules = TITLE_RULES) {
  const negative = (config.title_filter?.negative || []).filter(k => typeof k === 'string' && k.trim()).map(k => compileKeyword(k.trim().toLowerCase()));
  return (job) => {
    const lower = String(job.title || '').toLowerCase();
    if (negative.some(m => m(lower))) return null;
    const d = String(job.description || '').replace(/<[^>]*>/g, ' ');
    const hit = rules.find(r => r.title.test(job.title || '') && r.context(d));
    return hit ? hit.id : null;
  };
}
