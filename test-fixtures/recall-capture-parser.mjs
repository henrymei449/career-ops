#!/usr/bin/env node
// Fixture local-parser for tests/recall-capture.test.mjs. Must live in-repo
// (providers/local-parser.mjs refuses a script outside the project root).
// One posting whose title fails a manufacturing-domain title_filter but
// whose company/location/date are otherwise eligible — the exact shape
// Lane B exists for. Location is "Remote - United States", not bare
// "Remote" (2026-09-13): under the "Actual CareerOps geography policy"
// (location-tier.mjs's classifyGeography), a bare "Remote" with no country
// signal resolves UNKNOWN, not REMOTE_US — this fixture's geography isn't
// what these tests are about, so it needs to unambiguously resolve
// REMOTE_US/NYC_COMPATIBLE to keep testing title-filter/provenance
// behavior in isolation from the (separately, exhaustively tested)
// geography gate.
console.log(JSON.stringify([
  { title: 'Customer Deployment Lead', url: 'https://careers.example.com/acme/req-1', location: 'Remote - United States' },
]));
