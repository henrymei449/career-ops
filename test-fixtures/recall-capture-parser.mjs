#!/usr/bin/env node
// Fixture local-parser for tests/recall-capture.test.mjs. Must live in-repo
// (providers/local-parser.mjs refuses a script outside the project root).
// One posting whose title fails a manufacturing-domain title_filter but
// whose company/location/date are otherwise eligible — the exact shape
// Lane B exists for.
console.log(JSON.stringify([
  { title: 'Customer Deployment Lead', url: 'https://careers.example.com/acme/req-1', location: 'Remote' },
]));
