// lib/outreach-personas.mjs — small, hand-editable role-family -> persona
// title mapping for outreach contact discovery (Pass 2 MVP).
//
// Deliberately NOT an LLM classifier: outreach-schema.mjs's classifyRoleFamily
// matches a job title against each family's `titleKeywords` (case-insensitive
// substring) and returns the first family that matches, falling back to
// GENERIC_TECHNICAL_COMMERCIAL when nothing does. Edit this file directly to
// add a family or retune keywords — no code change needed elsewhere.
//
// Each family lists the outreach personas (job titles at the TARGET company)
// worth searching for, split into the two lanes outreach.mjs always looks
// for: recruiting (who might route an application) and functional (who
// might actually hire for the role).

export const PERSONA_FAMILIES = {
  SOLUTIONS_ENGINEERING: {
    titleKeywords: ['solutions engineer', 'sales engineer', 'solutions consultant', 'pre-sales', 'presales'],
    recruiting: ['Talent Acquisition Partner', 'Technical Recruiter', 'Senior Recruiter', 'Recruiter'],
    functional: [
      'Director Solutions Engineering',
      'Solutions Engineering Manager',
      'Head of Solutions',
      'Director Sales Engineering',
      'Principal Solutions Engineer',
    ],
  },
  MES_MANUFACTURING_CONSULTING: {
    titleKeywords: ['mes', 'manufacturing execution', 'manufacturing consultant', 'industrial consultant', 'plant systems'],
    recruiting: ['Talent Acquisition Partner', 'Technical Recruiter', 'Recruiter'],
    functional: [
      'MES Practice Lead',
      'Director Professional Services',
      'Manufacturing Solutions Director',
      'Principal MES Consultant',
      'Manufacturing Consulting Manager',
    ],
  },
  INDUSTRIAL_AI: {
    titleKeywords: ['industrial ai', 'applied ai', 'ai solutions', 'machine learning engineer', 'computer vision'],
    recruiting: ['Talent Acquisition Partner', 'Technical Recruiter', 'AI Talent Partner', 'Recruiter'],
    functional: [
      'Director Applied AI',
      'Head of AI Solutions',
      'AI Solutions Manager',
      'Principal AI Engineer',
      'VP Engineering',
    ],
  },
  CUSTOMER_SUCCESS_TECHNICAL: {
    titleKeywords: ['customer success', 'technical account manager', 'implementation consultant', 'onboarding engineer'],
    recruiting: ['Talent Acquisition Partner', 'Technical Recruiter', 'Recruiter'],
    functional: [
      'Director Customer Success',
      'Head of Customer Success',
      'Technical Account Management Manager',
      'VP Customer Success',
    ],
  },
  GENERIC_TECHNICAL_COMMERCIAL: {
    // Fallback family — matched last, never by titleKeywords (see
    // classifyRoleFamily below), so it is not listed here.
    titleKeywords: [],
    recruiting: ['Talent Acquisition Partner', 'Technical Recruiter', 'Recruiter'],
    functional: ['Director', 'Head of Department', 'Engineering Manager', 'Hiring Manager'],
  },
};

export const FALLBACK_FAMILY = 'GENERIC_TECHNICAL_COMMERCIAL';

/**
 * Classify a job title into a persona family by keyword match. Ambiguous or
 * unmatched titles fall back to GENERIC_TECHNICAL_COMMERCIAL rather than
 * guessing — see AGENTS.md's "fall back conservatively" instruction.
 *
 * @param {string} jobTitle
 * @returns {string} A key of PERSONA_FAMILIES.
 */
export function classifyRoleFamily(jobTitle) {
  const t = String(jobTitle ?? '').toLowerCase();
  if (!t.trim()) return FALLBACK_FAMILY;
  for (const [family, def] of Object.entries(PERSONA_FAMILIES)) {
    if (family === FALLBACK_FAMILY) continue;
    if (def.titleKeywords.some((kw) => t.includes(kw))) return family;
  }
  return FALLBACK_FAMILY;
}
