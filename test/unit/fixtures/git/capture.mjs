// Regenerates the captured git-output fixtures in this directory.
//   node test/unit/fixtures/git/capture.mjs
// Requires git on PATH. Output bytes are written verbatim (*.bin) so the
// parser tests run against real porcelain output, not hand-typed strings.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.dirname(fileURLToPath(import.meta.url));

const baseEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'Åsa Ünicode',
  GIT_AUTHOR_EMAIL: 'asa@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Committer Person',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:06Z',
  HOME: undefined, // ignore user gitconfig on POSIX
  XDG_CONFIG_HOME: undefined,
};

function mkRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `geet-cap-${name}-`));
  git(dir, 'init');
  git(dir, 'config', 'user.name', 'Åsa Ünicode');
  git(dir, 'config', 'user.email', 'asa@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  // Default branch name varies by git version/config — normalize to main.
  try {
    git(dir, 'checkout', '-b', 'main');
  } catch {
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  }
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
    cwd,
    env: baseEnv,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function capture(file, cwd, ...args) {
  const buf = git(cwd, ...args);
  fs.writeFileSync(path.join(outDir, file), buf);
  console.log(`${file}  ${buf.length} bytes  (git ${args.join(' ')})`);
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'];

// ---------------------------------------------------------------- status-basic
{
  const r = mkRepo('basic');
  write(r, 'kept.txt', 'kept\n');
  write(r, 'modified-staged.txt', 'v1\n');
  write(r, 'modified-unstaged.txt', 'v1\n');
  write(r, 'deleted.txt', 'v1\n');
  write(r, 'ünïcode/ファイル.txt', 'unicode\n');
  write(r, 'name with spaces.txt', 'v1\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'base');
  write(r, 'modified-staged.txt', 'v2\n');
  git(r, 'add', 'modified-staged.txt');
  write(r, 'modified-unstaged.txt', 'v2\n');
  write(r, 'name with spaces.txt', 'v2\n');
  fs.rmSync(path.join(r, 'deleted.txt'));
  write(r, 'untracked-new.txt', 'new\n');
  write(r, 'ünïcode/新しい.txt', 'new\n');
  git(r, 'add', '-N', 'untracked-new.txt'); // intent-to-add shows as staged-add with worktree modification
  write(r, 'plain-untracked.txt', 'x\n');
  capture('status-basic.bin', r, ...STATUS_ARGS);
}

// --------------------------------------------------------------- status-rename
{
  const r = mkRepo('rename');
  write(r, 'old-name.txt', 'stable content that git will match as a rename\n');
  write(r, 'other.txt', 'other\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'base');
  git(r, 'mv', 'old-name.txt', 'new name with spaces.txt');
  capture('status-rename.bin', r, ...STATUS_ARGS);
}

// ------------------------------------------------------------- status-unmerged
{
  const r = mkRepo('unmerged');
  write(r, 'conflict.txt', 'base\n');
  write(r, 'both-added.txt.keep', 'x\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'base');
  git(r, 'checkout', '-b', 'side');
  write(r, 'conflict.txt', 'side change\n');
  write(r, 'both-added.txt', 'from side\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'side');
  git(r, 'checkout', 'main');
  write(r, 'conflict.txt', 'main change\n');
  write(r, 'both-added.txt', 'from main\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'main');
  try {
    git(r, 'merge', 'side');
  } catch {
    // expected conflict
  }
  capture('status-unmerged.bin', r, ...STATUS_ARGS);
  capture('lstree-stages.bin', r, 'ls-files', '--unmerged', '-z');
}

// ------------------------------------------------------------- status-detached
{
  const r = mkRepo('detached');
  write(r, 'a.txt', '1\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'one');
  write(r, 'a.txt', '2\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'two');
  git(r, 'checkout', 'HEAD~1');
  capture('status-detached.bin', r, ...STATUS_ARGS);
}

// -------------------------------------------- status-ab + upstream-gone + refs
{
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-cap-remote-'));
  git(remote, 'init', '--bare');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const a = mkRepo('aheadbehind');
  write(a, 'f.txt', '1\n');
  git(a, 'add', '.');
  git(a, 'commit', '-m', 'c1');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-u', 'origin', 'main');

  // Second clone commits + pushes → A becomes behind 1 after fetch.
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'geet-cap-cloneb-'));
  git(b, 'clone', remote, 'b');
  const bRepo = path.join(b, 'b');
  git(bRepo, 'config', 'user.name', 'B User');
  git(bRepo, 'config', 'user.email', 'b@example.com');
  write(bRepo, 'from-b.txt', 'b\n');
  git(bRepo, 'add', '.');
  git(bRepo, 'commit', '-m', 'from b');
  git(bRepo, 'push');

  // Local commit in A → ahead 1; fetch → behind 1.
  write(a, 'from-a.txt', 'a\n');
  git(a, 'add', '.');
  git(a, 'commit', '-m', 'from a');
  git(a, 'fetch');
  capture('status-ab.bin', a, ...STATUS_ARGS);

  // Tags + extra branch for the refs fixture.
  git(a, 'tag', '-a', 'v1.0', '-m', 'release v1.0');
  git(a, 'tag', 'lightweight-tag');
  git(a, 'branch', 'feature/topic');
  git(a, 'branch', '--set-upstream-to=origin/main', 'feature/topic');
  capture(
    'for-each-ref.bin',
    a,
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(creatordate:unix)%00%(symref)%00%(subject)',
    'refs/heads/**',
    'refs/remotes/**',
    'refs/tags/**',
  );

  // Upstream gone: delete the remote branch main tracks via a throwaway branch.
  git(a, 'checkout', '-b', 'doomed');
  git(a, 'push', '-u', 'origin', 'doomed');
  git(a, 'push', 'origin', '--delete', 'doomed');
  git(a, 'fetch', '--prune');
  capture('status-upstream-gone.bin', a, ...STATUS_ARGS);
}

// ------------------------------------------------------------------------- log
{
  const r = mkRepo('log');
  write(r, 'f.txt', '1\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'first: simple subject');
  write(r, 'f.txt', '2\n');
  git(r, 'add', '.');
  git(
    r,
    'commit',
    '-m',
    'second: subject with ünïcode',
    '-m',
    'A body paragraph.\n\nSecond paragraph with special chars: <>&"éフ.',
  );
  git(r, 'checkout', '-b', 'topic');
  write(r, 'g.txt', 'g\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'topic work');
  git(r, 'checkout', 'main');
  write(r, 'f.txt', '3\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'mainline work');
  git(r, 'merge', '--no-ff', 'topic', '-m', 'merge topic into main');
  git(r, 'tag', '-a', 'v0.1', '-m', 'tag msg');
  capture(
    'log.bin',
    r,
    'log',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b%x1e',
    '--all',
    '--topo-order',
  );
}

// ----------------------------------------------------------------------- blame
{
  const r = mkRepo('blame');
  write(r, 'code.ts', 'line one\nline two\nline three\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'add code');
  write(r, 'code.ts', 'line one\nline two CHANGED\nline three\nline four\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'change line two, add four');
  capture('blame-incremental.bin', r, 'blame', '--incremental', 'code.ts');
}

// ----------------------------------------------------------------------- stash
{
  const r = mkRepo('stash');
  write(r, 'f.txt', 'base\n');
  git(r, 'add', '.');
  git(r, 'commit', '-m', 'base');
  write(r, 'f.txt', 'wip change\n');
  git(r, 'stash', 'push');
  write(r, 'f.txt', 'named change\n');
  git(r, 'stash', 'push', '-m', 'my named stash: with colon');
  capture('stash-list.bin', r, 'stash', 'list', '--format=%gd%x00%H%x00%at%x00%gs%x1e');

  // Reflog with checkout traffic for the recency parser.
  git(r, 'checkout', '-b', 'feature/one');
  git(r, 'checkout', 'main');
  git(r, 'checkout', 'feature/one');
  git(r, 'checkout', 'main');
  capture('reflog-checkouts.bin', r, 'reflog', '--format=%at%x00%gs%x1e');
}

console.log('done');
