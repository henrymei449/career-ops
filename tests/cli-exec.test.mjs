// tests/cli-exec.test.mjs — the Windows npm-.cmd-shim fix. Root cause
// (confirmed empirically during development): execFileSync('claude', ...)
// -> ENOENT (no PATHEXT resolution without shell:true); execFileSync
// ('claude.cmd', ...) -> EINVAL (Node cannot spawn a .bat/.cmd directly).
// shell:true was rejected (untrusted text in the prompt argument); a
// cmd.exe /c workaround was tried and reverted (silently mangled the
// prompt). The fix resolves the shim's REAL target and invokes it
// directly, argv-only, no shell -- so every character in an argument
// (including a full JD body) survives untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, NODE } from './helpers.mjs';
import { resolveShimTarget, resolveCliTarget, findOnPath, execCliSafely } from '../cli-exec.mjs';

// ── resolveShimTarget: pure string parsing, no filesystem ───────────────

test('resolveShimTarget: resolves a .exe-wrapping shim (this machine\'s actual claude.cmd shape)', () => {
  const content = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\r\n');
  const result = resolveShimTarget(content, 'C:\\Users\\test\\AppData\\Roaming\\npm');
  // A doubled backslash here is correct, real behavior, not a bug: real
  // %~dp0 already ends in a backslash, and the shim's own text adds
  // another literal one — confirmed this resolves identically to Windows
  // fs APIs regardless (existsSync('a\\\\b') === existsSync('a\\b')).
  assert.deepEqual(result, {
    file: 'C:\\Users\\test\\AppData\\Roaming\\npm\\\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    prefixArgs: [],
  });
});

test('resolveShimTarget: resolves a node-script-wrapping shim with node.exe quoted BY PATH (a common real shape)', () => {
  const content = '"%dp0%\\node.exe"  "%dp0%\\node_modules\\some-cli\\bin\\cli.js" %*';
  const result = resolveShimTarget(content, 'C:\\npm');
  // Both the interpreter AND the script must be captured — matching only the
  // quoted node.exe and discarding the script argument was a real bug caught
  // here during development (the single-.exe pattern matched first and won).
  assert.deepEqual(result, { file: 'C:\\npm\\\\node.exe', prefixArgs: ['C:\\npm\\\\node_modules\\some-cli\\bin\\cli.js'] });
});

test('resolveShimTarget: a genuine node-script shim without an explicit node.exe path', () => {
  const content = 'node  "%dp0%\\node_modules\\some-cli\\bin\\cli.js" %*';
  const result = resolveShimTarget(content, 'C:\\npm');
  assert.equal(result.file, process.execPath);
  assert.deepEqual(result.prefixArgs, ['C:\\npm\\\\node_modules\\some-cli\\bin\\cli.js']);
});

test('resolveShimTarget: an unrecognized shape returns null (caller falls back safely)', () => {
  assert.equal(resolveShimTarget('echo hello world', 'C:\\npm'), null);
});

// ── findOnPath ────────────────────────────────────────────────────────

test('findOnPath: finds a file in one of several PATH directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-exec-'));
  try {
    writeFileSync(join(dir, 'marker.cmd'), '@echo off\n');
    const fakePath = ['C:\\does\\not\\exist', dir, 'C:\\also\\missing'].join(process.platform === 'win32' ? ';' : ':');
    const found = findOnPath('marker.cmd', fakePath);
    assert.equal(found, join(dir, 'marker.cmd'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findOnPath: returns null when nothing matches', () => {
  assert.equal(findOnPath('definitely-not-a-real-file.cmd', 'C:\\nope'), null);
});

// ── resolveCliTarget: platform behavior ──────────────────────────────────

test('resolveCliTarget: non-Windows is always a no-op passthrough', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(resolveCliTarget('claude'), { file: 'claude', prefixArgs: [] });
});

test('resolveCliTarget: a bin already carrying .exe/.cmd/.bat is left alone (caller\'s explicit choice)', () => {
  assert.deepEqual(resolveCliTarget('something.exe'), { file: 'something.exe', prefixArgs: [] });
});

test('resolveCliTarget: no shim found on PATH falls back to the bare bin name unchanged', () => {
  const result = resolveCliTarget('definitely-not-a-real-cli-xyz');
  assert.deepEqual(result, { file: 'definitely-not-a-real-cli-xyz', prefixArgs: [] });
});

// ── execCliSafely: byte-for-byte argv fidelity — the actual requirement ──
// A fixture .cmd shim wrapping a real node "echo-argv" script, mimicking
// the exact npm-install shape, so the real resolve-then-exec path is
// exercised end-to-end (not just the string parser in isolation).

function makeFixtureShim() {
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-exec-fixture-'));
  const echoScript = join(dir, 'echo-argv.mjs');
  writeFileSync(echoScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const shimPath = join(dir, 'fake-echo-cli.cmd');
  writeFileSync(shimPath, `"${NODE}" "${echoScript}" %*\n`);
  return { dir, shimPath };
}

const TRICKY_STRINGS = [
  ['spaces', 'Solutions Engineer II'],
  ['double quotes', '"Customer Deployment Lead"'],
  ['apostrophe', "Manufacturer's Solutions Engineer"],
  ['ampersand', 'R&D Manufacturing Engineer'],
  ['parentheses', 'Solutions Engineer (Remote, US)'],
  ['percent sign (cmd.exe env-var trigger)', '100% Remote Solutions Engineer'],
  ['caret (cmd.exe escape char)', 'Solutions Engineer ^ MES'],
  ['pipe (shell metacharacter)', 'Engineer | Manufacturing'],
  ['CJK unicode', '日本市場 セールス マネージャー'],
  ['emoji / astral unicode', '🏭 Factory Ops Lead'],
  ['backtick', 'Engineer `rm -rf /` Test'],
  ['dollar sign', 'Engineer $100k OTE'],
  [
    'multiline JD-shaped text',
    'Line one.\nLine two with a\ttab.\nLine three: "quoted", it\'s here, 50% & (parenthetical) — done.',
  ],
];

// resolveCliTarget's own PATH probing (findOnPath) reads process.env.PATH
// directly (the parent process's real environment) BEFORE anything spawns
// — passing a custom PATH only via execFileSync's `opts.env` has no effect
// on that resolution step, since that only changes the CHILD's environment
// after the target is already resolved. Tests must therefore temporarily
// mutate the real process.env.PATH, not opts.env.
function withPrependedPath(dir, fn) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const original = process.env.PATH;
  process.env.PATH = `${dir}${sep}${original}`;
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

for (const [label, value] of TRICKY_STRINGS) {
  test(`execCliSafely: preserves "${label}" byte-for-byte through the fixture shim`, () => {
    const { dir, shimPath } = makeFixtureShim();
    try {
      const opts = { encoding: 'utf-8', timeout: 15000 };
      const out = process.platform === 'win32'
        ? withPrependedPath(dir, () => execCliSafely('fake-echo-cli', ['-p', value], opts))
        : execFileSync(NODE, [join(dir, 'echo-argv.mjs'), '-p', value], opts);
      const argv = JSON.parse(out);
      assert.deepEqual(argv, ['-p', value], `expected the exact string to survive, got ${JSON.stringify(argv)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      void shimPath;
    }
  });
}

// ── Live-CLI integration (gated — real API call, real cost) ──────────────
// Not run in the default suite (test-all.mjs / CI never sets this env var).
// Run manually with: CAREER_OPS_LIVE_CLI_TEST=1 node --test tests/cli-exec.test.mjs

test(
  'LIVE: a sentinel embedded in a real prompt reaches the real claude CLI intact, returns parseable JSON',
  { skip: process.env.CAREER_OPS_LIVE_CLI_TEST !== '1' ? 'set CAREER_OPS_LIVE_CLI_TEST=1 to run (real API call, real cost)' : false },
  () => {
    const sentinel = `CLI-EXEC-SENTINEL-${Date.now()}`;
    const prompt = `Reply with ONLY this exact JSON, no prose, no markdown fences: [{"id": 0, "sentinel_echo": "${sentinel}"}]`;
    const out = execCliSafely('claude', ['-p', prompt, '--model', 'claude-sonnet-5', '--output-format', 'json', '--no-session-persistence'], {
      encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 60000,
    });
    const envelope = JSON.parse(out);
    assert.equal(typeof envelope.result, 'string');
    const start = envelope.result.indexOf('[');
    const end = envelope.result.lastIndexOf(']');
    const parsed = JSON.parse(envelope.result.slice(start, end + 1));
    assert.equal(parsed[0].sentinel_echo, sentinel, 'the sentinel must survive the full argv path into the live CLI and back, byte-for-byte');
  },
);

test('execCliSafely: a sentinel string round-trips through the full resolve+exec path with a realistic multi-arg call', () => {
  const { dir } = makeFixtureShim();
  try {
    const sentinel = `SENTINEL-${Date.now()}-"quoted"-&-100%-\`backtick\`-日本語`;
    const opts = { encoding: 'utf-8', timeout: 15000 };
    const out = process.platform === 'win32'
      ? withPrependedPath(dir, () => execCliSafely('fake-echo-cli', ['-p', sentinel, '--output-format', 'json', '--model', 'claude-sonnet-5'], opts))
      : execFileSync(NODE, [join(dir, 'echo-argv.mjs'), '-p', sentinel, '--output-format', 'json', '--model', 'claude-sonnet-5'], opts);
    const argv = JSON.parse(out);
    assert.deepEqual(argv, ['-p', sentinel, '--output-format', 'json', '--model', 'claude-sonnet-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
