// tests/plugin-config-under-data-root.test.mjs — config/plugins.yml (and the
// .env secrets it depends on) must resolve from the DATA root, never the CODE
// root, when the two differ (#3512).
//
// DATA_CONTRACT.md lists config/plugins.yml as a User Layer file: "Your plugin
// activation toggles." Before this fix, plugins/_engine.mjs's mergeProviderPlugins
// / loadPlugins / runHook, plugins.mjs's cmdList/cmdRun/setEnabled, and scan.mjs's
// provider-plugin merge all resolved config/plugins.yml (and loadDotenvOnce's
// .env) relative to the codebase checkout — the same class of bug fixed for
// System Layer files under #3500 (tests/system-layer-under-data-root.test.mjs),
// but inverted: there a System Layer file leaked onto the data root; here a
// User Layer file was pinned to the code root and never saw a configured
// CAREER_OPS_DATA_DIR/CAREER_OPS_ROOT at all.
//
// A plugin enabled by hand-editing config/plugins.yml under a Google-Drive-synced
// data root (the documented, supported way to opt in) silently read as
// "disabled" everywhere — scan.mjs's own portals.yml entries referencing
// `provider: <id>` never fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

function demoProviderPlugin(dir, id, requiredEnv = []) {
  mkdirSync(join(dir, 'plugins', id), { recursive: true });
  writeFileSync(join(dir, 'plugins', id, 'manifest.json'), JSON.stringify({
    id, apiVersion: 1, description: `demo provider ${id}`, hooks: ['provider'],
    requiredEnv, allowedHosts: ['api.demo.test'], humanInTheLoop: true,
  }));
  writeFileSync(join(dir, 'plugins', id, 'index.mjs'),
    `export default { provider: { id: "${id}", detect(){ return null; }, ` +
    `async fetch(){ return [{ title: "T", url: "https://api.demo.test/1" }]; } } };`);
}

function demoIngestPlugin(dir, id) {
  mkdirSync(join(dir, 'plugins', id), { recursive: true });
  writeFileSync(join(dir, 'plugins', id, 'manifest.json'), JSON.stringify({
    id, apiVersion: 1, description: `demo ingest ${id}`, hooks: ['ingest'], humanInTheLoop: true,
  }));
  writeFileSync(join(dir, 'plugins', id, 'index.mjs'),
    'export default { ingest: async () => [{ title: "found", url: "https://api.demo.test/2" }] };');
}

test('mergeProviderPlugins reads config/plugins.yml from dataRoot, not root, when they differ (#3512)', async () => {
  const { mergeProviderPlugins } = await import(pathToFileURL(join(ROOT, 'plugins/_engine.mjs')).href);
  const codeRoot = mkdtempSync(join(tmpdir(), 'co-plugin-code-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-plugin-data-'));
  try {
    demoProviderPlugin(codeRoot, 'demo-dr');
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'plugins.yml'), 'plugins:\n  demo-dr: { enabled: true }\n');

    const map = new Map();
    await mergeProviderPlugins(map, { root: codeRoot, dataRoot });
    const provider = map.get('demo-dr');
    if (provider) {
      const result = await provider.fetch({});
      if (Array.isArray(result) && result.length === 1) {
        pass('mergeProviderPlugins merges a plugin enabled only in dataRoot/config/plugins.yml (#3512)');
      } else {
        fail(`demo-dr provider merged but fetch() returned ${JSON.stringify(result)}`);
        assert.fail('fetch() result mismatch');
      }
    } else {
      fail('mergeProviderPlugins did not merge a plugin enabled in dataRoot/config/plugins.yml');
      assert.fail('plugin not merged from dataRoot config');
    }
  } finally {
    rmSync(codeRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('mergeProviderPlugins does NOT fall back to reading config/plugins.yml from root (regression guard, #3512)', async () => {
  const { mergeProviderPlugins } = await import(pathToFileURL(join(ROOT, 'plugins/_engine.mjs')).href);
  const codeRoot = mkdtempSync(join(tmpdir(), 'co-plugin-code2-'));
  const emptyDataRoot = mkdtempSync(join(tmpdir(), 'co-plugin-data2-'));
  try {
    demoProviderPlugin(codeRoot, 'demo-dr2');
    // Config placed at the OLD (wrong) location: codeRoot, not dataRoot.
    mkdirSync(join(codeRoot, 'config'), { recursive: true });
    writeFileSync(join(codeRoot, 'config', 'plugins.yml'), 'plugins:\n  demo-dr2: { enabled: true }\n');

    const map = new Map();
    await mergeProviderPlugins(map, { root: codeRoot, dataRoot: emptyDataRoot });
    if (!map.has('demo-dr2')) {
      pass('mergeProviderPlugins ignores a stray config/plugins.yml left under root once dataRoot is set (#3512)');
    } else {
      fail('mergeProviderPlugins merged a plugin whose config only existed under root — old resolution leaked back in');
      assert.fail('config/plugins.yml under root should not be read once dataRoot is configured');
    }
  } finally {
    rmSync(codeRoot, { recursive: true, force: true });
    rmSync(emptyDataRoot, { recursive: true, force: true });
  }
});

test('loadPlugins/runHook read config/plugins.yml from dataRoot for non-provider hooks too (#3512)', async () => {
  const { loadPlugins, runHook } = await import(pathToFileURL(join(ROOT, 'plugins/_engine.mjs')).href);
  const codeRoot = mkdtempSync(join(tmpdir(), 'co-plugin-code3-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-plugin-data3-'));
  try {
    demoIngestPlugin(codeRoot, 'demo-ingest-dr');
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'plugins.yml'), 'plugins:\n  demo-ingest-dr: { enabled: true }\n');

    const loaded = await loadPlugins('ingest', { root: codeRoot, dataRoot });
    const results = await runHook('ingest', null, { root: codeRoot, dataRoot, pluginId: 'demo-ingest-dr' });
    if (loaded.length === 1 && loaded[0].id === 'demo-ingest-dr' && results.length === 1 && results[0].ok) {
      pass('loadPlugins/runHook resolve config/plugins.yml via dataRoot (#3512)');
    } else {
      fail(`loadPlugins/runHook did not pick up dataRoot config: loaded=${loaded.length}, results=${JSON.stringify(results)}`);
      assert.fail('dataRoot config not honored by loadPlugins/runHook');
    }
  } finally {
    rmSync(codeRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('loadDotenvOnce reads .env from the resolved data root, not process.cwd() (#3512)', () => {
  // Module-level `dotenvLoaded` state makes this only safe to exercise once per
  // process — run it in a fresh child, same isolation tests/system-layer-under-
  // data-root.test.mjs uses for getCareerOpsRoot()-dependent behavior.
  const dataRoot = mkdtempSync(join(tmpdir(), 'co-plugin-dotenv-'));
  try {
    writeFileSync(join(dataRoot, '.env'), 'CO_TEST_DOTENV_MARKER=found-via-dataroot\n');
    const snippet =
      `import('./plugins/_engine.mjs').then(async m => { ` +
      `await m.loadDotenvOnce(); console.log(process.env.CO_TEST_DOTENV_MARKER || '(unset)'); })`;
    const out = execFileSync(NODE, ['-e', snippet], {
      cwd: ROOT, // CWD is the repo root, on purpose — proves it's NOT cwd-sourced
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '' },
    }).trim();
    out === 'found-via-dataroot'
      ? pass('loadDotenvOnce loads .env from getCareerOpsRoot(), independent of process.cwd() (#3512)')
      : fail(`loadDotenvOnce produced "${out}", expected "found-via-dataroot"`);
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
