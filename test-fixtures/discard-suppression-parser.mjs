#!/usr/bin/env node
// Fixture local-parser for tests/discard-suppression.test.mjs. Must live
// in-repo: providers/local-parser.mjs refuses a parser script outside the
// project root (path traversal guard), so a temp-dir fixture cannot be used.
// Prints one fixed posting; the test controls filtering via data/discard.log.
console.log(JSON.stringify([
  { title: 'Solutions Engineer', url: 'https://careers.example.com/deloitte/req-999', location: 'Remote' },
]));
