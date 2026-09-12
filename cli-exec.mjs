#!/usr/bin/env node
/**
 * cli-exec.mjs — safe, argv-only invocation of a headless CLI, fixing a
 * confirmed Windows/npm-shim gap: npm's global-install shim is typically a
 * `.cmd` batch file, and Node's execFileSync cannot spawn one directly
 * without shell involvement — empirically reproduced on this machine as
 * ENOENT for the bare name (`claude`) and EINVAL for the `.cmd` file
 * itself (Node's own documented constraint: CreateProcess cannot launch a
 * batch file as a plain executable).
 *
 * shell:true is not an option: job titles/companies/JD text are untrusted
 * external content that end up in the prompt argument, and Node's own docs
 * warn shell:true is injectable with unsanitized input — it builds one
 * command STRING that a shell reparses. A `cmd.exe /c <target> <args...>`
 * workaround was tried during development and rejected: empirically,
 * cmd.exe's own reparsing of the prompt argument (quotes especially)
 * silently mangled it down to nothing rather than failing loudly — a wrong
 * answer is worse than a loud error.
 *
 * The actual fix: READ the .cmd shim (a few lines of trivial batch script)
 * and resolve what it ultimately launches. Two shapes seen in the wild:
 *   - `"%dp0%\...\foo.exe"   %*`      (wraps a compiled executable — this
 *     machine's claude.cmd wraps claude.exe exactly this way)
 *   - `node  "%dp0%\...\cli.js" %*`   (wraps a Node script — the more
 *     common shape for pure-JS CLIs)
 * Once resolved, the REAL target (a genuine .exe, or node + a real .js
 * path) is invoked directly via execFileSync with args as a plain array —
 * no shell, no batch-file reparsing, so every element of `args` (including
 * arbitrary prompt text) reaches the child process as its own distinct
 * argv slot, exactly as array-based execFileSync already guarantees for
 * any directly-spawnable executable.
 *
 * No new dependency: this is what packages like `cross-spawn` do
 * internally for the same problem, sized down to exactly the shape needed
 * here (a shim produced by `npm install -g`), not the full general case.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { delimiter, dirname, join } from 'path';

/**
 * @param {string} filename
 * @param {string} [pathEnv]
 * @returns {string|null} full path, or null if not found on PATH
 */
export function findOnPath(filename, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a Windows npm-shim .cmd file's content and resolve the real target
 * it launches. Returns null if the shape isn't recognized (caller falls
 * back to the original bin name, matching pre-fix behavior).
 *
 * @param {string} content - the .cmd file's text
 * @param {string} cmdDir - directory the .cmd file lives in, to resolve %dp0%
 * @returns {{file: string, prefixArgs: string[]} | null}
 */
export function resolveShimTarget(content, cmdDir) {
  const dp0 = cmdDir.endsWith('\\') || cmdDir.endsWith('/') ? cmdDir : `${cmdDir}\\`;
  const expand = (p) => p.replace(/%dp0%/gi, dp0).replace(/%~dp0%/gi, dp0);

  // Node-script shape checked FIRST: node(.exe), bare or quoted-by-path,
  // followed by a quoted script path, followed by %*. Order matters — a
  // shim that quotes node.exe BY PATH (a very common real shape) would
  // otherwise also satisfy the single-.exe pattern below, silently
  // matching just the interpreter and discarding the actual script
  // argument (caught by this module's own tests during development).
  const nodeScriptMatch = content.match(
    /(?:"([^"]*\bnode(?:\.exe)?)"|\bnode(?:\.exe)?\b)\s+"([^"]+\.(?:m?js|cjs))"\s*%\*/i,
  );
  if (nodeScriptMatch) {
    const nodeExe = nodeScriptMatch[1] ? expand(nodeScriptMatch[1]) : process.execPath;
    return { file: nodeExe, prefixArgs: [expand(nodeScriptMatch[2])] };
  }

  // Single wrapped executable (a compiled binary, not node): "<path>.exe"
  // directly followed by %* — this machine's actual claude.cmd shape.
  const exeMatch = content.match(/"([^"]+\.exe)"\s*%\*/i);
  if (exeMatch) return { file: expand(exeMatch[1]), prefixArgs: [] };

  return null;
}

/**
 * Resolve the safe {file, prefixArgs} to spawn for `bin`, without ever
 * invoking a shell. On non-Windows, or when no `.cmd` shim is found on
 * PATH (bin is already directly spawnable — a real executable), returns
 * {file: bin, prefixArgs: []} unchanged, so this is a pure no-op there.
 *
 * @param {string} bin
 * @returns {{file: string, prefixArgs: string[]}}
 */
export function resolveCliTarget(bin) {
  if (process.platform !== 'win32') return { file: bin, prefixArgs: [] };
  if (/\.(exe|cmd|bat)$/i.test(bin)) return { file: bin, prefixArgs: [] }; // caller already knows what it wants

  const cmdPath = findOnPath(`${bin}.cmd`);
  if (!cmdPath) return { file: bin, prefixArgs: [] };

  let content;
  try {
    content = readFileSync(cmdPath, 'utf-8');
  } catch {
    return { file: bin, prefixArgs: [] };
  }

  return resolveShimTarget(content, dirname(cmdPath)) ?? { file: bin, prefixArgs: [] };
}

/**
 * Safe, argv-only invocation. Resolves `bin` once per call and runs
 * execFileSync against the resolved real target — never a shell, never a
 * concatenated string.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {object} opts - execFileSync options (encoding, maxBuffer, timeout, ...)
 * @returns {string} child stdout (per opts.encoding)
 */
export function execCliSafely(bin, args, opts) {
  const { file, prefixArgs } = resolveCliTarget(bin);
  return execFileSync(file, [...prefixArgs, ...args], opts);
}
