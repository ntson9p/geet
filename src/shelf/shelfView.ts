/**
 * P7-T4 — Shelf UI: TreeView `gittree.shelf` (SCM container, the spec's
 * "Shelf tab"). Entry rows (name · relative time · N files · origin branch)
 * expand to file children whose click opens a before/after diff: left =
 * `gittree-rev:<baseSha>` content, right = the file's hunks applied to that
 * base IN MEMORY and served through the `gittree-shelf:` content provider —
 * previewing a shelf never touches the worktree or index.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { applyHunks, splitPatchFiles } from '../core/patch/patchParser';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import { relativeTime } from '../stash/stashView';
import type { ShelfFileMeta, ShelfMeta, ShelfStore } from './shelfStore';

export const SHELF_SCHEME = 'gittree-shelf';

interface ShelfQuery {
  repo: string;
  id: string;
  rel: string;
}

export function makeShelfUri(repoRoot: string, shelfId: string, relPath: string): vscode.Uri {
  const rel = relPath.replace(/\\/gu, '/');
  const query: ShelfQuery = { repo: repoRoot, id: shelfId, rel };
  return vscode.Uri.from({ scheme: SHELF_SCHEME, path: '/' + rel, query: JSON.stringify(query) });
}

export type ShelfNode =
  | { kind: 'entry'; repo: RepoHandle; store: ShelfStore; meta: ShelfMeta }
  | { kind: 'file'; repo: RepoHandle; store: ShelfStore; meta: ShelfMeta; file: ShelfFileMeta };

/** P11-T6 — the Show-already-unshelved toggle, shared by tree and tab. */
export function isShowUnshelvedEnabled(): boolean {
  return vscode.workspace.getConfiguration('gittree.shelf').get<boolean>('showUnshelved', false);
}

/** Serves the reconstructed post-shelve content of one file in one shelf. */
export class ShelfContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getStore: (repoRoot: string) => ShelfStore | undefined,
    private readonly getRepo: (repoRoot: string) => RepoHandle | undefined,
  ) {}

  fireChanged(uri: vscode.Uri): void {
    this._onDidChange.fire(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: ShelfQuery;
    try {
      q = JSON.parse(uri.query) as ShelfQuery;
    } catch {
      return '';
    }
    const store = this.getStore(q.repo);
    const repo = this.getRepo(q.repo);
    if (!store || !repo) return '';
    const meta = store.get(q.id);
    if (!meta) return '';
    const patch = store.readPatch(q.id).toString('utf8'); // integrity-checked
    const section = splitPatchFiles(patch).find((s) => s.relPath === q.rel);
    if (!section) return '';
    if (section.isBinary) return vscode.l10n.t('(binary file — preview unavailable)');
    if (section.status === 'added') return applyHunks('', section.hunks);
    const base = await repo.queue.enqueue({
      label: 'shelf base read',
      kind: 'read',
      run: (git, token) =>
        git.exec(q.repo, ['show', `${meta.baseSha}:${q.rel}`], {
          allowNonZeroExit: true,
          noOptionalLocks: true,
          token,
        }),
    });
    // Missing at base (e.g. imported patch with a foreign base): empty base.
    return applyHunks(base.exitCode === 0 ? base.stdout : '', section.hunks);
  }
}

/** The diff pair a shelf file row opens. */
export function shelfDiffSides(
  node: Extract<ShelfNode, { kind: 'file' }>,
): { left: vscode.Uri; right: vscode.Uri; title: string } {
  const base = node.file.relPath.split('/').pop() ?? node.file.relPath;
  return {
    // gittree-rev serves empty content for paths absent at the ref (added).
    left: makeRevUri(node.repo.root, node.file.relPath, node.meta.baseSha),
    right: makeShelfUri(node.repo.root, node.meta.id, node.file.relPath),
    title: vscode.l10n.t('{0} (Shelved: {1})', base, node.meta.name),
  };
}

export class ShelfViewProvider implements vscode.TreeDataProvider<ShelfNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private repos: Array<{ repo: RepoHandle; store: ShelfStore }> = [];

  setRepos(repos: Array<{ repo: RepoHandle; store: ShelfStore }>): void {
    this.repos = repos;
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getChildren(node?: ShelfNode): ShelfNode[] {
    if (!node) {
      const showUnshelved = isShowUnshelvedEnabled();
      const rows: ShelfNode[] = [];
      for (const { repo, store } of this.repos) {
        for (const meta of store.list()) {
          // Applied-but-kept entries hide behind the toggle (IntelliJ).
          if (!showUnshelved && meta.unshelvedAt !== undefined) continue;
          rows.push({ kind: 'entry', repo, store, meta });
        }
      }
      return rows;
    }
    if (node.kind === 'entry') {
      return node.meta.files.map((file) => ({
        kind: 'file',
        repo: node.repo,
        store: node.store,
        meta: node.meta,
        file,
      }));
    }
    return [];
  }

  getTreeItem(node: ShelfNode): vscode.TreeItem {
    if (node.kind === 'entry') {
      const item = new vscode.TreeItem(node.meta.name, vscode.TreeItemCollapsibleState.Collapsed);
      const unshelved = node.meta.unshelvedAt !== undefined;
      const damaged = !node.store.verify(node.meta.id);
      item.description =
        vscode.l10n.t(
          '{0} · {1} file(s) · from {2}',
          relativeTime(Math.floor(node.meta.createdAt / 1000)),
          node.meta.files.length,
          node.meta.branch,
        ) +
        (unshelved ? ` · ${vscode.l10n.t('already unshelved')}` : '') +
        (damaged ? ` · ${vscode.l10n.t('damaged')}` : '');
      const comment = node.meta.comment.length > 0 ? `\n${node.meta.comment}` : '';
      item.tooltip = `${node.meta.name}${comment}\n${vscode.l10n.t('base {0}', node.meta.baseSha.slice(0, 12))}`;
      // Integrity failures surface inline on the row, never as a modal.
      item.iconPath = damaged
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'))
        : new vscode.ThemeIcon(unshelved ? 'check' : 'package');
      item.contextValue = 'shelf:entry';
      item.id = `${node.repo.root}#shelf#${node.meta.id}`;
      return item;
    }
    const rel = node.file.relPath;
    const base = rel.split('/').pop() ?? rel;
    const item = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.None);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const binary = node.file.isBinary ? ` · ${vscode.l10n.t('binary')}` : '';
    item.description = `${dir.length > 0 ? `${dir} · ` : ''}${node.file.status}${binary}`;
    item.resourceUri = vscode.Uri.file(`${node.repo.root}/${rel}`);
    item.iconPath = new vscode.ThemeIcon(
      node.file.status === 'deleted'
        ? 'diff-removed'
        : node.file.status === 'modified'
          ? 'diff-modified'
          : 'diff-added',
    );
    item.contextValue = node.file.isBinary ? 'shelf:file:binary' : 'shelf:file';
    if (!node.file.isBinary) {
      const sides = shelfDiffSides(node);
      item.command = {
        command: 'vscode.diff',
        title: vscode.l10n.t('Show Shelved Change'),
        arguments: [sides.left, sides.right, sides.title],
      };
    }
    return item;
  }
}
