/**
 * P7-T4 — Shelf UI: TreeView `geet.shelf` (SCM container, the spec's
 * "Shelf tab"). Entry rows (name · relative time · N files · origin branch)
 * expand to file children whose click opens a before/after diff: left =
 * `geet-rev:<baseSha>` content, right = the file's hunks applied to that
 * base IN MEMORY and served through the `geet-shelf:` content provider —
 * previewing a shelf never touches the worktree or index.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { applyHunks, splitPatchFiles } from '../core/patch/patchParser';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import type { ShelfFileMeta, ShelfMeta, ShelfStore } from './shelfStore';

export const SHELF_SCHEME = 'geet-shelf';

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
  return vscode.workspace.getConfiguration('geet.shelf').get<boolean>('showUnshelved', false);
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
    // geet-rev serves empty content for paths absent at the ref (added).
    left: makeRevUri(node.repo.root, node.file.relPath, node.meta.baseSha),
    right: makeShelfUri(node.repo.root, node.meta.id, node.file.relPath),
    title: vscode.l10n.t('{0} (Shelved: {1})', base, node.meta.name),
  };
}


// P14-T2: ShelfViewProvider is gone with the `geet.shelf` tree view. The
// commit window's Shelf tab (P11-T6) renders the same stores via ShelfBridge;
// the ShelfNode shape survives because shelfDiffSides still takes it.
