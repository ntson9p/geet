/**
 * Worktree watcher (master §4): one all-files workspace FileSystemWatcher for
 * the window — respects the user's files.watcherExclude — routing each event
 * to the owning repository. Thin vscode adapter; debounce/suppression/refresh
 * logic lives in StatusRefresher.
 */
import * as vscode from 'vscode';

export interface WorktreeTarget {
  root: string;
  /** Events under the git dir are the GitDirWatcher's business — filtered out. */
  gitDir: string;
  onWorktreeEvent: (fsPath: string, ts: number) => void;
}

export function createWorkspaceWatcher(
  resolveTarget: (fsPath: string) => WorktreeTarget | undefined,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');

  const handle = (uri: vscode.Uri): void => {
    if (uri.scheme !== 'file') return;
    const target = resolveTarget(uri.fsPath);
    if (!target) return;
    const p = normalize(uri.fsPath);
    if (p.startsWith(normalize(target.gitDir)) || p.includes('/.git/')) return;
    target.onWorktreeEvent(uri.fsPath, Date.now());
  };

  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(handle),
    watcher.onDidCreate(handle),
    watcher.onDidDelete(handle),
  );
}

function normalize(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (!n.endsWith('/')) n += '/';
  // Windows paths are case-insensitive.
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
