import { describe, expect, it } from 'vitest';
import { GitError } from '../../../../src/core/git/errors';
import {
  GitExecutorImpl,
  findGit,
  resolveGitCandidates,
  type CancelToken,
} from '../../../../src/core/git/executor';

/** Executor pointed at Node so behavior is testable without git and with `-e` scripts. */
function nodeExecutor(): GitExecutorImpl {
  return new GitExecutorImpl({
    gitPath: process.execPath,
    version: '2.43.0',
    baseArgs: [],
  });
}

function manualToken(): CancelToken & { cancel(): void } {
  const listeners: Array<() => void> = [];
  let cancelled = false;
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(l: () => void) {
      listeners.push(l);
      return { dispose: () => undefined };
    },
    cancel() {
      cancelled = true;
      for (const l of listeners) l();
    },
  };
}

const CWD = process.cwd();

describe('GitExecutorImpl.exec', () => {
  it('collects stdout, stderr and exit code', async () => {
    const r = await nodeExecutor().exec(CWD, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err");',
    ]);
    expect(r).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('throws classified GitError on non-zero exit', async () => {
    const err = await nodeExecutor()
      .exec(CWD, ['-e', 'console.error("fatal: The current branch x has no upstream branch."); process.exit(128)'])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe('no-upstream');
    expect((err as GitError).exitCode).toBe(128);
  });

  it('resolves non-zero exit when allowNonZeroExit', async () => {
    const r = await nodeExecutor().exec(CWD, ['-e', 'process.exit(1)'], { allowNonZeroExit: true });
    expect(r.exitCode).toBe(1);
  });

  it('pipes stdin', async () => {
    const r = await nodeExecutor().exec(
      CWD,
      ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))'],
      { stdin: 'hello' },
    );
    expect(r.stdout).toBe('HELLO');
  });

  it('sets GIT_TERMINAL_PROMPT=0 always and LC_ALL=C only when structured', async () => {
    const script =
      'process.stdout.write(JSON.stringify({t:process.env.GIT_TERMINAL_PROMPT,l:process.env.LC_ALL,o:process.env.GIT_OPTIONAL_LOCKS}))';
    const ex = nodeExecutor();

    const plain = JSON.parse((await ex.exec(CWD, ['-e', script])).stdout) as Record<string, string>;
    expect(plain['t']).toBe('0');
    expect(plain['l']).toBe(process.env['LC_ALL']); // untouched
    expect(plain['o']).toBe(process.env['GIT_OPTIONAL_LOCKS']); // untouched

    const structured = JSON.parse(
      (await ex.exec(CWD, ['-e', script], { structured: true, noOptionalLocks: true })).stdout,
    ) as Record<string, string>;
    expect(structured['t']).toBe('0');
    expect(structured['l']).toBe('C');
    expect(structured['o']).toBe('0');
  });

  it('rejects before spawn when the token is already cancelled', async () => {
    const token = manualToken();
    token.cancel();
    await expect(nodeExecutor().exec(CWD, ['-e', ''], { token })).rejects.toBeInstanceOf(GitError);
  });

  it('kills a hung process on cancellation and resolves without throwing', async () => {
    const token = manualToken();
    const ex = nodeExecutor();
    const promise = ex.exec(CWD, ['-e', 'console.log("started"); setInterval(()=>{}, 1000)'], {
      token,
    });
    // Give the child a beat to start, then cancel.
    await new Promise((r) => setTimeout(r, 300));
    token.cancel();
    const result = await promise;
    expect(result.exitCode).not.toBe(0); // killed, not clean exit
  }, 15_000);

  it('rejects with a spawn error for a missing binary', async () => {
    const ex = new GitExecutorImpl({ gitPath: 'definitely-not-a-real-binary-xyz', version: '2.43.0', baseArgs: [] });
    await expect(ex.exec(CWD, ['--version'])).rejects.toThrow();
  });
});

describe('GitExecutorImpl.stream', () => {
  it('frames on NUL by default', async () => {
    const frames: string[] = [];
    const h = nodeExecutor().stream(
      CWD,
      ['-e', 'process.stdout.write("a\\0b\\0c\\0")'],
      (l) => frames.push(l),
    );
    const r = await h.done;
    expect(frames).toEqual(['a', 'b', 'c']);
    expect(r.exitCode).toBe(0);
  });

  it('frames on LF when requested and flushes trailing frame', async () => {
    const frames: string[] = [];
    const h = nodeExecutor().stream(
      CWD,
      ['-e', 'process.stdout.write("one\\ntwo\\nthree")'],
      (l) => frames.push(l),
      { delimiter: '\n' },
    );
    await h.done;
    expect(frames).toEqual(['one', 'two', 'three']);
  });

  it('handles frames split across chunks', async () => {
    const frames: string[] = [];
    const script =
      'process.stdout.write("hel");setTimeout(()=>{process.stdout.write("lo\\0wor");setTimeout(()=>process.stdout.write("ld\\0"),20)},20)';
    const h = nodeExecutor().stream(CWD, ['-e', script], (l) => frames.push(l));
    await h.done;
    expect(frames).toEqual(['hello', 'world']);
  });

  it('streams a large burst completely (backpressure yield path)', async () => {
    const frames: string[] = [];
    const script = 'const n=10000;let s="";for(let i=0;i<n;i++)s+=i+"\\0";process.stdout.write(s)';
    const h = nodeExecutor().stream(CWD, ['-e', script], (l) => frames.push(l));
    await h.done;
    expect(frames.length).toBe(10000);
    expect(frames[0]).toBe('0');
    expect(frames[9999]).toBe('9999');
  });

  it('cancel() kills a producing process and done resolves', async () => {
    const frames: string[] = [];
    const script = 'setInterval(()=>process.stdout.write("tick\\0"), 10)';
    const ex = nodeExecutor();
    const h = ex.stream(CWD, ['-e', script], (l) => frames.push(l));
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (frames.length >= 3) {
          clearInterval(iv);
          resolve();
        }
      }, 10);
    });
    h.cancel();
    const r = await h.done; // must settle, not hang or reject
    expect(r.exitCode).not.toBe(0);
    const at = frames.length;
    await new Promise((r2) => setTimeout(r2, 100));
    expect(frames.length).toBe(at); // production stopped
  }, 15_000);

  it('rejects done with GitError on uncancelled non-zero exit', async () => {
    const h = nodeExecutor().stream(CWD, ['-e', 'process.exit(3)'], () => undefined);
    await expect(h.done).rejects.toBeInstanceOf(GitError);
  });
});

describe('resolveGitCandidates', () => {
  it('orders the setting first, then PATH, then well-known locations', () => {
    // P14-T5 removed the built-in `git.path` fallback that used to sit between
    // `gittree.gitPath` and PATH — GitTree reads no `git.*` configuration.
    const c = resolveGitCandidates({
      gittreeGitPath: 'X:\\custom\\git.exe',
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
    });
    expect(c[0]).toBe('X:\\custom\\git.exe');
    expect(c[1]).toBe('git');
    expect(c).toContain('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('de-duplicates while keeping priority order', () => {
    const c = resolveGitCandidates({ gittreeGitPath: 'git', platform: 'linux', env: {} });
    expect(c.filter((x) => x === 'git')).toHaveLength(1);
    expect(c[0]).toBe('git');
  });

  it('adds unix locations on linux/darwin', () => {
    expect(resolveGitCandidates({ platform: 'linux', env: {} })).toContain('/usr/bin/git');
    expect(resolveGitCandidates({ platform: 'darwin', env: {} })).toContain('/opt/homebrew/bin/git');
  });
});

describe('findGit', () => {
  it('finds a real git on PATH (dev machines and CI have one)', async () => {
    const found = await findGit(['git']);
    expect(found).toBeDefined();
    expect(found?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('skips missing absolute paths and bad binaries', async () => {
    const found = await findGit(['Z:\\nope\\git.exe', 'definitely-not-a-real-binary-xyz', 'git']);
    expect(found?.path).toBe('git');
  });

  it('returns undefined when nothing answers', async () => {
    const found = await findGit(['definitely-not-a-real-binary-xyz']);
    expect(found).toBeUndefined();
  });
});
