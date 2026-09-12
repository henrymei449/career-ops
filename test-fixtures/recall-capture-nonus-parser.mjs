#!/usr/bin/env node
// Fixture local-parser for tests/recall-capture.test.mjs's geography-gate
// integration test. Must live in-repo (providers/local-parser.mjs refuses a
// parser script outside the project root). Same shape as the real Autodesk
// capture that originally slipped through the recall pool before the
// location-tier.mjs fix.
console.log(JSON.stringify([
  { title: 'Customer Deployment Lead', url: 'https://careers.example.com/acme/req-toronto', location: 'Toronto, ON, CAN' },
]));
