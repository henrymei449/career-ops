// tests/location-tier.test.mjs — regression tests for location-tier.mjs,
// the standalone geography classifier for the targeted-company dry-run CSV
// export (NOT career-ops' core location_filter). Canonical policy directive:
// 2026-09-07.
import { pass, fail } from './helpers.mjs';
import { classifyLocation, workdayUrlHint } from '../location-tier.mjs';

console.log('\nlocation-tier — canonical NYC-actionability policy');

function check(label, input, expectedTier, extra = {}) {
  const result = classifyLocation(input);
  if (result.tier !== expectedTier) {
    fail(`${label}: expected Tier ${expectedTier}, got Tier ${result.tier} (${JSON.stringify(result)})`);
    return;
  }
  for (const [key, expected] of Object.entries(extra)) {
    if (result[key] !== expected) {
      fail(`${label}: expected ${key}=${expected}, got ${key}=${result[key]}`);
      return;
    }
  }
  pass(`${label} -> Tier ${expectedTier}${Object.keys(extra).length ? ` (${JSON.stringify(extra)})` : ''}`);
}

// ── Required regression cases (user-specified) ─────────────────────
check('"United States"', { location: 'United States' }, 3, { needsValidation: true });
check('"New York, NY"', { location: 'New York, NY' }, 5, { usRelevant: 'TRUE', nycMetro: true });
check('"United States, NY, New York" + Remote title', { location: 'United States, NY, New York', title: 'Implementation Consultant (Remote)' }, 5, { nycMetro: true });
check('"Remote - United States"', { location: 'Remote - United States' }, 5, { usRelevant: 'TRUE', remoteUS: true });
check('"Atlanta, GA"', { location: 'Atlanta, GA' }, 2, { usRelevant: 'TRUE' });
check('"Chicago, IL"', { location: 'Chicago, IL' }, 2, { usRelevant: 'TRUE' });
check('"San Jose, CA"', { location: 'San Jose, CA' }, 2, { usRelevant: 'TRUE' });
check('"Boulder, CO"', { location: 'Boulder, CO' }, 2, { usRelevant: 'TRUE' });
check('"Boston, MA" onsite/hybrid requiring Boston', { location: 'Boston, MA', title: 'Solutions Engineer (Hybrid — Boston)' }, 2, { usRelevant: 'TRUE' });
check('"London, United Kingdom"', { location: 'London, United Kingdom' }, 1, { usRelevant: 'FALSE', actionable: false });
check('"Tokyo, Japan"', { location: 'Tokyo, Japan' }, 1, { usRelevant: 'FALSE', actionable: false });
check('"N/A"', { location: 'N/A' }, 3, { needsValidation: true, usRelevant: 'UNKNOWN' });
check('"2 Locations" unresolved', { location: '2 Locations' }, 3, { needsValidation: true, usRelevant: 'UNKNOWN' });

// ── City-name parsing: a real US city must never read as US Relevant=FALSE ──
for (const loc of ['San Jose, CA', 'Chicago, IL', 'Atlanta, GA', 'Memphis, TN', 'Davenport, IA']) {
  const r = classifyLocation({ location: loc });
  if (r.usRelevant === 'TRUE' && r.tier !== 1) {
    pass(`"${loc}" resolves usRelevant=TRUE (never FALSE for a plain US city)`);
  } else {
    fail(`"${loc}" resolved usRelevant=${r.usRelevant}, tier=${r.tier} — a US city must not read as non-US`);
  }
}

// ── Dataset-specific regressions (the bugs the canonical-policy directive was written to fix) ──
check('bare "United States" no longer inflated to Tier 2 (Oracle-style)', { location: 'United States' }, 3);
check('"Italy, MI, Segrate" — MI is Milano, not Michigan', { location: 'Italy, MI, Segrate' }, 1, { usRelevant: 'FALSE' });
check('"Kalamazoo, MI" — MI is genuinely Michigan here', { location: 'Kalamazoo, MI' }, 2, { usRelevant: 'TRUE' });
check('bare "Bengaluru" (no country label) resolves non-US', { location: 'Bengaluru' }, 1, { usRelevant: 'FALSE' });
check('bare "Warsaw" (no country label) resolves non-US', { location: 'Warsaw' }, 1, { usRelevant: 'FALSE' });

// Rockwell Automation's "2 Locations" display string with a resolvable
// Workday URL hint (Mumbai, India) must NOT fall into the ambiguous
// needs-validation bucket — real evidence beats a vague display string.
const mumbaiHint = workdayUrlHint('https://rockwellautomation.wd1.myworkdayjobs.com/x/job/Mumbai-India/Solution-Consultant_R26-4337');
check('"2 Locations" WITH a resolvable URL hint (Mumbai, India) resolves non-US, not needs-validation', { location: '2 Locations', urlHint: mumbaiHint }, 1, { usRelevant: 'FALSE', needsValidation: false });

// Non-US always excluded from the actionable queue, even when phrased as remote.
check('non-US remote is never promoted to Tier 5', { location: 'Germany · Remote' }, 1, { actionable: false });

// ── Semantic-recall geography regression (real captures, real gap) ────
// A real recall dry-run sampled these three; two of three slipped past the
// classifier as Tier 3 (needs-validation) instead of Tier 1 (excluded)
// before KNOWN_NON_US_CITIES was extended. Brisbane was ALREADY correct
// (matches NON_US_COUNTRY_RE's "australia") — included as a baseline.
check('"Toronto, ON, CAN" (Autodesk, real capture) — province/country abbreviations, not full words', { location: 'Toronto, ON, CAN' }, 1, { usRelevant: 'FALSE' });
check('"Brisbane, Australia" (AVEVA, real capture) — already correct before this fix (full country word)', { location: 'Brisbane, Australia' }, 1, { usRelevant: 'FALSE' });
check('bare "NOIDA" (Cadence, real capture) — no country/state token at all', { location: 'NOIDA' }, 1, { usRelevant: 'FALSE' });

// Ambiguous-but-ok-for-recall cases must NOT be over-tightened into Tier 1 —
// recall still wants a shot at these, per explicit policy.
check('"New York, NY" stays Tier 5 (unaffected by the city-list change)', { location: 'New York, NY' }, 5, { usRelevant: 'TRUE', nycMetro: true });
check('"Remote - United States" stays Tier 5', { location: 'Remote - United States' }, 5, { usRelevant: 'TRUE', remoteUS: true });
check('bare "Remote" (no country context) stays Tier 3 needs-validation, NOT excluded — still eligible for recall', { location: 'Remote' }, 3, { needsValidation: true, usRelevant: 'UNKNOWN' });
check('"3 Locations" (AVEVA, real capture) — vague display string stays Tier 3, not excluded', { location: '3 Locations' }, 3, { needsValidation: true, usRelevant: 'UNKNOWN' });

console.log(`\nlocation-tier: done`);
