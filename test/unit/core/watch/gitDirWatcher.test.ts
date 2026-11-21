import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitDirWatcher,
  resolveGitDir,
  type GitDirChange,
} from '../../../../src/core/watch/gitDirWatcher';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-watch-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* tmp */
    }
  });
  return dir;
}

/** Fake .git layout without needing real git. */
function fakeGitDir(root: string): string {
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'index'), 'INDEX');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  return gitDir;
}

function watchEvents(gitDir: string): { watcher: GitDirWatcher; events: GitDirChange[] } {
  const resolved = { gitDir, commonDir: gitDir };
  const watcher = new GitDirWatcher(resolved);
  cleanups.push(() => watcher.dispose());
  const events: GitDirChange[] = [];
  watcher.onDidChange((e) => events.push(e));
  return { watcher, events };
}

async function eventually(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('resolveGitDir', () => {
  it('returns the .git directory as-is', () => {
    const root = tmpdir();
    const gitDir = fakeGitDir(root);
    expect(resolveGitDir(root)).toEqual({ gitDir, commonDir: gitDir });
  });

  it('follows a .git file (linked worktree) and commondir', () => {
    const root = tmpdir();
    const mainGit = path.join(root, 'main', '.git');
    const wtGit = path.join(mainGit, 'worktrees', 'wt1');
    const wtRoot = path.join(root, 'wt1');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.mkdirSync(wtRoot, { recursive: true });
    fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${wtGit}\n`);
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const resolved = resolveGitDir(wtRoot);
    expect(resolved?.gitDir).toBe(wtGit);
    expect(resolved?.commonDir).toBe(path.resolve(mainGit));
  });

  it('resolves relative gitdir pointers (submodule layout)', () => {
    const root = tmpdir();
    const modGit = path.join(root, '.git', 'modules', 'sub');
    const subRoot = path.join(root, 'sub');
    fs.mkdirSync(modGit, { recursive: true });
    fs.mkdirSync(subRoot, { recursive: true });
    fs.writeFileSync(path.join(subRoot, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(resolveGitDir(subRoot)?.gitDir).toBe(path.resolve(modGit));
  });

  it('returns undefined for a non-repo', () => {
    expect(resolveGitDir(tmpdir())).toBeUndefined();
  });
});

describe('GitDirWatcher', () => {
  it('reports HEAD changes', async () => {
    const gitDir = fakeGitDir(tmpdir());
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100)); // let watchers arm
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/dev\n');
    await eventually(() => events.some((e) => e.relPath === 'HEAD'));
  });

  it('survives atomic rename replacement of the index (git-style write)', async () => {
    const gitDir = fakeGitDir(tmpdir());
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100));
    // git writes index.lock then renames over index.
    fs.writeFileSync(path.join(gitDir, 'index.lock'), 'NEWINDEX');
    fs.renameSync(path.join(gitDir, 'index.lock'), path.join(gitDir, 'index'));
    await eventually(() => events.some((e) => e.relPath === 'index'));
    // …and still works for a second replacement (watcher not killed).
    events.length = 0;
    fs.writeFileSync(path.join(gitDir, 'index.lock'), 'NEWERINDEX');
    fs.renameSync(path.join(gitDir, 'index.lock'), path.join(gitDir, 'index'));
    await eventually(() => events.some((e) => e.relPath === 'index'));
  });

  it('filters .lock staging noise', async () => {
    const gitDir = fakeGitDir(tmpdir());
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(gitDir, 'index.lock'), 'X');
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e.relPath.endsWith('.lock'))).toHaveLength(0);
    fs.rmSync(path.join(gitDir, 'index.lock'));
  });

  it('reports ref updates under refs/heads', async () => {
    const gitDir = fakeGitDir(tmpdir());
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'b'.repeat(40) + '\n');
    await eventually(() => events.some((e) => e.relPath.includes('refs/heads')));
  });

  it('picks up newly created op dirs (rebase start) after rescan', async () => {
    const gitDir = fakeGitDir(tmpdir());
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100));
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'msgnum'), '1');
    await eventually(() => events.some((e) => e.relPath.startsWith('rebase-merge')));
    // After the rescan the inner dir is watched: step updates arrive too.
    await new Promise((r) => setTimeout(r, 250));
    events.length = 0;
    fs.writeFileSync(path.join(gitDir, 'rebase-merge', 'msgnum'), '2');
    await eventually(() => events.some((e) => e.relPath === 'rebase-merge/msgnum'));
  });

  it('ignores unrelated churn like objects/', async () => {
    const gitDir = fakeGitDir(tmpdir());
    fs.mkdirSync(path.join(gitDir, 'objects', 'aa'), { recursive: true });
    const { events } = watchEvents(gitDir);
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(gitDir, 'objects', 'aa', 'blob1'), 'x');
    await new Promise((r) => setTimeout(r, 300));
    expect(events.filter((e) => e.relPath.startsWith('objects'))).toHaveLength(0);
  });
});
