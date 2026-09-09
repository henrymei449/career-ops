// tests/audit-providers-under-data-root.test.mjs — the audit tools must load
// providers/ from the CODE root, never the configured data root (#3500-class).
//
// providers/ is System Layer: it ships with the codebase and never exists under
// a user's CAREER_OPS_DATA_DIR. audit-portals.mjs and verify-pipeline.mjs's
// check 15 both resolved it through getCareerOpsRoot(), so under any separate
// data root loadProviders() returned an EMPTY Map and every enabled entry —
// including ones with a valid explicit `provider:` field — was reported as
// "no provider claims this". That made both tools useless exactly where they
// matter most: a real install with personal data on a different drive.
//
// This is the sibling of tests/system-layer-under-data-root.test.mjs, which
// guards the same class for templates/states.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NODE, rmSync } from './helpers.mjs';

/** A data root that contains portals.yml but (correctly) no providers/ dir. */
function makeDataRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'co-audit-dataroot-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'portals.yml'),
    [
      'tracked_companies:',
      '  - name: Explicit Provider Co',
      '    careers_url: https://acme.wd1.myworkdayjobs.com/External',
      '    provider: workday',
      '    enabled: true',
      '  - name: Autodetect Co',
      '    careers_url: https://job-boards.greenhouse.io/example',
      '    enabled: true',
      '',
    ].join('\n'),
  );
  return dir;
}

test('audit-portals.mjs resolves providers from the code root under a configured data root', () => {
  const dataRoot = makeDataRoot();
  try {
    const out = execFileSync(NODE, [join(ROOT, 'audit-portals.mjs'), '--json'], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
    });
    const rows = JSON.parse(out);
    const explicit = rows.find(r => r.name === 'Explicit Provider Co');
    const autodetect = rows.find(r => r.name === 'Autodetect Co');

    assert.ok(explicit, 'explicit-provider entry must appear in the audit output');
    assert.notEqual(
      explicit.verdict, 'no-provider',
      'an entry with `provider: workday` must resolve — "no-provider" means providers/ was loaded from the data root',
    );
    assert.equal(explicit.provider, 'workday');

    assert.ok(autodetect, 'auto-detect entry must appear in the audit output');
    assert.notEqual(
      autodetect.verdict, 'no-provider',
      'a greenhouse.io careers_url must auto-detect — "no-provider" means the registry was empty',
    );
    assert.equal(autodetect.provider, 'greenhouse');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-pipeline.mjs check 15 does not report valid entries as unclaimed under a data root', () => {
  const dataRoot = makeDataRoot();
  try {
    let out = '';
    try {
      out = execFileSync(NODE, [join(ROOT, 'verify-pipeline.mjs')], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 120000,
        env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: dataRoot, CAREER_OPS_PORTALS: '' },
      });
    } catch (err) {
      // Non-zero exit is fine here (other checks may fail on a bare fixture);
      // this test only asserts on check 15's own lines.
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    assert.doesNotMatch(
      out,
      /"Explicit Provider Co" is enabled but no provider claims/,
      'check 15 flagged an entry with a valid explicit provider — providers/ resolved from the wrong root',
    );
    assert.doesNotMatch(
      out,
      /"Autodetect Co" is enabled but no provider claims/,
      'check 15 flagged an auto-detectable greenhouse.io entry — providers/ resolved from the wrong root',
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('neither audit tool hardcodes providers/ onto the data root', () => {
  // Source-level guard against reintroducing the class, mirroring #3500's scan.
  for (const file of ['audit-portals.mjs', 'verify-pipeline.mjs']) {
    const src = readFileSync(join(ROOT, file), 'utf-8');
    const dataVars = [...src.matchAll(/const\s+(\w+)\s*=\s*getCareerOpsRoot\(\)/g)].map(m => m[1]);
    for (const v of dataVars) {
      const re = new RegExp(`join\\(\\s*${v}\\s*,\\s*['"\`]providers['"\`]`, 'g');
      assert.equal(
        re.test(src), false,
        `${file}: providers/ is joined onto ${v} (a getCareerOpsRoot() value) — it must resolve from the code root`,
      );
    }
  }
});
