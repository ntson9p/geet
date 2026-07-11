/**
 * Worktree watcher (master §4): one all-files workspace FileSystemWatcher per
 * repo — respects the user's files.watcherExclude. Thin vscode adapter; the
 * interesting logic (debounce, suppression, refresh) lives in StatusRefresher.
 */
import * as vscode from 'vscode';

export interface WorkspaceWatcherDeps {
  repoRoot: string;
  /** Events under this dir are the GitDirWatcher's business — filtered out. */
  gitDir: string;
  onWorktreeEvent: (fsPath: string, ts: number) => void;
}

export function createWorkspaceWatcher(deps: WorkspaceWatcherDeps): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const rootLower = normalize(deps.repoRoot);
  const gitDirLower = normalize(deps.gitDir);

  const handle = (uri: vscode.Uri): void => {
    if (uri.scheme !== 'file') return;
    const p = normalize(uri.fsPath);
    if (!p.startsWith(rootLower)) return;
    if (p.startsWith(gitDirLower) || p.includes('/.git/')) return;
    deps.onWorktreeEvent(uri.fsPath, Date.now());
  };

  const subs = [
    watcher,
    watcher.onDidChange(handle),
    watcher.onDidCreate(handle),
    watcher.onDidDelete(handle),
  ];
  return vscode.Disposable.from(...subs);
}

function normalize(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (!n.endsWith('/')) n += '/';
  // Windows paths are case-insensitive.
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
