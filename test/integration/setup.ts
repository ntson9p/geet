/**
 * Shared helpers for @vscode/test-electron suites (master P0-T10 step 3).
 * The runner (runTests.ts) opens a multi-root workspace of FixtureRepo repos
 * and sets GITTREE_TEST=1 so the extension exposes its getCore() hook.
 */
import * as assert from 'node:assert';
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

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
