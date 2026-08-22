/**
 * `gittree-tree:` FileSystemProvider (P12-T7): a read-only browse of the
 * repository AS OF a revision — `Show Repository at Revision`. The existing
 * `gittree-rev:` provider is a TextDocumentContentProvider and can only serve
 * single text documents; a browsable tree needs stat/readDirectory/readFile,
 * hence a real (read-only) file system over `ls-tree` + blob reads.
 *
 * Byte safety: blobs are materialized with `git unpack-file` (plumbing that
 * writes the blob to a temp file itself) — executor stdout is utf8-decoded
 * and would corrupt binary content.
 *
 * Deviation D8: IntelliJ opens a whole project frame at the revision; VS Code
 * has no second frame, and mutating workspace folders to fake one is worse
 * than a scoped read-only tree view (docs/deviations.md).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core';
import { canonicalKey } from '../repoDiscovery';

export const REV_TREE_SCHEME = 'gittree-tree';

interface RevTreeQuery {
  repo: string;
  rev: string;
}

export function makeRevTreeUri(repoRoot: string, rev: string, relPath = ''): vscode.Uri {
  const query: RevTreeQuery = { repo: repoRoot, rev };
  return vscode.Uri.from({
    scheme: REV_TREE_SCHEME,
    path: '/' + relPath.replace(/\\/gu, '/'),
    query: JSON.stringify(query),
  });
}

function parseUri(uri: vscode.Uri): { repo: string; rev: string; rel: string } | undefined {
  try {
    const q = JSON.parse(uri.query) as RevTreeQuery;
    if (typeof q.repo !== 'string' || typeof q.rev !== 'string') return undefined;
    return { repo: q.repo, rev: q.rev, rel: uri.path.replace(/^\/+/u, '') };
  } catch {
    return undefined;
  }
}

interface LsTreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  size: number | undefined;
  name: string;
}

/** `ls-tree -z --long <rev> -- <path>` parser: `mode SP type SP oid SP size TAB name`. */
export function parseLsTreeLong(output: string): LsTreeEntry[] {
  const out: LsTreeEntry[] = [];
  for (const row of output.split('\0')) {
    if (row.length === 0) continue;
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const head = row.slice(0, tab).trim().split(/\s+/u);
    const name = row.slice(tab + 1);
    const [mode, type, oid, sizeRaw] = head;
    if (mode === undefined || type === undefined || oid === undefined) continue;
    out.push({
      mode,
      type: type === 'tree' ? 'tree' : type === 'commit' ? 'commit' : 'blob',
      oid,
      size: sizeRaw !== undefined && sizeRaw !== '-' ? Number.parseInt(sizeRaw, 10) : undefined,
      name: name.includes('/') ? (name.split('/').pop() ?? name) : name,
    });
  }
  return out;
}

export class RevTreeFs implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly core: Core) {}

  private repoFor(root: string): RepoHandle | undefined {
    return this.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
  }

  private async lsTree(repo: RepoHandle, rev: string, rel: string): Promise<LsTreeEntry[]> {
    const spec = rel.length === 0 ? [] : ['--', rel.endsWith('/') ? rel : `${rel}/`];
    const result = await repo.queue.enqueue({
      label: `ls-tree ${rev.slice(0, 7)}`,
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['ls-tree', '-z', '--long', rev, ...spec], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) throw vscode.FileSystemError.FileNotFound();
    return parseLsTreeLong(result.stdout);
  }

  watch(): vscode.Disposable {
    // History is immutable; there is nothing to watch.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const parsed = parseUri(uri);
    if (!parsed) throw vscode.FileSystemError.FileNotFound(uri);
    const repo = this.repoFor(parsed.repo);
    if (!repo) throw vscode.FileSystemError.FileNotFound(uri);
    if (parsed.rel.length === 0) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const result = await repo.queue.enqueue({
      label: `stat ${parsed.rev.slice(0, 7)}:${parsed.rel}`,
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['ls-tree', '-z', '--long', parsed.rev, '--', parsed.rel], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    const entry = parseLsTreeLong(result.stdout)[0];
    if (result.exitCode !== 0 || !entry) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: entry.type === 'tree' ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: entry.size ?? 0,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    const parsed = parseUri(uri);
    if (!parsed) throw vscode.FileSystemError.FileNotFound(uri);
    const repo = this.repoFor(parsed.repo);
    if (!repo) throw vscode.FileSystemError.FileNotFound(uri);
    const entries = await this.lsTree(repo, parsed.rev, parsed.rel);
    return entries.map((e) => [
      e.name,
      e.type === 'tree' ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const parsed = parseUri(uri);
    if (!parsed) throw vscode.FileSystemError.FileNotFound(uri);
    const repo = this.repoFor(parsed.repo);
    if (!repo) throw vscode.FileSystemError.FileNotFound(uri);
    return repo.queue.enqueue({
      label: `read ${parsed.rev.slice(0, 7)}:${parsed.rel}`,
      kind: 'read',
      run: async (git, token) => {
        const oid = await git.exec(
          repo.root,
          ['rev-parse', '--verify', `${parsed.rev}:${parsed.rel}`],
          { structured: true, noOptionalLocks: true, allowNonZeroExit: true, token },
        );
        if (oid.exitCode !== 0) throw vscode.FileSystemError.FileNotFound(uri);
        // unpack-file writes `.merge_file_*` in the repo root and prints its name.
        const named = await git.exec(repo.root, ['unpack-file', oid.stdout.trim()], {
          structured: true,
          token,
        });
        const tmp = path.join(repo.root, named.stdout.trim());
        try {
          return new Uint8Array(fs.readFileSync(tmp));
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      },
    });
  }

  // Read-only: every mutation is refused.
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('gittree-tree is read-only');
  }
  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('gittree-tree is read-only');
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions('gittree-tree is read-only');
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions('gittree-tree is read-only');
  }
}

// ---------------------------------------------------------------------------
// The dedicated tree view (`gittree.revTree`).
// ---------------------------------------------------------------------------

export interface RevTreeTarget {
  repo: RepoHandle;
  rev: string;
  label: string;
}

type RevTreeNode = { rel: string; name: string; isDir: boolean };

export class RevTreeViewProvider implements vscode.TreeDataProvider<RevTreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private target: RevTreeTarget | undefined;

  constructor(private readonly fsProvider: RevTreeFs) {}

  get currentTarget(): RevTreeTarget | undefined {
    return this.target;
  }

  async show(target: RevTreeTarget): Promise<void> {
    this.target = target;
    await vscode.commands.executeCommand('setContext', 'gittree.revTree.active', true);
    this._onDidChange.fire();
  }

  async close(): Promise<void> {
    this.target = undefined;
    await vscode.commands.executeCommand('setContext', 'gittree.revTree.active', false);
    this._onDidChange.fire();
  }

  async getChildren(node?: RevTreeNode): Promise<RevTreeNode[]> {
    const target = this.target;
    if (!target) return [];
    const uri = makeRevTreeUri(target.repo.root, target.rev, node?.rel ?? '');
    const entries = await this.fsProvider.readDirectory(uri);
    const base = node?.rel !== undefined && node.rel.length > 0 ? `${node.rel}/` : '';
    return entries
      .map(
        ([name, type]): RevTreeNode => ({
          rel: `${base}${name}`,
          name,
          isDir: type === vscode.FileType.Directory,
        }),
      )
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  getTreeItem(node: RevTreeNode): vscode.TreeItem {
    const target = this.target;
    const item = new vscode.TreeItem(
      node.name,
      node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    if (!node.isDir && target) {
      item.resourceUri = makeRevTreeUri(target.repo.root, target.rev, node.rel);
      item.command = {
        command: 'vscode.open',
        title: vscode.l10n.t('Open at revision'),
        arguments: [item.resourceUri],
      };
      item.iconPath = vscode.ThemeIcon.File;
    } else {
      item.iconPath = vscode.ThemeIcon.Folder;
    }
    return item;
  }
}
