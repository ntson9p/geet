/**
 * Raw fs.watch over the git dir (master §4). The VS Code workspace watcher
 * excludes `.git` by default, so repo-state changes (HEAD, index, refs,
 * in-progress op markers) are observed here. Directories are watched rather
 * than files because git replaces files atomically via rename, which kills
 * per-file watchers; directory watchers survive child renames.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable, type Event } from '../util/events';

export interface ResolvedGitDir {
  /** The repo's own git dir (worktree-private for linked worktrees). */
  gitDir: string;
  /** Shared dir holding refs/packed-refs (differs from gitDir in worktrees). */
  commonDir: string;
}

/**
 * Resolves `.git` for a worktree root: a directory is used as-is; a file is
 * followed through its `gitdir:` pointer; `commondir` indirection is applied
 * for linked worktrees/submodules.
 */
export function resolveGitDir(repoRoot: string): ResolvedGitDir | undefined {
  const dotGit = path.join(repoRoot, '.git');
  let gitDir: string;
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else {
      const content = fs.readFileSync(dotGit, 'utf8');
      const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
      if (!m || m[1] === undefined) return undefined;
      gitDir = path.resolve(repoRoot, m[1]);
    }
  } catch {
    return undefined;
  }

  let commonDir = gitDir;
  try {
    const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (common.length > 0) commonDir = path.resolve(gitDir, common);
  } catch {
    // no commondir file — primary worktree
  }
  return { gitDir, commonDir };
}

export interface GitDirChange {
  /** Path relative to the git dir that changed (best effort). */
  relPath: string;
  ts: number;
}

/** Direct children of the git dir worth reacting to. */
const INTERESTING_FILES = new Set([
  'HEAD',
  'index',
  'packed-refs',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'FETCH_HEAD',
  'ORIG_HEAD',
]);
const INTERESTING_DIRS = new Set(['rebase-merge', 'rebase-apply', 'sequencer', 'refs', 'worktrees']);

export class GitDirWatcher implements Disposable {
  private readonly _onDidChange = new Emitter<GitDirChange>();
  readonly onDidChange: Event<GitDirChange> = this._onDidChange.event;

  private readonly watchers = new Map<string, fs.FSWatcher>();
  private disposed = false;
  private rescanTimer: NodeJS.Timeout | undefined;

  constructor(private readonly dirs: ResolvedGitDir) {
    this.armAll();
  }

  private armAll(): void {
    this.watchDir(this.dirs.gitDir, '');
    if (this.dirs.commonDir !== this.dirs.gitDir) {
      this.watchDir(this.dirs.commonDir, '');
    }
    this.armRefsTree(path.join(this.dirs.commonDir, 'refs'));
    for (const opDir of ['rebase-merge', 'rebase-apply', 'sequencer']) {
      const p = path.join(this.dirs.gitDir, opDir);
      if (fs.existsSync(p)) this.watchDir(p, opDir);
    }
  }

  /**
   * refs/** must be watched recursively. fs.watch({recursive}) is unsupported
   * on Linux, so each subdirectory is armed individually and the tree is
   * re-walked when events arrive.
   */
  private armRefsTree(refsDir: string): void {
    if (!fs.existsSync(refsDir)) return;
    const walk = (dir: string): void => {
      this.watchDir(dir, path.relative(this.dirs.commonDir, dir).replace(/\\/g, '/'));
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
      }
    };
    walk(refsDir);
  }

  private watchDir(dir: string, relBase: string): void {
    if (this.disposed || this.watchers.has(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false });
    } catch {
      return; // dir vanished between check and watch
    }
    this.watchers.set(dir, watcher);
    watcher.on('change', (_event, filename) => {
      const name = typeof filename === 'string' ? filename : '';
      this.handleEvent(relBase, name);
    });
    watcher.on('error', () => {
      // Directory deleted or handle lost — drop and rescan shortly.
      watcher.close();
      this.watchers.delete(dir);
      this.scheduleRescan();
    });
  }

  private handleEvent(relBase: string, name: string): void {
    if (this.disposed) return;
    // Lock files are write-then-rename staging noise; the rename onto the
    // real file produces its own event.
    if (name.endsWith('.lock')) return;

    const rel = relBase.length > 0 ? `${relBase}/${name}` : name;

    if (relBase === '') {
      const isInteresting =
        INTERESTING_FILES.has(name) || INTERESTING_DIRS.has(name) || name.startsWith('refs');
      if (!isInteresting) return;
      // A new op dir or refs subtree may need arming (rebase started, first
      // remote fetched, …).
      if (INTERESTING_DIRS.has(name)) this.scheduleRescan();
    } else if (relBase.startsWith('refs')) {
      // Possible new subdirectory (e.g. refs/remotes/neworigin) — re-walk.
      this.scheduleRescan();
    }

    this._onDidChange.fire({ relPath: rel.replace(/\\/g, '/'), ts: Date.now() });
  }

  private scheduleRescan(): void {
    if (this.disposed || this.rescanTimer) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      if (this.disposed) return;
      this.armRefsTree(path.join(this.dirs.commonDir, 'refs'));
      for (const opDir of ['rebase-merge', 'rebase-apply', 'sequencer']) {
        const p = path.join(this.dirs.gitDir, opDir);
        if (fs.existsSync(p) && !this.watchers.has(p)) this.watchDir(p, opDir);
      }
      // Drop watchers whose directories vanished.
      for (const [dir, watcher] of this.watchers) {
        if (!fs.existsSync(dir)) {
          watcher.close();
          this.watchers.delete(dir);
        }
      }
    }, 100);
    this.rescanTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this._onDidChange.dispose();
  }
}
