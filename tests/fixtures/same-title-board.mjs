// tests/fixtures/same-title-board.mjs — a local-parser fixture board.
//
// Emits TWO different postings with the SAME title under the board's own name —
// the shape of a multi-employer feed (a Telegram channel, a VC portfolio board),
// where identical titles are different employers' jobs. Used by
// tests/scan-aggregator-dedup.test.mjs; no network involved.
//
// Location is "Remote - United States" (2026-09-13, was '') so both postings
// clear location-tier.mjs's classifyGeography gate under the "Actual
// CareerOps geography policy" — a blank location now resolves UNKNOWN and is
// rejected before this fixture's actual subject (aggregator same-title
// dedup behavior) ever gets exercised. The location value itself is
// otherwise irrelevant to what this fixture tests.
console.log(JSON.stringify([
  { title: 'Backend Engineer', url: 'https://t.me/fixturejobs/101', company: 'Fixture Feed', location: 'Remote - United States' },
  { title: 'Backend Engineer', url: 'https://t.me/fixturejobs/102', company: 'Fixture Feed', location: 'Remote - United States' },
]));
