// tests/fixtures/three-city-board.mjs — a local-parser fixture board.
//
// Emits ONE role posted at THREE URLs, one per city — the shape that leaked a
// city variant per scan before the company+role key was seeded across runs.
// Used by tests/scan-company-role-dedup.test.mjs; no network involved.
//
// local-parser requires the script to live inside the project root and to be
// the interpreter's first argument, and runs it with cwd pinned to the repo
// root. It reads a JSON array (or {jobs:[]}) off stdout.
//
// Three DISTINCT cities, chosen (2026-09-13) to all independently resolve
// NYC_COMPATIBLE under location-tier.mjs's classifyGeography -- the "Actual
// CareerOps geography policy" now rejects a confirmed US location outside
// approved NYC geography, so this dedup-key fixture (which is about city
// distinctness, not geography acceptability) has to stay inside that
// boundary for its jobs to reach the pipeline at all. Originally Costa Mesa
// CA / Washington DC / Huntsville AL -- any three distinct real places work
// for what this fixture tests.
const ROLE = 'Strategic Finance Manager';

console.log(JSON.stringify([
  { title: ROLE, url: 'https://boards.example.com/fixture/1001', company: 'Fixture Defense', location: 'New York, NY' },
  { title: ROLE, url: 'https://boards.example.com/fixture/1002', company: 'Fixture Defense', location: 'Jersey City, NJ' },
  { title: ROLE, url: 'https://boards.example.com/fixture/1003', company: 'Fixture Defense', location: 'Stamford, CT' },
]));
