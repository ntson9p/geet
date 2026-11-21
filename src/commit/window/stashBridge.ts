/**
 * Stash tab bridge (POST-P14l): serves the commit window's `Stash` tab and
 * routes its actions through the SAME `geet.stash.*` commands the tree view
 * uses — one implementation, two surfaces, exactly as `shelfBridge.ts` does for
 * the shelf.
 *
 * JetBrains puts stashes in a `Stash` tab of the Commit tool window beside
 * `Shelf`, with *Combine stashes and shelves in one tab* (Settings | Version
 * Control | Git | Stash) merging the two. That setting is off by default there
 * and here, so the default shape is three tabs: `Commit | Shelf | Stash`.
 *
 * Attached by the phase-07 register layer, which owns the services; until it is
 * attached the commit window answers with an empty stash list.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import type { StashInfo } from '../../core/git/parsers/stashList';
import { canonicalKey } from '../../core/repoDiscovery';
import { Emitter, type Event } from '../../core/util/events';
import type { StashFile, StashService } from '../../stash/stashService';
import { stashDiffSides } from '../../stash/stashView';
import type {
  CommitStashActionParamsDto,
  CommitStashFileDto,
  CommitStashStateDto,
} from '../../shared/protocol';

export interface StashBridgeDeps {
  core: Core;
  serviceFor(repoRoot: string): StashService | undefined;
}

/** IntelliJ's *Combine stashes and shelves in one tab*, off by default. */
export function isCombineStashesEnabled(): boolean {
  return vscode.workspace.getConfiguration('geet.stash').get<boolean>('combineWithShelf', false);
}

export class StashBridge implements vscode.Disposable {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: StashBridgeDeps) {
    const watch = (repo: RepoHandle): void => {
      const service = deps.serviceFor(repo.root);
      if (service) repo.disposables.add(service.onDidChange(() => this._onDidChange.fire()));
    };
    for (const repo of deps.core.repos) watch(repo);
    const addSub = deps.core.onDidAddRepo((repo) => {
      watch(repo);
      this._onDidChange.fire();
    });
    this.subs.push(
      new vscode.Disposable(() => addSub.dispose()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('geet.stash.combineWithShelf')) this._onDidChange.fire();
      }),
    );
  }

  buildState(): CommitStashStateDto {
    const repos = this.deps.core.repos.map((repo) => ({
      root: repo.root,
      label: repo.root.split(/[\\/]/).pop() ?? repo.root,
      entries: (this.deps.serviceFor(repo.root)?.list() ?? []).map((info) => ({
        sha: info.sha,
        index: info.index,
        selector: info.selector,
        message: info.message,
        ...(info.branch !== undefined ? { branch: info.branch } : {}),
        // git reports unix seconds; the DTO is epoch ms like the shelf’s.
        createdAt: info.time * 1000,
      })),
    }));
    return { repos, combined: isCombineStashesEnabled() };
  }

  /** A stash's files, read on expand — `git stash show` runs per stash. */
  async filesFor(repoRoot: string, sha: string): Promise<CommitStashFileDto[]> {
    const found = this.resolve(repoRoot, sha);
    if (!found) return [];
    const files = await found.service.getStashFiles(found.info.index);
    return files.map((f) => ({ relPath: f.path, status: f.status }));
  }

  /**
   * Every action goes through the registered command with the tree view's own
   * node shape, so the confirmations and the conflict handling stay one code
   * path. The webview names a stash by **sha**, which is re-resolved here: a
   * row acted on after the list moved would otherwise hit whichever stash
   * inherited its `stash@{N}`.
   */
  async dispatch(params: CommitStashActionParamsDto): Promise<void> {
    if (params.action === 'push') {
      await vscode.commands.executeCommand('geet.stash.push');
      return;
    }
    if (params.action === 'clear') {
      await vscode.commands.executeCommand('geet.stash.clear');
      return;
    }
    if (params.repoRoot === undefined || params.sha === undefined) return;
    const found = this.resolve(params.repoRoot, params.sha);
    if (!found) return;
    if (params.action === 'openFileDiff') {
      if (params.relPath === undefined) return;
      const file = (await found.service.getStashFiles(found.info.index)).find(
        (f) => f.path === params.relPath,
      );
      if (!file) return;
      await this.openDiff(found.repo, file);
      return;
    }
    const node = { kind: 'stash', repo: found.repo, service: found.service, info: found.info };
    const command = {
      apply: 'geet.stash.apply',
      pop: 'geet.stash.pop',
      drop: 'geet.stash.drop',
      branch: 'geet.stash.branch',
      copyMessage: 'geet.stash.copyMessage',
      diffAll: 'geet.stash.diffAll',
    }[params.action];
    await vscode.commands.executeCommand(command, node);
  }

  private async openDiff(repo: RepoHandle, file: StashFile): Promise<void> {
    const sides = stashDiffSides(repo, file);
    await vscode.commands.executeCommand('vscode.diff', sides.left, sides.right, sides.title);
  }

  /** (repoRoot, sha) → the live repo/service/info triple, or nothing. */
  private resolve(
    repoRoot: string,
    sha: string,
  ): { repo: RepoHandle; service: StashService; info: StashInfo } | undefined {
    const key = canonicalKey(repoRoot);
    const repo = this.deps.core.repos.find((r) => canonicalKey(r.root) === key);
    if (!repo) return undefined;
    const service = this.deps.serviceFor(repo.root);
    if (!service) return undefined;
    const info = service.list().find((s) => s.sha === sha);
    return info ? { repo, service, info } : undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this._onDidChange.dispose();
  }
}
