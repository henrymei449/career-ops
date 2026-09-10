// tests/apify-jd-cache-data-root.test.mjs — plugins/apify/index.mjs's
// saveJd() used to hardcode JDS_DIR = 'jds', a bare relative path resolved
// against process.cwd() by mkdirSync/writeFileSync. Reproduced live: running
// `node scan.mjs --company linkedin --since 1` from the repo root with
// CAREER_OPS_DATA_DIR pointed elsewhere wrote every LinkedIn JD-cache file
// into <repo>/jds/ instead of <CAREER_OPS_DATA_DIR>/jds/ — orphaning the
// `local:jds/{file}` references already written to data/pipeline.md, which
// resolve against DATA_ROOT via getCareerOpsRoot() (scan.mjs's own `local:`
// reader, outcome.mjs, jd-capture.mjs).
//
// Each test runs in its own subprocess (execFileSync) rather than importing
// the module twice in-process, because JDS_DIR is computed once at module
// load time from getCareerOpsRoot() — re-importing the same specifier in one
// process would just hit Node's module cache and silently reuse the first
// resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, NODE, rmSync } from './helpers.mjs';

// Calls the plugin's (now-exported) saveJd() directly — no APIFY_TOKEN or
// network needed, since saveJd() is pure filesystem + string work. Printed as
// JSON on stdout so the test can assert on both the returned reference and
// where the file actually landed.
const PLUGIN_URL = pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href;
const PROBE = `
import { saveJd, JDS_DIR, JDS_REL } from ${JSON.stringify(PLUGIN_URL)};
const normalized = { title: 'Sales Engineer', company: 'Tristar AI', url: 'https://linkedin.example/jobs/view/1', location: 'United States' };
const relPath = saveJd(normalized, 'A' .repeat(60), 'curious-coder-linkedin-jobs-scraper');
console.log(JSON.stringify({ relPath, JDS_DIR, JDS_REL }));
`;

function runProbe(dataRoot) {
  const out = execFileSync(NODE, ['--input-type=module', '-e', PROBE], {
    cwd: ROOT, // deliberately the repo root — the exact cwd that reproduced the bug
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
  });
  return JSON.parse(out.trim());
}

test('saveJd() writes the JD cache file under CAREER_OPS_DATA_DIR, not under process.cwd()', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-apify-jd-cache-'));
  try {
    const { relPath, JDS_DIR, JDS_REL } = runProbe(dataRoot);

    assert.equal(JDS_REL, 'jds', 'the stored reference stem must stay the bare relative "jds"');
    assert.equal(
      JDS_DIR, join(dataRoot, 'jds'),
      `JDS_DIR must resolve against the configured data root, got ${JDS_DIR}`,
    );
    assert.notEqual(
      JDS_DIR, join(ROOT, 'jds'),
      'JDS_DIR must not fall back to a repo-root-relative path when a data root is configured',
    );

    // The reference returned (and therefore what ends up in local:{relPath})
    // must stay relative — every consumer (scan.mjs's local: reader,
    // outcome.mjs, jd-capture.mjs) resolves it against DATA_ROOT itself.
    assert.match(relPath, /^jds\/[a-z0-9-]+\.md$/, `relPath must be a bare relative "jds/{file}" string, got ${relPath}`);

    const writtenAbsPath = join(dataRoot, relPath);
    assert.ok(existsSync(writtenAbsPath), `expected the JD cache file at ${writtenAbsPath}`);
    assert.equal(
      existsSync(join(ROOT, relPath)), false,
      `the JD cache file must NOT have been written under the repo root (${join(ROOT, relPath)})`,
    );

    const content = readFileSync(writtenAbsPath, 'utf-8');
    assert.match(content, /company: "Tristar AI"/);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('saveJd() is idempotent under the configured data root (second call returns the same relative path, does not throw EEXIST)', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-apify-jd-cache-'));
  try {
    const first = runProbe(dataRoot);
    const second = runProbe(dataRoot);
    assert.equal(first.relPath, second.relPath);
    const files = readdirSync(join(dataRoot, 'jds'));
    assert.equal(files.length, 1, 'a second save of the same posting must not create a second file');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('source guard: JDS_DIR is joined onto getCareerOpsRoot(), not a bare relative string (regression guard)', () => {
  const src = readFileSync(join(ROOT, 'plugins', 'apify', 'index.mjs'), 'utf-8');
  assert.match(
    src, /JDS_DIR\s*=\s*join\(\s*getCareerOpsRoot\(\)\s*,\s*JDS_REL\s*\)/,
    'JDS_DIR must be derived from getCareerOpsRoot(), the same resolver scan.mjs uses for PORTALS_PATH/SCAN_HISTORY_PATH/PIPELINE_PATH',
  );
});
