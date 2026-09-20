// Scheduler / wrapper / lock checks for the semiconductor SUPPLIERS cohort.
// Non-discovery only: the wrapper is exercised against a TEMP data root with a STUB runner,
// and the real runner is only ever asked for its read-only `--check-lock` verdict.
// Nothing here scans a company, touches the real lock, or triggers a scheduled task.
// Machine-local: skipped when there is no data root (or not Windows PowerShell / Task Scheduler).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dirname, '..');
const marker = join(REPO_ROOT, '.career-ops-data');
const DATA_ROOT = process.env.CAREER_OPS_DATA_DIR || (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '');
const SCHED = join(DATA_ROOT || '.', 'scheduler');
const WRAPPER = join(SCHED, 'scan-semiconductor-suppliers.ps1');
const RUNNER = join(DATA_ROOT || '.', 'run-semiconductor-suppliers-cohort.mjs');
const SUPPLIER_COHORT = join(DATA_ROOT || '.', 'semiconductor-suppliers-companies.yml');
const haveFiles = Boolean(DATA_ROOT) && [WRAPPER, RUNNER, SUPPLIER_COHORT].every(existsSync);
const win = process.platform === 'win32';
const filesOpts = { skip: haveFiles ? false : 'data root wrapper/runner not present' };
const psOpts = { skip: haveFiles && win ? false : 'needs the data root and Windows PowerShell' };

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
const tempRoot = () => { const d = mkdtempSync(join(tmpdir(), 'sup-sched-')); temps.push(d); mkdirSync(join(d, 'data'), { recursive: true }); return d; };

// A stand-in runner. It records that it ran, what the lock looked like WHILE it ran, and
// its parent pid, then behaves per STUB_MODE. It scans nothing.
const STUB = `
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const lockFile = join(root, 'data', '.discovery-scheduler.lock');
const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8').replace(/^\\uFEFF/, '')) : null;
appendFileSync(join(root, 'stub-ran.txt'), JSON.stringify({ ppid: process.ppid, lockPid: lock && lock.pid, lockJob: lock && lock.job }) + '\\n');
const mode = process.env.STUB_MODE || 'ok';
if (mode === 'hang') {
  setTimeout(() => {}, 120000);
} else {
  writeFileSync(join(root, 'data', 'semiconductor-suppliers-cohort-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), source: 'semiconductor-suppliers',
    results: [{ name: 'Stub Co', ok: true, coverageOutcome: mode === 'company-fail' ? 'provider_failed' : 'provider_ok', discovery: 'provider' }],
  }));
  console.log(JSON.stringify({ source: 'semiconductor-suppliers', status: 'ok-empty', survivor_count: 0, batch_id: null }, null, 2));
  console.log('discovery-report: {"path":"stub"}');
  process.exit(mode === 'exit7' ? 7 : 0);
}
`;

function runWrapper(root, mode, timeoutSeconds = 60) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WRAPPER, '-DataRoot', root, '-TimeoutSeconds', String(timeoutSeconds)], {
    encoding: 'utf8', env: { ...process.env, STUB_MODE: mode }, timeout: 90000,
  });
}
function rootWithStub() {
  const root = tempRoot();
  writeFileSync(join(root, 'run-semiconductor-suppliers-cohort.mjs'), STUB);
  return root;
}
const lockPath = (root) => join(root, 'data', '.discovery-scheduler.lock');
const logText = (root) => {
  const dir = join(root, 'logs', 'discovery');
  return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join(String.fromCharCode(10)) : '';
};
const holdLock = (root, pid, job = 'other-job') => writeFileSync(lockPath(root), JSON.stringify({ pid, job, startedAt: new Date().toISOString(), host: 'test' }));
function liveOtherPid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}

// ── wrapper behaviour (real wrapper, temp root, stub runner) ────────────────

test('wrapper: lock free -> acquires the shared lock BEFORE launching the runner, runs it, logs the handoff, and releases the lock', psOpts, () => {
  const root = rootWithStub();
  const r = runWrapper(root, 'ok');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ran = readFileSync(join(root, 'stub-ran.txt'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ran.length, 1, 'runner launched exactly once');
  assert.equal(ran[0].lockJob, 'semiconductor-suppliers', 'lock was held (under this job name) while the runner ran');
  assert.equal(ran[0].lockPid, ran[0].ppid, 'the lock is owned by the runner\'s parent wrapper process');
  assert.equal(existsSync(lockPath(root)), false, 'lock released on normal completion');
  const log = logText(root);
  assert.match(log, /Semiconductor suppliers discovery starting/);
  assert.match(log, /supplier cohort: 1 companies, 0 failure\(s\)/);
  assert.match(log, /source-run handoff: status=ok-empty/);
  assert.match(log, /Semiconductor suppliers discovery finished/);
});

test('wrapper: lock held by a live discovery job -> logs the skip, exits 0, does NOT run the runner, leaves the other job\'s lock alone', psOpts, () => {
  const root = rootWithStub();
  const other = liveOtherPid();
  try {
    holdLock(root, other.pid);
    const r = runWrapper(root, 'ok');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(join(root, 'stub-ran.txt')), false, 'runner must NOT be launched while the lock is held');
    assert.equal(existsSync(join(root, 'data', 'semiconductor-suppliers-cohort-results.json')), false);
    assert.match(logText(root), /Skipped: another discovery job holds the lock/);
    const still = JSON.parse(readFileSync(lockPath(root), 'utf8'));
    assert.equal(still.pid, other.pid, 'the other job\'s lock is untouched');
    assert.equal(still.job, 'other-job');
  } finally { other.kill(); }
});

test('wrapper: stale lock (dead pid) is reclaimed, the runner runs, and the lock is released', psOpts, () => {
  const root = rootWithStub();
  const dead = liveOtherPid(); const deadPid = dead.pid; dead.kill();
  // wait for the pid to actually be gone
  const t0 = Date.now(); while (Date.now() - t0 < 3000) { try { process.kill(deadPid, 0); } catch { break; } }
  holdLock(root, deadPid, 'crashed-job');
  const r = runWrapper(root, 'ok');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(root, 'stub-ran.txt'), 'utf8').trim().split('\n').length, 1);
  assert.equal(existsSync(lockPath(root)), false);
});

test('wrapper: runner failure (non-zero exit) is propagated and the lock is still released', psOpts, () => {
  const root = rootWithStub();
  const r = runWrapper(root, 'exit7');
  assert.equal(r.status, 7);
  assert.equal(existsSync(lockPath(root)), false, 'lock released on failure');
  assert.match(logText(root), /exit code: 7/);
});

test('wrapper: a failed company in the results file exits 3 (retry-eligible) and releases the lock', psOpts, () => {
  const root = rootWithStub();
  const r = runWrapper(root, 'company-fail');
  assert.equal(r.status, 3);
  assert.equal(existsSync(lockPath(root)), false);
  assert.match(logText(root), /Company scan failed: Stub Co/);
});

test('wrapper: watchdog kills a wedged runner, exits non-zero, and releases the lock', psOpts, () => {
  const root = rootWithStub();
  const r = runWrapper(root, 'hang', 2);
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(lockPath(root)), false, 'lock released after a watchdog kill');
  assert.match(logText(root), /TIMEOUT: run-semiconductor-suppliers-cohort\.mjs exceeded 2s/);
});

// ── runner's read-only lock verdict (real runner copied into a temp root) ───

function runnerVerdict(root, extra = {}) {
  const r = spawnSync(process.execPath, [join(root, 'run-semiconductor-suppliers-cohort.mjs'), '--check-lock'], { encoding: 'utf8', timeout: 30000, ...extra });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null };
}
function rootWithRealRunner() {
  const root = tempRoot();
  copyFileSync(RUNNER, join(root, 'run-semiconductor-suppliers-cohort.mjs'));
  copyFileSync(SUPPLIER_COHORT, join(root, 'semiconductor-suppliers-companies.yml'));
  return root;
}

test('runner --check-lock: none / stale / held-by-parent proceed; held-by-other refuses (exit 2); never scans', filesOpts, () => {
  const root = rootWithRealRunner();
  assert.deepEqual(runnerVerdict(root), { status: 0, out: { state: 'none' } });
  const dead = liveOtherPid(); const deadPid = dead.pid; dead.kill();
  const t0 = Date.now(); while (Date.now() - t0 < 3000) { try { process.kill(deadPid, 0); } catch { break; } }
  holdLock(root, deadPid);
  assert.equal(runnerVerdict(root).out.state, 'stale');
  assert.equal(runnerVerdict(root).status, 0);
  // held by THIS process, which is the runner's parent here (same relationship as wrapper -> runner)
  holdLock(root, process.pid, 'semiconductor-suppliers');
  const parent = runnerVerdict(root);
  assert.equal(parent.out.state, 'held-by-parent');
  assert.equal(parent.status, 0);
  const other = liveOtherPid();
  try {
    holdLock(root, other.pid, 'semiconductor');
    const held = runnerVerdict(root);
    assert.equal(held.out.state, 'held-by-other');
    assert.equal(held.status, 2);
  } finally { other.kill(); }
  assert.equal(existsSync(join(root, 'data', 'semiconductor-suppliers-cohort-results.json')), false, 'nothing was scanned or written');
});

// ── static mapping: wrappers <-> runners <-> cohort files, no cross-reference ─

test('wrapper mapping: each wrapper drives only its own runner; both share ONE lock file; the supplier wrapper reads the lock verdict safely', filesOpts, () => {
  const sup = readFileSync(WRAPPER, 'utf8');
  const eq = readFileSync(join(SCHED, 'scan-semiconductor.ps1'), 'utf8');
  assert.match(sup, /run-semiconductor-suppliers-cohort\.mjs/);
  assert.doesNotMatch(sup.replace(/#.*$/gm, ''), /run-semiconductor-cohort\.mjs|semiconductor-15-companies/, 'supplier wrapper never references the equipment runner/cohort');
  assert.match(eq, /run-semiconductor-cohort\.mjs/);
  assert.doesNotMatch(eq, /suppliers/i, 'equipment wrapper never references the supplier cohort');
  const lockLiteral = /'data\\\.discovery-scheduler\.lock'/;
  assert.match(sup, lockLiteral);
  assert.match(eq, lockLiteral, 'same shared lock file as the equipment wrapper');
  assert.match(sup, /\. \(Join-Path \$PSScriptRoot 'lib-lock\.ps1'\)/);
  assert.match(sup, /Acquire-DiscoveryLock/);
  assert.match(sup, /Release-DiscoveryLock/);
  assert.match(sup, /\$acq\[\$acq\.Count - 1\]/, 'verdict is the LAST element of Acquire-DiscoveryLock output (it also emits status text)');
  assert.match(sup, /\$TimeoutSeconds = 600/, 'watchdog default 600 s (acceptance baseline 123.6 s)');
});

// ── Windows Task Scheduler mapping (machine-local; skipped where the tasks do not exist) ──

function taskInfo(name) {
  const script = `$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if (-not $t) { '' } else { ($t | ForEach-Object { [pscustomobject]@{ enabled = $_.Settings.Enabled; state = [string]$_.State; days = [int]$_.Triggers[0].DaysOfWeek; start = $_.Triggers[0].StartBoundary; exe = $_.Actions[0].Execute; args = $_.Actions[0].Arguments } } | ConvertTo-Json -Compress) }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 });
  return r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null;
}
const EQ_TASK = 'career-ops-semiconductor-tue-fri';
const SUP_TASK = 'career-ops-semiconductor-suppliers-tue-fri';
const tasksPresent = win && Boolean(taskInfo(EQ_TASK)) && Boolean(taskInfo(SUP_TASK));
const taskOpts = { skip: tasksPresent ? false : 'scheduled tasks not registered on this machine' };

test('scheduler: equipment task stays Tue/Fri 21:30 -> scan-semiconductor.ps1; supplier task is Tue/Fri 21:45 -> scan-semiconductor-suppliers.ps1; both enabled', taskOpts, () => {
  const eq = taskInfo(EQ_TASK); const sup = taskInfo(SUP_TASK);
  for (const t of [eq, sup]) { assert.equal(t.enabled, true); assert.equal(t.days, 36, 'Tuesday(4)+Friday(32)'); }
  assert.match(eq.start, /T21:30:00/);
  assert.match(sup.start, /T21:45:00/);
  assert.match(eq.args, /scheduler\\scan-semiconductor\.ps1"?$/);
  assert.doesNotMatch(eq.args, /suppliers/);
  assert.match(sup.args, /scheduler\\scan-semiconductor-suppliers\.ps1"?$/);
  assert.doesNotMatch(sup.args, /scan-semiconductor\.ps1/);
  assert.equal(eq.exe, 'powershell.exe');
  assert.equal(sup.exe, 'powershell.exe');
});
