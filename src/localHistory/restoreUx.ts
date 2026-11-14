/**
 * Browse & restore UX (P9-T3): the Local History view — manifests grouped by
 * day, per-file rows, Compare with Current (multi-diff), selective restore as
 * one undoable WorkspaceEdit behind a paranoia snapshot, purge controls, and
 * the native-Timeline bridge for per-save granularity.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { makeSnapUri } from '../core/vdocs/snapFs';
import { confirmModal } from '../ui/confirm';
import { rowUri } from '../ui/rowDecorations';
import { groupByDay } from './grouping';
import type { SnapshotManifest, SnapshotStore } from './snapshotStore';

export type HistoryNode =
  | { kind: 'usage'; repo: RepoHandle }
  | { kind: 'timeline-bridge' }
  | { kind: 'repo'; repo: RepoHandle }
  | { kind: 'day'; repo: RepoHandle; label: string; manifests: SnapshotManifest[] }
  | { kind: 'snapshot'; repo: RepoHandle; manifest: SnapshotManifest }
  | { kind: 'file'; repo: RepoHandle; manifest: SnapshotManifest; relPath: string };

export class LocalHistoryViewProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** Optional repo-relative path filter (file/folder scoped invocations). */
  private pathFilter: { repoRoot: string; prefix: string } | undefined;

  constructor(
    private readonly core: Core,
    private readonly storeFor: (repo: RepoHandle) => SnapshotStore | undefined,
  ) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  setPathFilter(filter: { repoRoot: string; prefix: string } | undefined): void {
    this.pathFilter = filter;
    this.refresh();
  }

  get currentFilter(): { repoRoot: string; prefix: string } | undefined {
    return this.pathFilter;
  }

  private manifestsFor(repo: RepoHandle): SnapshotManifest[] {
    const store = this.storeFor(repo);
    if (!store) return [];
    const filter =
      this.pathFilter && canonicalKey(this.pathFilter.repoRoot) === canonicalKey(repo.root)
        ? { pathPrefix: this.pathFilter.prefix }
        : undefined;
    return store.list(filter);
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (!node) {
      const repos = this.core.repos;
      const roots: HistoryNode[] =
        repos.length === 1
          ? this.repoChildren(repos[0] as RepoHandle)
          : repos.map((repo) => ({ kind: 'repo' as const, repo }));
      return [...roots, { kind: 'timeline-bridge' }];
    }
    switch (node.kind) {
      case 'repo':
        return this.repoChildren(node.repo);
      case 'day':
        return node.manifests.map((manifest) => ({ kind: 'snapshot' as const, repo: node.repo, manifest }));
      case 'snapshot':
        return node.manifest.files.map((f) => ({
          kind: 'file' as const,
          repo: node.repo,
          manifest: node.manifest,
          relPath: f.relPath,
        }));
      case 'file':
      case 'usage':
      case 'timeline-bridge':
        return [];
    }
  }

  private repoChildren(repo: RepoHandle): HistoryNode[] {
    const manifests = this.manifestsFor(repo);
    const nodes: HistoryNode[] = [{ kind: 'usage', repo }];
    for (const group of groupByDay(manifests)) {
      nodes.push({ kind: 'day', repo, label: group.label, manifests: group.manifests });
    }
    return nodes;
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'usage': {
        const store = this.storeFor(node.repo);
        const mb = store ? (store.storageBytes() / (1024 * 1024)).toFixed(1) : '0';
        const filterSuffix =
          this.pathFilter && canonicalKey(this.pathFilter.repoRoot) === canonicalKey(node.repo.root)
            ? vscode.l10n.t(' · filtered: {0}', this.pathFilter.prefix)
            : '';
        const item = new vscode.TreeItem(
          vscode.l10n.t('Storage: {0} MB{1}', mb, filterSuffix),
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'lh:usage';
        return item;
      }
      case 'timeline-bridge': {
        const item = new vscode.TreeItem(
          vscode.l10n.t('Per-save versions: open native Timeline'),
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('timeline-view-icon');
        item.command = {
          // `<viewId>.focus` is the stable auto-generated focus command; the
          // native Timeline view id is `timeline`.
          command: 'timeline.focus',
          title: vscode.l10n.t('Open Timeline'),
        };
        item.tooltip = vscode.l10n.t(
          "VS Code's built-in Timeline records every save per file. GitTree records repo-wide snapshots around git operations.",
        );
        item.contextValue = 'lh:bridge';
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(
          node.repo.root.split(/[\\/]/).pop() ?? node.repo.root,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'lh:repo';
        return item;
      }
      case 'day': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('calendar');
        item.description = vscode.l10n.t('{0} snapshots', node.manifests.length);
        item.contextValue = 'lh:day';
        return item;
      }
      case 'snapshot': {
        const m = node.manifest;
        const time = new Date(m.ts).toLocaleTimeString();
        const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = vscode.l10n.t('{0} · {1} files', time, m.files.length);
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'lh:snapshot';
        item.command = {
          command: 'gittree.history.compareSnapshot',
          title: vscode.l10n.t('Compare with Current'),
          arguments: [node],
        };
        return item;
      }
      case 'file': {
        const name = path.posix.basename(node.relPath);
        const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
        const dir = path.posix.dirname(node.relPath);
        const deleted = node.manifest.files.some((f) => f.relPath === node.relPath && f.deleted === true);
        // A file at the root has no folder to name: "." said nothing.
        const description = deleted
          ? dir === '.'
            ? vscode.l10n.t('deleted')
            : vscode.l10n.t('{0} · deleted', dir)
          : dir === '.'
            ? ''
            : dir;
        item.description = description;
        // POST-P14cd: GitTree's own address, unmarked: a snapshot's file is not
        // the file now, whose status VS Code's Git marked a `file:` row with.
        // It keeps the file's name, which the icon theme reads (`ThemeIcon.File`).
        const fullPath = path.join(node.repo.root, node.relPath);
        item.resourceUri = rowUri('history', fullPath);
        // The hover the `file:` address gave; VS Code would read this text out as
        // the row's name, so that is set as it was: the label and description.
        item.tooltip = fullPath;
        item.accessibilityInformation = { label: description.length > 0 ? `${name} ${description}` : name };
        item.iconPath = new vscode.ThemeIcon('file');
        item.contextValue = 'lh:file';
        item.command = {
          command: 'gittree.history.diffFile',
          title: vscode.l10n.t('Diff with Current'),
          arguments: [node],
        };
        return item;
      }
    }
  }
}

export class RestoreUx {
  constructor(
    private readonly core: Core,
    private readonly storeFor: (repo: RepoHandle) => SnapshotStore | undefined,
    readonly provider: LocalHistoryViewProvider,
  ) {}

  /** Compare a snapshot with the current worktree (multi-diff). */
  async compareSnapshot(node: HistoryNode): Promise<void> {
    if (node.kind !== 'snapshot') return;
    const { repo, manifest } = node;
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
    for (const f of manifest.files) {
      if (f.blobSha.length === 0 && f.deleted !== true) continue; // an oversized stub
      const current = vscode.Uri.file(path.join(repo.root, f.relPath));
      const exists = fs.existsSync(current.fsPath);
      // Deleted then: added since, if it is back; nothing to compare if not.
      if (f.deleted === true) {
        if (exists) changes.push([current, undefined, current]);
        continue;
      }
      changes.push([current, makeSnapUri(repo.root, manifest.id, f.relPath), exists ? current : undefined]);
    }
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('Local History: {0}', manifest.label),
      changes,
    );
  }

  async diffFile(node: HistoryNode): Promise<void> {
    if (node.kind !== 'file') return;
    const snap = makeSnapUri(node.repo.root, node.manifest.id, node.relPath);
    const current = vscode.Uri.file(path.join(node.repo.root, node.relPath));
    await vscode.commands.executeCommand(
      'vscode.diff',
      snap,
      current,
      vscode.l10n.t('{0} (snapshot ⟷ current)', path.posix.basename(node.relPath)),
    );
  }

  /**
   * Restore a whole snapshot or a subset (QuickPick multi). One undoable
   * WorkspaceEdit; a paranoia snapshot is taken first; toast offers Undo.
   */
  async restore(node: HistoryNode, subset: boolean): Promise<void> {
    if (node.kind !== 'snapshot') return;
    const { repo, manifest } = node;
    const store = this.storeFor(repo);
    if (!store) return;

    // A deletion is restored by deleting; an oversized stub has nothing to restore.
    let targets = manifest.files.filter((f) => f.blobSha.length > 0 || f.deleted === true);
    if (subset) {
      const testPaths = process.env['GITTREE_TEST_RESTORE_PATHS'];
      if (testPaths !== undefined) {
        const wanted = new Set(testPaths.split(';'));
        targets = targets.filter((f) => wanted.has(f.relPath));
      } else {
        const picked = await vscode.window.showQuickPick(
          targets.map((f) => ({
            label: f.relPath,
            ...(f.deleted === true ? { description: vscode.l10n.t('deleted') } : {}),
            picked: true,
            entry: f,
          })),
          { canPickMany: true, placeHolder: vscode.l10n.t('Files to restore from "{0}"', manifest.label) },
        );
        if (!picked || picked.length === 0) return;
        targets = picked.map((p) => p.entry);
      }
    }
    if (targets.length === 0) return;

    const deletions = targets.filter((f) => f.deleted === true).length;
    const ok = await confirmModal(
      vscode.l10n.t('Restore {0} from "{1}"?', filesCount(targets.length), manifest.label),
      [
        ...(deletions > 0
          ? [vscode.l10n.t('{0} of them did not exist then and will be deleted.', deletions)]
          : []),
        vscode.l10n.t('Current contents are snapshotted first, and the restore is undoable.'),
      ].join(' '),
      vscode.l10n.t('Restore'),
    );
    if (!ok) return;

    // Paranoia snapshot of the files about to be overwritten — a file the
    // restore creates is recorded as missing, so Undo deletes it again.
    const absPaths = targets.map((f) => path.join(repo.root, f.relPath));
    const paranoiaId = await store.snapshot(
      vscode.l10n.t('Before restore of "{0}"', manifest.label),
      'manual',
      absPaths,
      { recordMissing: true },
    );

    const edit = new vscode.WorkspaceEdit();
    for (const f of targets) {
      const uri = vscode.Uri.file(path.join(repo.root, f.relPath));
      if (f.deleted === true) {
        edit.deleteFile(uri, { ignoreIfNotExists: true });
        continue;
      }
      const bytes = store.read(manifest.id, f.relPath);
      if (!bytes) continue;
      edit.createFile(uri, { overwrite: true, contents: bytes });
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Restore could not be applied.'));
      return;
    }
    await repo.refresher.refreshNow();
    this.provider.refresh();

    const undo = vscode.l10n.t('Undo restore');
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t('Restored {0} from "{1}".', filesCount(targets.length), manifest.label),
        undo,
      )
      .then(async (choice) => {
        if (choice === undo && paranoiaId !== undefined) {
          const paranoia = store.get(paranoiaId);
          if (paranoia) {
            await this.restore({ kind: 'snapshot', repo, manifest: paranoia }, false);
          }
        }
      });
  }

  async deleteSnapshot(node: HistoryNode): Promise<void> {
    if (node.kind !== 'snapshot') return;
    const store = this.storeFor(node.repo);
    if (!store) return;
    const ok = await confirmModal(
      vscode.l10n.t('Delete snapshot "{0}"?', node.manifest.label),
      '',
      vscode.l10n.t('Delete'),
    );
    if (!ok) return;
    await store.delete(node.manifest.id);
    this.provider.refresh();
  }

  async clearAll(repo: RepoHandle | undefined): Promise<void> {
    const target = repo ?? this.core.repos[0];
    if (!target) return;
    const store = this.storeFor(target);
    if (!store) return;
    const typed =
      process.env['GITTREE_TEST_AUTOCONFIRM'] === '1'
        ? 'DELETE'
        : await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Type DELETE to clear ALL Local History for {0}', target.root),
            ignoreFocusOut: true,
          });
    if (typed !== 'DELETE') return;
    for (const m of store.list()) {
      await store.delete(m.id);
    }
    this.provider.refresh();
  }

  async gcNow(repo: RepoHandle | undefined): Promise<void> {
    const target = repo ?? this.core.repos[0];
    if (!target) return;
    const store = this.storeFor(target);
    if (!store) return;
    const result = await store.gc();
    void vscode.window.setStatusBarMessage(
      vscode.l10n.t('Local History GC: {0} manifests, {1} blobs removed', result.droppedManifests, result.sweptBlobs),
      5000,
    );
    this.provider.refresh();
  }
}
