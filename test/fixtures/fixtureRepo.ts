/**
 * FixtureRepo (master P0-T10): scriptable scratch git repositories for unit
 * and integration tests. Pure node — usable from vitest and the extension
 * host alike. Canned histories use `git fast-import`, so a 2k-commit branchy
 * graph builds in about a second. Deterministic authors/dates keep goldens
 * stable. dispose() retries unlinks for Windows AV/file-lock behavior.
 */
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FileSpec {
  /** relPath → content; null deletes the file. */
  [relPath: string]: string | null;
}

export interface FixtureOptions {
  prefix?: string;
  /** Default branch name (default "main"). */
  branch?: string;
}

const AUTHOR = 'Fixture Author';
const AUTHOR_EMAIL = 'fixture@gittree.dev';
/** Base timestamp for deterministic history (2023-11-14T22:13:20Z). */
const EPOCH = 1_700_000_000;

export class FixtureRepo {
  private commitCounter = 0;
  private disposed = false;

  private constructor(
    readonly root: string,
    readonly defaultBranch: string,
  ) {}

  static create(options: FixtureOptions = {}): FixtureRepo {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'gittree-fixture-'));
    const branch = options.branch ?? 'main';
    const repo = new FixtureRepo(root, branch);
    repo.git('init');
    repo.git('config', 'user.name', AUTHOR);
    repo.git('config', 'user.email', AUTHOR_EMAIL);
    repo.git('config', 'commit.gpgsign', 'false');
    repo.git('config', 'core.autocrlf', 'false');
    // Normalize the default branch name across git versions.
    const current = repo.tryGit('symbolic-ref', '--short', 'HEAD');
    if (current.status === 0 && current.stdout.trim() !== branch) {
      repo.git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    }
    return repo;
  }

  get gitDir(): string {
    return path.join(this.root, '.git');
  }

  /** Runs git, throws with stderr on failure, returns stdout. */
  git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.root,
      encoding: 'utf8',
      env: this.env(),
      maxBuffer: 128 * 1024 * 1024,
    });
  }

  /** Runs git without throwing. */
  tryGit(...args: string[]): SpawnSyncReturns<string> {
    return spawnSync('git', args, { cwd: this.root, encoding: 'utf8', env: this.env() });
  }

  private env(): NodeJS.ProcessEnv {
    const ts = `${EPOCH + this.commitCounter} +0000`;
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: AUTHOR,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: ts,
      GIT_COMMITTER_DATE: ts,
    };
  }

  writeFiles(files: FileSpec): void {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(this.root, rel);
      if (content === null) {
        fs.rmSync(p, { force: true });
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      }
    }
  }

  /** Stages everything and commits; returns the new sha. */
  commit(message: string, files?: FileSpec): string {
    if (files) this.writeFiles(files);
    this.commitCounter++;
    this.git('add', '-A');
    this.git('commit', '--allow-empty', '-m', message);
    return this.head();
  }

  head(): string {
    return this.git('rev-parse', 'HEAD').trim();
  }

  currentBranch(): string | undefined {
    const r = this.tryGit('symbolic-ref', '--short', 'HEAD');
    return r.status === 0 ? r.stdout.trim() : undefined;
  }

  branch(name: string, options: { checkout?: boolean; at?: string } = {}): void {
    const args = options.checkout ? ['checkout', '-b', name] : ['branch', name];
    if (options.at) args.push(options.at);
    this.git(...args);
  }

  checkout(ref: string): void {
    this.git('checkout', ref);
  }

  /** Merge; returns true when clean, false when it stopped on conflicts. */
  merge(ref: string, options: { noFF?: boolean; message?: string } = {}): boolean {
    this.commitCounter++;
    const args = ['merge'];
    if (options.noFF) args.push('--no-ff');
    args.push('-m', options.message ?? `merge ${ref}`);
    args.push(ref);
    return this.tryGit(...args).status === 0;
  }

  tag(name: string, options: { message?: string } = {}): void {
    if (options.message !== undefined) {
      this.git('tag', '-a', name, '-m', options.message);
    } else {
      this.git('tag', name);
    }
  }

  detach(ref = 'HEAD~1'): void {
    this.git('checkout', '--detach', ref);
  }

  /**
   * Creates two branches with conflicting edits to the same file. Leaves the
   * repo on `ours`; merging `theirs` will conflict.
   */
  conflictPair(relPath = 'conflict.txt'): { ours: string; theirs: string; path: string } {
    if (this.tryGit('rev-parse', 'HEAD').status !== 0) {
      this.commit('base', { [relPath]: 'base line 1\nbase line 2\nbase line 3\n' });
    } else {
      this.commit('conflict base', { [relPath]: 'base line 1\nbase line 2\nbase line 3\n' });
    }
    const base = this.currentBranch() ?? this.defaultBranch;
    const theirs = 'fixture/theirs';
    this.branch(theirs, { checkout: true });
    this.commit('their change', { [relPath]: 'base line 1\nTHEIRS line 2\nbase line 3\n' });
    this.checkout(base);
    this.commit('our change', { [relPath]: 'base line 1\nOURS line 2\nbase line 3\n' });
    return { ours: base, theirs, path: relPath };
  }

  /** conflictPair + the conflicting merge: repo ends mid-merge with UU entries. */
  makeConflict(relPath = 'conflict.txt'): { path: string } {
    const pair = this.conflictPair(relPath);
    const clean = this.merge(pair.theirs);
    if (clean) throw new Error('fixture expected a merge conflict');
    return { path: pair.path };
  }

  /**
   * Starts a rebase that stops on a conflict, leaving .git/rebase-merge in
   * place (mid-rebase state for inProgressOp/UI tests).
   */
  startRebase(): void {
    const pair = this.conflictPair('rebase-conflict.txt');
    // Rebase ours onto theirs — first pick conflicts and the rebase stops.
    const result = this.tryGit('rebase', pair.theirs);
    if (result.status === 0) throw new Error('fixture expected the rebase to stop');
    if (!fs.existsSync(path.join(this.gitDir, 'rebase-merge')) && !fs.existsSync(path.join(this.gitDir, 'rebase-apply'))) {
      throw new Error(`rebase did not leave state: ${result.stderr}`);
    }
  }

  /** Committed CRLF file (content preserved verbatim — autocrlf off). */
  addCrlfFile(relPath = 'windows.txt'): void {
    this.commit('crlf file', { [relPath]: 'line one\r\nline two\r\nline three\r\n' });
  }

  /** Committed unicode paths + contents. */
  addUnicodeFiles(): string[] {
    const files = ['ünïcode/ファイル.txt', 'emoji-🎉.md'];
    this.commit('unicode files', {
      [files[0] as string]: 'unicode content é\n',
      [files[1] as string]: '# 🎉\n',
    });
    return files;
  }

  /** git mv + commit (staged rename detection case). */
  rename(from: string, to: string): void {
    this.commitCounter++;
    this.git('mv', from, to);
    this.git('commit', '-m', `rename ${from} → ${to}`);
  }

  /**
   * Fast history generator (fast-import): `commits` entries become real
   * commits on `refs/heads/<branch>`; each may name multiple parents (marks)
   * for merges. Returns mark→sha mapping.
   */
  fastImport(
    commits: Array<{
      mark: number;
      parents?: number[];
      message: string;
      files?: Record<string, string>;
      branch?: string;
    }>,
  ): Map<number, string> {
    const lines: string[] = [];
    let blobMark = 1_000_000;
    for (const c of commits) {
      const fileMarks: Array<{ path: string; mark: number }> = [];
      for (const [p, content] of Object.entries(c.files ?? {})) {
        blobMark++;
        const data = Buffer.from(content, 'utf8');
        lines.push(`blob`, `mark :${blobMark}`, `data ${data.length}`, content);
        fileMarks.push({ path: p, mark: blobMark });
      }
      const ts = EPOCH + ++this.commitCounter;
      const msg = Buffer.from(c.message, 'utf8');
      lines.push(`commit refs/heads/${c.branch ?? this.defaultBranch}`);
      lines.push(`mark :${c.mark}`);
      lines.push(`author ${AUTHOR} <${AUTHOR_EMAIL}> ${ts} +0000`);
      lines.push(`committer ${AUTHOR} <${AUTHOR_EMAIL}> ${ts} +0000`);
      lines.push(`data ${msg.length}`, c.message);
      const [first, ...rest] = c.parents ?? [];
      if (first !== undefined) lines.push(`from :${first}`);
      for (const p of rest) lines.push(`merge :${p}`);
      for (const f of fileMarks) lines.push(`M 100644 :${f.mark} ${f.path}`);
    }
    lines.push('done', '');

    const marksFile = path.join(this.root, '.git', 'fixture-marks');
    const result = spawnSync(
      'git',
      ['fast-import', '--done', `--export-marks=${marksFile}`, '--quiet'],
      { cwd: this.root, input: lines.join('\n'), encoding: 'utf8', env: this.env(), maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error(`fast-import failed: ${result.stderr}`);
    }
    const marks = new Map<number, string>();
    for (const line of fs.readFileSync(marksFile, 'utf8').split('\n')) {
      const m = /^:(\d+) ([0-9a-f]+)$/.exec(line.trim());
      if (m) marks.set(Number.parseInt(m[1] as string, 10), m[2] as string);
    }
    // fast-import only writes refs; materialize the worktree.
    this.git('checkout', '-f', this.defaultBranch);
    return marks;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows: .git/objects files are read-only, which makes unlink fail
      // with EPERM regardless of retries. Clear the attribute and try again.
      try {
        makeTreeWritable(this.root);
        fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Persistent lock (AV scanner) — leave the scratch dir to the OS.
      }
    }
  }
}

function makeTreeWritable(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        makeTreeWritable(p);
      } else {
        fs.chmodSync(p, 0o666);
      }
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------
// Canned histories (master P0-T10 step 2)
// ---------------------------------------------------------------------------

/** n linear commits on main, each touching file.txt and its own file. */
export function linear(n: number): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'gittree-linear-' });
  const commits = Array.from({ length: n }, (_, i) => ({
    mark: i + 1,
    parents: i === 0 ? [] : [i],
    message: `commit ${i + 1} of ${n}`,
    files: { 'file.txt': `content at ${i + 1}\n`, [`docs/f${i + 1}.md`]: `# ${i + 1}\n` },
  }));
  repo.fastImport(commits);
  return repo;
}

/**
 * Branchy history: chunks of mainline commits with side branches merged back
 * (two-parent merges), deterministic shape. `n` counts total commits
 * (including merge commits, ±1 for the final partial chunk).
 */
export function branchy(n: number): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'gittree-branchy-' });
  const commits: Parameters<FixtureRepo['fastImport']>[0] = [];
  let mark = 0;
  let mainTip = 0;
  const next = (parents: number[], message: string, files?: Record<string, string>): number => {
    mark++;
    commits.push({ mark, parents, message, files: files ?? { 'main.txt': `${message}\n` } });
    return mark;
  };
  mainTip = next([], 'root');
  while (commits.length < n) {
    // three mainline commits
    for (let i = 0; i < 3 && commits.length < n; i++) {
      mainTip = next([mainTip], `main ${commits.length + 1}`);
    }
    if (commits.length + 3 > n) break;
    // side branch of two commits, merged back
    const side1 = next([mainTip], `side ${commits.length + 1}`, { 'side.txt': `s${mark}\n` });
    const side2 = next([side1], `side ${commits.length + 1}`, { 'side.txt': `s${mark}b\n` });
    mainTip = next([mainTip, side2], `merge side at ${commits.length + 1}`);
  }
  repo.fastImport(commits);
  return repo;
}

/** Repo sitting in a conflicted merge (UU entry, MERGE_HEAD present). */
export function conflictBasic(): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'gittree-conflict-' });
  repo.makeConflict();
  return repo;
}

/** Repo stopped mid-rebase (.git/rebase-merge or rebase-apply present). */
export function midRebase(): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'gittree-midrebase-' });
  repo.startRebase();
  return repo;
}
