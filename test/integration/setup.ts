/**
 * Shared helpers for @vscode/test-electron suites (master P0-T10 step 3).
 * The runner (runTests.ts) opens a multi-root workspace of FixtureRepo repos
 * and sets GEET_TEST=1 so the extension exposes its getCore() hook.
 */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { Core } from '../../src/core/core';
import type { GeetApi } from '../../src/extension';
import { EXTENSION_ID } from './extensionId';

let cached: Core | undefined;

/** Activates Geet and resolves the initialized Core (discovery complete). */
export async function activateGeet(): Promise<Core> {
  if (cached) return cached;
  const ext = vscode.extensions.getExtension<GeetApi>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} not found`);
  const api = await ext.activate();
  const corePromise = api.getCore();
  assert.ok(corePromise, 'getCore() hook unavailable — GEET_TEST not set?');
  const core = await corePromise;
  assert.ok(core, 'core failed to initialize (git missing?)');
  cached = core;
  return core;
}

/** Workspace fixture repo paths exported by the runner. */
export function workspaceRepoA(): string {
  const p = process.env['GEET_TEST_REPO_A'];
  assert.ok(p, 'GEET_TEST_REPO_A missing');
  return p;
}

export function workspaceRepoB(): string {
  const p = process.env['GEET_TEST_REPO_B'];
  assert.ok(p, 'GEET_TEST_REPO_B missing');
  return p;
}

export function workspaceRepoC(): string {
  const p = process.env['GEET_TEST_REPO_C'];
  assert.ok(p, 'GEET_TEST_REPO_C missing');
  return p;
}

/** repoD/repoE belong to the multi-root commit suite — see runTests.ts. */
export function workspaceRepoD(): string {
  const p = process.env['GEET_TEST_REPO_D'];
  assert.ok(p, 'GEET_TEST_REPO_D missing');
  return p;
}

export function workspaceRepoE(): string {
  const p = process.env['GEET_TEST_REPO_E'];
  assert.ok(p, 'GEET_TEST_REPO_E missing');
  return p;
}

/**
 * Runs `fn` with GEET_TEST_AUTOCONFIRM pinned, then restores whatever the
 * harness had. `delete`-ing it instead — as several suites used to — silently
 * disarms auto-confirm for every suite that runs afterwards, because the runner
 * sets it once for the whole process (runTests.ts `extensionTestsEnv`).
 */
export async function withAutoConfirm<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const saved = process.env['GEET_TEST_AUTOCONFIRM'];
  process.env['GEET_TEST_AUTOCONFIRM'] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env['GEET_TEST_AUTOCONFIRM'];
    else process.env['GEET_TEST_AUTOCONFIRM'] = saved;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * CLI git with retry against Windows file-lock contention (AV/indexer/HEAD
 * readers): `.git/config` and ref writes intermittently fail with EPERM under
 * suite load. Synchronous on purpose — callers use it in test scaffolding.
 */
export function gitWithRetry(cwd: string, args: readonly string[]): string {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
    } catch (err) {
      lastErr = err;
      const text = String(err);
      if (!/Permission denied|Another git process|unable to write|could not write/i.test(text)) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
    }
  }
  // Still locked after 20 s (Windows with git 2.36 on CI): say which git
  // processes were running then, since one of them is likely holding the file.
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${message}\ngit processes still running:\n${runningGitProcesses()}`);
}

/** The git processes running now, with their command lines, for a failure message. */
function runningGitProcesses(): string {
  try {
    return process.platform === 'win32'
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name = 'git.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CreationDate) $($_.CommandLine)\" }",
          ],
          { encoding: 'utf8', timeout: 15_000 },
        )
      : execFileSync('ps', ['-eo', 'pid,etime,args'], { encoding: 'utf8', timeout: 15_000 })
          .split('\n')
          .filter((line) => /\bgit\b/u.test(line))
          .join('\n');
  } catch (err) {
    return `(could not list them: ${err instanceof Error ? err.message : String(err)})`;
  }
}
