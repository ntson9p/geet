/**
 * Phase 7 registration (T1 slice — StashService per repo; T2 adds the
 * stashes view + commands, T3..T5 the shelf engine, view and unshelve).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import type { ConflictSource } from '../merge/conflictSession';
import { StashService } from './stashService';

interface Phase06LifecycleShape {
  lifecycle: { expectConflict(repoRoot: string, source: ConflictSource): void };
}

export function registerPhase07StashShelve(context: vscode.ExtensionContext, core: Core): void {
  const services = new Map<string, StashService>();
  const expectConflict = (repoRoot: string, source: ConflictSource): void => {
    const p6 = core.debugRegistry.get('phase06') as Phase06LifecycleShape | undefined;
    p6?.lifecycle.expectConflict(repoRoot, source);
  };

  const attach = (repo: RepoHandle): void => {
    services.set(canonicalKey(repo.root), new StashService(repo, expectConflict));
  };
  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  core.debugRegistry.set('phase07', {
    getStashService: (repoRoot: string) => services.get(canonicalKey(repoRoot)),
  });
}
