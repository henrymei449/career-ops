// tests/location-tier.test.mjs — regression tests for location-tier.mjs,
// the standalone geography classifier for the targeted-company dry-run CSV
// export (NOT career-ops' core location_filter). Canonical policy directive:
// 2026-09-07.
import { pass, fail } from './helpers.mjs';
import { classifyLocation, workdayUrlHint, classifyStructuredWorkplace, classifyLocationFallback, classifyGeography } from '../location-tier.mjs';

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

// ── classifyStructuredWorkplace — stage 1: structured actor metadata ──────
// (2026-09-13) Actual CareerOps geography policy: actionable ONLY if
// REMOTE_US or NYC_COMPATIBLE. Every case the user specified for stage 1,
// plus the scope-boundary regressions that keep this a strict deferral
// (never a decision) for jobs with no structured signal at all.
console.log('\nlocation-tier — classifyStructuredWorkplace (stage 1: structured LinkedIn actor metadata)');

function checkState(label, fn, job, expectedState, expectedReason) {
  const result = fn(job);
  if (result.state !== expectedState || (expectedReason && result.reason !== expectedReason)) {
    fail(`${label}: expected state=${expectedState}${expectedReason ? ` reason=${expectedReason}` : ''}, got ${JSON.stringify(result)}`);
    return;
  }
  pass(`${label} -> ${result.state} (${result.reason})`);
}
const checkWorkplace = (label, job, state, reason) => checkState(label, classifyStructuredWorkplace, job, state, reason);

// 3. Confirmed Remote U.S. from Texas -> REMOTE_US
checkWorkplace('workRemoteAllowed=true, Austin TX (outside NYC)', { location: 'Austin, TX', workRemoteAllowed: true }, 'REMOTE_US', 'structured-remote');

// 4. Confirmed Remote U.S. from California -> REMOTE_US (physical location never matters for REMOTE_US)
checkWorkplace('workRemoteAllowed=true, San Francisco CA', { location: 'San Francisco, CA', workRemoteAllowed: true }, 'REMOTE_US', 'structured-remote');

// 5. California onsite -> REJECT
checkWorkplace('workplaceTypes=["On-site"], San Francisco CA', { location: 'San Francisco, CA', workplaceTypes: ['On-site'] }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');

// 6. Chicago hybrid -> REJECT
checkWorkplace('workplaceTypes="Hybrid", Chicago IL', { location: 'Chicago, IL', workplaceTypes: 'Hybrid' }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');

// 7. Boston onsite -> REJECT
checkWorkplace('workplaceTypes=["On-site"], Boston MA', { location: 'Boston, MA', workplaceTypes: ['On-site'] }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');

// 1/2. NYC onsite / NYC hybrid -> NYC_COMPATIBLE
checkWorkplace('workplaceTypes=["On-site"], New York NY -> NYC onsite', { location: 'New York, NY', workplaceTypes: ['On-site'] }, 'NYC_COMPATIBLE', 'structured-onsite-hybrid-nyc-actionable');
checkWorkplace('workplaceTypes=["Hybrid"], New York NY -> NYC hybrid', { location: 'New York, NY', workplaceTypes: ['Hybrid'] }, 'NYC_COMPATIBLE', 'structured-onsite-hybrid-nyc-actionable');

// Missing workplace metadata -> UNKNOWN (defers to stage 2, never a decision itself)
checkWorkplace('no workRemoteAllowed/workplaceTypes at all, "United States"', { location: 'United States' }, 'UNKNOWN', 'no-structured-workplace-signal');
checkWorkplace('workRemoteAllowed=false (real signal, but no workplaceTypes), "United States"', { location: 'United States', workRemoteAllowed: false }, 'UNKNOWN', 'no-structured-workplace-signal');

// Conflicting/ambiguous metadata -> UNKNOWN
checkWorkplace('workplaceTypes=["Remote","On-site"] conflicting', { location: 'Denver, CO', workplaceTypes: ['Remote', 'On-site'] }, 'UNKNOWN', 'conflicting-workplace-signals');
checkWorkplace('workRemoteAllowed=true AND workplaceTypes=["Hybrid"] conflicting', { location: 'Denver, CO', workRemoteAllowed: true, workplaceTypes: ['Hybrid'] }, 'UNKNOWN', 'conflicting-workplace-signals');

// ── Non-US precedence: clearly non-US overrides a remote signal, never rescued ──
// 8. non-U.S. -> REJECT (via stage 1 when a structured remote signal is present)
checkWorkplace('workRemoteAllowed=true but clearly non-US (Bengaluru) -> REJECT, not REMOTE_US', { location: 'Bengaluru', workRemoteAllowed: true }, 'REJECT', 'non-us-location');
checkWorkplace('workplaceTypes=["Remote"] but clearly non-US (Toronto, ON, CAN) -> REJECT', { location: 'Toronto, ON, CAN', workplaceTypes: ['Remote'] }, 'REJECT', 'non-us-location');

// ── Scope boundary: strict deferral with zero structured signal, even non-US ──
// (No workRemoteAllowed/workplaceTypes at all -- stage 1 alone must never
// decide REJECT on location -- that's stage 2's job, via classifyGeography.)
checkWorkplace('no structured fields at all, non-US location (Warsaw) -> stage 1 alone still defers (UNKNOWN)', { location: 'Warsaw' }, 'UNKNOWN', 'no-structured-workplace-signal');

// ── classifyLocationFallback — stage 2: bare-location validation ──────────
// Runs only when stage 1 is UNKNOWN. Reuses classifyLocation's EXISTING
// NYC-metro boundaries exactly, never broadened. Numeric `tier` is never
// branched on -- only the semantic `bucket`/`remoteUS`/`nycMetro` fields.
console.log('\nlocation-tier — classifyLocationFallback (stage 2: bare-location fallback, no structured metadata)');
const checkFallback = (label, job, state, reason) => checkState(label, classifyLocationFallback, job, state, reason);

// 1/2. NYC onsite / hybrid, no structured metadata at all -> NYC_COMPATIBLE via fallback
checkFallback('bare "New York, NY", no workplace metadata -> NYC_COMPATIBLE', { location: 'New York, NY' }, 'NYC_COMPATIBLE', 'location-tier-nyc-metro');

// 3/4. "Remote - United States" text, no structured metadata -> REMOTE_US via fallback
checkFallback('"Remote - United States" text, no structured metadata -> REMOTE_US', { location: 'Remote - United States' }, 'REMOTE_US', 'location-tier-remote-us-text');

// 5/6/7. Confirmed US non-NYC, no remote signal -> REJECT (the actual policy change:
// no more "lower-priority US geography" pass-through)
checkFallback('bare "San Francisco, CA", no workplace metadata -> REJECT (policy change from old permissive pass-through)', { location: 'San Francisco, CA' }, 'REJECT', 'location-tier-us-non-nyc');
checkFallback('bare "Chicago, IL", no workplace metadata -> REJECT', { location: 'Chicago, IL' }, 'REJECT', 'location-tier-us-non-nyc');
checkFallback('bare "Boston, MA", no workplace metadata -> REJECT', { location: 'Boston, MA' }, 'REJECT', 'location-tier-us-non-nyc');

// 8. non-U.S., no structured metadata -> REJECT via fallback
checkFallback('bare "Warsaw", no workplace metadata -> REJECT', { location: 'Warsaw' }, 'REJECT', 'non-us-location');
checkFallback('bare "Toronto, ON, CAN", no workplace metadata -> REJECT', { location: 'Toronto, ON, CAN' }, 'REJECT', 'non-us-location');

// 9. "United States" + insufficient evidence -> UNKNOWN (stays UNKNOWN even after stage 2)
checkFallback('bare "United States", no workplace metadata -> UNKNOWN (genuinely insufficient)', { location: 'United States' }, 'UNKNOWN', 'location-tier-needs-validation');
checkFallback('vague "3 Locations", no workplace metadata -> UNKNOWN', { location: '3 Locations' }, 'UNKNOWN', 'location-tier-needs-validation');

// ── classifyGeography — the combined gate scan.mjs actually calls ─────────
console.log('\nlocation-tier — classifyGeography (combined stage 1 + stage 2 gate)');
const checkGeo = (label, job, state, reason) => checkState(label, classifyGeography, job, state, reason);

checkGeo('structured remote (TX) resolves at stage 1, fallback never needed', { location: 'Austin, TX', workRemoteAllowed: true }, 'REMOTE_US', 'structured-remote');
checkGeo('structured remote (CA) resolves at stage 1', { location: 'San Francisco, CA', workRemoteAllowed: true }, 'REMOTE_US', 'structured-remote');
checkGeo('structured onsite California resolves REJECT at stage 1', { location: 'San Francisco, CA', workplaceTypes: ['On-site'] }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');
checkGeo('structured hybrid Chicago resolves REJECT at stage 1', { location: 'Chicago, IL', workplaceTypes: ['Hybrid'] }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');
checkGeo('structured onsite Boston resolves REJECT at stage 1', { location: 'Boston, MA', workplaceTypes: ['On-site'] }, 'REJECT', 'structured-onsite-hybrid-outside-nyc');
checkGeo('structured onsite NYC resolves NYC_COMPATIBLE at stage 1', { location: 'New York, NY', workplaceTypes: ['On-site'] }, 'NYC_COMPATIBLE', 'structured-onsite-hybrid-nyc-actionable');
checkGeo('structured hybrid NYC resolves NYC_COMPATIBLE at stage 1', { location: 'New York, NY', workplaceTypes: ['Hybrid'] }, 'NYC_COMPATIBLE', 'structured-onsite-hybrid-nyc-actionable');
checkGeo('non-US (bare, no structured metadata) falls through to stage 2 -> REJECT', { location: 'Warsaw' }, 'REJECT', 'non-us-location');
checkGeo('"United States", no structured metadata, falls through to stage 2 -> UNKNOWN', { location: 'United States' }, 'UNKNOWN', 'location-tier-needs-validation');
checkGeo('bare non-NYC US city, no structured metadata, falls through to stage 2 -> REJECT', { location: 'Chicago, IL' }, 'REJECT', 'location-tier-us-non-nyc');

console.log(`\nlocation-tier: done`);
