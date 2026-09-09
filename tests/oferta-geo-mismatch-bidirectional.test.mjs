// tests/oferta-geo-mismatch-bidirectional.test.mjs — modes/oferta.md's Block A
// Geo-mismatch check must flag BOTH conflict directions, not just one (#3512-geo).
//
// Before this fix, the check only fired when the structured location field
// said remote and the JD body added a binding attendance requirement
// (Direction 1). The reverse — a bare/on-site city tag contradicted by a JD
// asserting materially greater remote flexibility (Direction 2) — was
// structurally undetectable, because the flag's own definition named only
// one direction. That gap let the Ellison Technologies evaluation
// (reports/001-ellison-technologies-2026-09-09.md) resolve a
// "Germantown, WI" tag + "predominantly remote" JD straight to Tier 5 with no
// flag at all. This is a text-presence check (oferta.md is agent-followed
// prose, not executable code) — it cannot verify LLM judgment on a real JD,
// but it does guard that the rule text a future edit could silently narrow
// back to one direction stays in the file, worded correctly, for both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const oferta = readFileSync(join(ROOT, 'modes', 'oferta.md'), 'utf-8');
// Isolate the Geo-mismatch section so matches can't accidentally come from an
// unrelated part of this 750+ line file.
const sectionStart = oferta.indexOf('### Geo-mismatch check');
const sectionEnd = oferta.indexOf('### Work-authorization check');
assert.ok(sectionStart !== -1, 'modes/oferta.md must contain a "### Geo-mismatch check" section');
assert.ok(sectionEnd !== -1 && sectionEnd > sectionStart, 'expected "### Work-authorization check" to follow the Geo-mismatch section');
const section = oferta.slice(sectionStart, sectionEnd);

test('Direction 1 (structured=remote, JD=onsite/hybrid/relocation) is present, unchanged flag wording (regression guard)', () => {
  assert.match(section, /Direction 1/, 'Direction 1 must be explicitly labeled');
  for (const term of ['hybrid', 'onsite', 'on-site', 'relocation']) {
    assert.match(section.toLowerCase(), new RegExp(term), `Direction 1 trigger term "${term}" missing`);
  }
  assert.match(
    section,
    /`⚠️ \*\*Geo-mismatch:\*\* location field says remote, but JD body says "\{verbatim JD line\}"`/,
    'the original Direction 1 flag template text must be preserved verbatim',
  );
});

test('Direction 2 (structured=onsite/bare city, JD=materially remote) is present with its own flag template', () => {
  assert.match(section, /Direction 2/, 'Direction 2 must be explicitly labeled');
  for (const phrase of ['predominantly remote', 'remote-first', 'fully remote', 'work from anywhere']) {
    assert.match(section, new RegExp(phrase), `Direction 2 trigger phrase "${phrase}" missing`);
  }
  assert.match(
    section,
    /`⚠️ \*\*Geo-mismatch:\*\* location field says "\{structured location\/designation\}", but JD body says "\{verbatim JD line\}"`/,
    'Direction 2 needs its own flag template distinct from Direction 1\'s',
  );
});

test('the check never resolves a conflict itself and defers to the location policy (Tier 3 for workplace-type conflicts)', () => {
  assert.match(section, /never picks a side or assigns a tier/i);
  assert.match(section, /modes\/_profile\.md/);
  assert.match(section, /Tier 3/);
});

test('scenario: bare on-site city tag + "predominantly remote" JD text matches Direction 2, not Direction 1', () => {
  // Regression for the exact Ellison Technologies shape: a plain city/state
  // string (no "remote" in the tag itself) contradicted by JD body language.
  const structuredField = 'Germantown, WI';
  const jdLine = 'This role is predominantly remote... proximity to this region is helpful but not required.';
  const looksRemoteInTag = /remote/i.test(structuredField);
  const jdAssertsRemote = /predominantly remote|remote-first|fully remote|work from anywhere/i.test(jdLine);
  assert.equal(looksRemoteInTag, false, 'the structured field itself must not read as remote (else this would be Direction 1, not 2)');
  assert.equal(jdAssertsRemote, true, 'the JD line must trip Direction 2\'s trigger phrase set as documented in oferta.md');
});

test('scenario: "Remote - United States" tag + JD confirming remote is NOT a conflict in either direction', () => {
  const structuredField = 'Remote - United States';
  const jdLine = 'This is a fully remote position; you may work from anywhere in the US.';
  const tagIsRemote = /remote/i.test(structuredField);
  const jdHasBindingAttendance = /hybrid|onsite|on-site|in-office|relocation/i.test(jdLine);
  const jdAssertsRemote = /predominantly remote|remote-first|fully remote|work from anywhere/i.test(jdLine);
  // Direction 1 needs tagIsRemote && jdHasBindingAttendance; Direction 2 needs
  // a non-remote tag. Neither condition set is met here — agreement, not conflict.
  assert.equal(tagIsRemote && jdHasBindingAttendance, false, 'Direction 1 must not fire when JD confirms remote (no attendance requirement present)');
  assert.equal(!tagIsRemote && jdAssertsRemote, false, 'Direction 2 must not fire — the tag already says remote, so there is no bare/on-site city to contradict');
});

test('scenario: plain city tag with no remote language in the JD is NOT a conflict (Tier 2 default, not a mismatch)', () => {
  const structuredField = 'Chicago, IL';
  const jdLine = 'Join our downtown Chicago office to lead manufacturing operations.';
  const tagIsRemote = /remote/i.test(structuredField);
  const jdAssertsRemote = /predominantly remote|remote-first|fully remote|work from anywhere/i.test(jdLine);
  assert.equal(tagIsRemote, false);
  assert.equal(jdAssertsRemote, false, 'no Direction 2 trigger phrase present — silence is absence of signal per the "Common to both directions" rule, not a mismatch');
});
