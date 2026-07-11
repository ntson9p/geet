/**
 * `gittree-rev:` — read-only file content at a revision or index stage
 * (master §2 virtual documents). URIs carry the repo root, repo-relative
 * path and ref in the query; the path component mirrors the file path so
 * editor tabs and diff titles look natural.
 *
 * ref forms: 'HEAD', any ref/sha, or ':0'/':1'/':2'/':3' index stages.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core } from '../core';

export const REV_SCHEME = 'gittree-rev';

interface RevQuery {
  repo: string;
  rel: string;
  ref: string;
}

export function makeRevUri(repoRoot: string, relPath: string, ref: string): vscode.Uri {
  const rel = relPath.replace(/\\/g, '/');
  const query: RevQuery = { repo: repoRoot, rel, ref };
  return vscode.Uri.from({
    scheme: REV_SCHEME,
    path: '/' + rel,
    query: JSON.stringify(query),
  });
}

export function parseRevUri(uri: vscode.Uri): RevQuery | undefined {
  if (uri.scheme !== REV_SCHEME) return undefined;
  try {
    const q = JSON.parse(uri.query) as RevQuery;
    if (typeof q.repo !== 'string' || typeof q.rel !== 'string' || typeof q.ref !== 'string') {
      return undefined;
    }
    return q;
  } catch {
    return undefined;
  }
}

/** `:0` + `a/b.ts` → `:0:a/b.ts`; `HEAD` + `a/b.ts` → `HEAD:a/b.ts`. */
export function revObjectSpec(ref: string, rel: string): string {
  return `${ref}:${rel}`;
}

export class RevContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  /** Served URIs per repo (canonical root → uri strings) for refresh fires. */
  private readonly served = new Map<string, Set<string>>();

  constructor(private readonly core: Core) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const q = parseRevUri(uri);
    if (!q) return '';
    const repo = this.core.repoForPath(q.repo);
    if (!repo) return '';

    this.remember(repo.root, uri);

    const result = await repo.queue.enqueue({
      label: `show ${q.ref}:${q.rel}`,
      kind: 'read',
      run: (git, opToken) =>
        git.exec(repo.root, ['show', revObjectSpec(q.ref, q.rel)], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token: opToken,
        }),
    });
    if (token.isCancellationRequested) return '';
    // Path absent at that revision (added file, unborn HEAD, …) → empty original.
    return result.exitCode === 0 ? result.stdout : '';
  }

  private remember(repoRoot: string, uri: vscode.Uri): void {
    const key = repoRoot.toLowerCase();
    let set = this.served.get(key);
    if (!set) {
      set = new Set();
      this.served.set(key, set);
    }
    set.add(uri.toString());
    if (set.size > 500) {
      // Bounded: drop the oldest half (insertion order).
      const keep = [...set].slice(set.size / 2);
      this.served.set(key, new Set(keep));
    }
  }

  /** Fired by the phase registration when a repo's status changed. */
  refreshRepo(repoRoot: string): void {
    const set = this.served.get(repoRoot.toLowerCase());
    if (!set) return;
    for (const s of set) {
      this._onDidChange.fire(vscode.Uri.parse(s));
    }
  }

  forget(uri: vscode.Uri): void {
    for (const set of this.served.values()) {
      set.delete(uri.toString());
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.served.clear();
  }
}

/** Human diff titles that mimic the built-in git extension. */
export function diffTitle(relPath: string, kind: 'working-tree' | 'index' | 'head'): string {
  const base = path.posix.basename(relPath.replace(/\\/g, '/'));
  switch (kind) {
    case 'working-tree':
      return `${base} (Working Tree)`;
    case 'index':
      return `${base} (Index)`;
    case 'head':
      return `${base} (HEAD)`;
  }
}
