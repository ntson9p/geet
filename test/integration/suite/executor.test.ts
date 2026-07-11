import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GitExecutorImpl,
  createGitExecutor,
  findGit,
  resolveGitCandidates,
} from '../../../src/core/git/executor';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-exec-'));
  const run = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  run('init');
  run('config', 'user.email', 'test@gittree.dev');
  run('config', 'user.name', 'GitTree Test');
  run('config', 'commit.gpgsign', 'false');
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(dir, 'file.txt'), `content ${i}\n`);
    run('add', '.');
    run('commit', '-m', `commit ${i}`);
  }
  return dir;
}

suite('P0-T2 GitExecutor (real git)', () => {
  let repo: string;
  let git: GitExecutorImpl;

  suiteSetup(async () => {
    repo = makeTempRepo();
    const exec = await createGitExecutor({});
    assert.ok(exec, 'no git found on this machine');
    git = exec;
  });

  suiteTeardown(() => {
    try {
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* scratch dir */
    }
  });

  test('probes version and builds capabilities', () => {
    assert.match(git.version, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(typeof git.caps.stashStaged, 'boolean');
  });

  test('exec: git status --porcelain=v2 on a fixture repo', async () => {
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x\n');
    const r = await git.exec(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      structured: true,
      noOptionalLocks: true,
    });
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes('# branch.head'), 'expected branch header');
    assert.ok(r.stdout.includes('dirty.txt'), 'expected untracked entry');
    fs.rmSync(path.join(repo, 'dirty.txt'));
  });

  test('exec: throws classified GitError on failure', async () => {
    await assert.rejects(
      git.exec(repo, ['checkout', 'does-not-exist-branch']),
      (e: Error) => e.name === 'GitError',
    );
  });

  test('stream: NUL-framed git log records', async () => {
    const frames: string[] = [];
    const h = git.stream(
      repo,
      ['log', '--format=%H%x00', '-z'],
      (l) => {
        if (l.trim().length > 0) frames.push(l.trim());
      },
      { structured: true },
    );
    await h.done;
    assert.strictEqual(frames.length, 3);
    for (const f of frames) assert.match(f, /^[0-9a-f]{40}$/);
  });

  test('cancellation kills a mid-stream child on this OS', async function () {
    // Electron binary as Node — a child that streams then hangs, deterministic
    // on every OS regardless of repo size.
    const ex = new GitExecutorImpl({ gitPath: process.execPath, version: '2.43.0', baseArgs: [] });
    const frames: string[] = [];
    const h = ex.stream(
      os.tmpdir(),
      ['-e', 'setInterval(()=>process.stdout.write("tick\\0"),15)'],
      (l) => frames.push(l),
      { env: { ELECTRON_RUN_AS_NODE: '1' } },
    );
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (frames.length >= 2) {
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
    h.cancel();
    const r = await h.done;
    assert.notStrictEqual(r.exitCode, 0);
    const at = frames.length;
    await new Promise((r2) => setTimeout(r2, 150));
    assert.strictEqual(frames.length, at, 'child kept producing after cancel');
  });

  test('locator: candidate chain resolves a working git', async () => {
    const found = await findGit(resolveGitCandidates({}));
    assert.ok(found);
  });
});
