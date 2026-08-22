/**
 * Shelf tab bridge (P11-T6): serves the commit window's `Shelf` tab and routes
 * its actions through the SAME `gittree.shelf.*` commands the tree view uses —
 * one implementation, two surfaces, so they cannot produce different
 * `shelfStore` states. The bridge is attached by the phase-07 register layer
 * (the stores are built there, after phase 03); until it is attached, the
 * commit window answers with an empty shelf.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { Emitter, type Event } from '../../core/util/events';
import type { ShelfStore } from '../../shelf/shelfStore';
import { isShowUnshelvedEnabled } from '../../shelf/shelfView';
import type {
  CommitShelfActionParamsDto,
  CommitShelfEntryDto,
  CommitShelfStateDto,
} from '../../shared/protocol';

export interface ShelfBridgeDeps {
  core: Core;
  storeFor(repoRoot: string): ShelfStore | undefined;
}

export class ShelfBridge implements vscode.Disposable {
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this._onDidChange.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly deps: ShelfBridgeDeps) {
    const watch = (repo: RepoHandle): void => {
      const store = deps.storeFor(repo.root);
      if (store) repo.disposables.add(store.onDidChange(() => this._onDidChange.fire()));
    };
    for (const repo of deps.core.repos) watch(repo);
    const addSub = deps.core.onDidAddRepo((repo) => {
      watch(repo);
      this._onDidChange.fire();
    });
    this.subs.push(
      new vscode.Disposable(() => addSub.dispose()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gittree.shelf.showUnshelved')) this._onDidChange.fire();
      }),
    );
  }

  buildState(): CommitShelfStateDto {
    const showUnshelved = isShowUnshelvedEnabled();
    const repos = this.deps.core.repos.map((repo) => {
      const store = this.deps.storeFor(repo.root);
      const entries: CommitShelfEntryDto[] = (store?.list() ?? [])
        .filter((meta) => showUnshelved || meta.unshelvedAt === undefined)
        .map((meta) => ({
          id: meta.id,
          name: meta.name,
          comment: meta.comment,
          createdAt: meta.createdAt,
          branch: meta.branch,
          baseShort: meta.baseSha.slice(0, 8),
          files: meta.files.map((f) => ({
            relPath: f.relPath,
            status: f.status,
            isBinary: f.isBinary,
          })),
          // Integrity is checked per push, so a tampered patch shows up on the
          // next refresh without anyone having to try an unshelve first.
          valid: store?.verify(meta.id) ?? false,
          unshelved: meta.unshelvedAt !== undefined,
        }));
      return { root: repo.root, label: repo.root.split(/[\\/]/).pop() ?? repo.root, entries };
    });
    return { repos, showUnshelved };
  }

  /**
   * Every action goes through the registered command, with the same
   * `{repoRoot, shelfId}` argument shape the webview's native context menu
   * passes — the tab and the tree run literally the same code.
   */
  async dispatch(params: CommitShelfActionParamsDto): Promise<void> {
    const arg =
      params.repoRoot !== undefined && params.id !== undefined
        ? {
            repoRoot: params.repoRoot,
            shelfId: params.id,
            ...(params.relPath !== undefined ? { relPath: params.relPath } : {}),
          }
        : undefined;
    switch (params.action) {
      case 'unshelve':
        await vscode.commands.executeCommand('gittree.shelf.unshelve', arg);
        return;
      case 'unshelveSilently':
        await vscode.commands.executeCommand('gittree.shelf.unshelveSilently', arg);
        return;
      case 'unshelveFiles':
        await vscode.commands.executeCommand('gittree.shelf.unshelvePartial', arg);
        return;
      case 'compareWithLocal':
        await vscode.commands.executeCommand('gittree.shelf.compareWithLocal', arg);
        return;
      case 'openDiff':
        await vscode.commands.executeCommand('gittree.shelf.openShelvedDiff', arg);
        return;
      case 'showPatch':
        await vscode.commands.executeCommand('gittree.shelf.showPatch', arg);
        return;
      case 'export':
        await vscode.commands.executeCommand('gittree.shelf.export', arg);
        return;
      case 'rename':
        await vscode.commands.executeCommand('gittree.shelf.rename', arg);
        return;
      case 'delete':
        await vscode.commands.executeCommand('gittree.shelf.delete', arg);
        return;
      case 'import':
        await vscode.commands.executeCommand('gittree.shelf.import');
        return;
      case 'toggleShowUnshelved':
        await vscode.commands.executeCommand('gittree.shelf.showUnshelved');
        return;
    }
  }

  /** Test seam mirroring the repo lookup the commands use. */
  repoFor(repoRoot: string): RepoHandle | undefined {
    return this.deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this._onDidChange.dispose();
  }
}
