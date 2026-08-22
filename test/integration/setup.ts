/**
 * Shared helpers for @vscode/test-electron suites (master P0-T10 step 3).
 * The runner (runTests.ts) opens a multi-root workspace of FixtureRepo repos
 * and sets GITTREE_TEST=1 so the extension exposes its getCore() hook.
 */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { Core } from '../../src/core/core';
import type { GitTreeApi } from '../../src/extension';

let cached: Core | undefined;

/** Activates GitTree and resolves the initialized Core (discovery complete). */
export async function activateGitTree(): Promise<Core> {
  if (cached) return cached;
  const ext = vscode.extensions.getExtension<GitTreeApi>('gittree.gittree');
  assert.ok(ext, 'extension gittree.gittree not found');
  const api = await ext.activate();
  const corePromise = api.getCore();
  assert.ok(corePromise, 'getCore() hook unavailable — GITTREE_TEST not set?');
  const core = await corePromise;
  assert.ok(core, 'core failed to initialize (git missing?)');
  cached = core;
  return core;
}

/** Workspace fixture repo paths exported by the runner. */
export function workspaceRepoA(): string {
  const p = process.env['GITTREE_TEST_REPO_A'];
  assert.ok(p, 'GITTREE_TEST_REPO_A missing');
  return p;
}

export function workspaceRepoB(): string {
  const p = process.env['GITTREE_TEST_REPO_B'];
  assert.ok(p, 'GITTREE_TEST_REPO_B missing');
  return p;
}

export function workspaceRepoC(): string {
  const p = process.env['GITTREE_TEST_REPO_C'];
  assert.ok(p, 'GITTREE_TEST_REPO_C missing');
  return p;
}

/**
 * Pins the commit surface for a suite (P11-T2). The shared window carries one
 * setting across every suite, so any suite that reads or writes a commit
 * message must say which surface it means:
 *   - `native`  — the P1/P3/P5 SCM input box (`sc.inputBox.value`);
 *   - `webview` — the commit tool window's own editor.
 * Both are supported product modes, so both stay covered.
 */
export async function useCommitWindow(mode: 'webview' | 'native'): Promise<void> {
  const config = vscode.workspace.getConfiguration('gittree');
  if (config.get<string>('commit.window') === mode) return;
  await config.update('commit.window', mode, vscode.ConfigurationTarget.Global);
  await waitFor(
    () => vscode.workspace.getConfiguration('gittree').get<string>('commit.window') === mode,
    10_000,
  );
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
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
