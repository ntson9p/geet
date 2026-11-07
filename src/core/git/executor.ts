/**
 * GitExecutor (master §8): the single gateway for every git invocation.
 * Argument arrays only — never shell strings; structured output only — never
 * localized text (LC_ALL=C is forced for parsed calls).
 *
 * This module is deliberately vscode-free so unit tests can drive it with
 * plain Node: the OutputChannel trace sink, settings-derived git path, and
 * askpass environment are injected by the core bootstrap (P0-T7 / P0-T8).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCapabilities, parseGitVersion, type GitCapabilities } from './capabilities';
import { makeGitError, GitError } from './errors';

/** Canonical absolute path of a repository root; opaque key for all services. */
export type RepoId = string;

/** Structural subset of vscode.CancellationToken (keeps this module vscode-free). */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ExecOpts {
  stdin?: string;
  env?: Record<string, string>;
  token?: CancelToken;
  /** Sets GIT_OPTIONAL_LOCKS=0 (background/status reads must never take optional locks). */
  noOptionalLocks?: boolean;
  /** Output is machine-parsed: force LC_ALL=C so git emits C-locale text. */
  structured?: boolean;
  /** Resolve with the GitResult on non-zero exit instead of throwing GitError. */
  allowNonZeroExit?: boolean;
  /** Working directory override for commands that must not run at the repo root. */
  cwd?: string;
  /** stream(): single-char frame delimiter — NUL (default), LF, or a custom
   *  record separator such as \x1e used by the log format. */
  delimiter?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Cancellable {
  cancel(): void;
  /**
   * Settles when the process exits: resolves (stdout empty — it was streamed)
   * on success or after cancel(); rejects with GitError on uncancelled
   * non-zero exit.
   */
  readonly done: Promise<GitResult>;
}

export interface GitExecutor {
  readonly version: string;
  readonly caps: GitCapabilities;
  readonly gitPath: string;
  exec(repo: RepoId, args: string[], o?: ExecOpts): Promise<GitResult>;
  stream(repo: RepoId, args: string[], onLine: (l: string) => void, o?: ExecOpts): Cancellable;
}

export interface ExecutorInit {
  gitPath: string;
  version: string;
  /** Structured trace sink (OutputChannel "GitTree" in production). */
  trace?: (line: string) => void;
  /** P12-T8: structured per-run record for the Console tab's ring buffer. */
  onDidRun?: (run: {
    ts: number;
    argv: readonly string[];
    exitCode: number;
    durationMs: number;
    stdout: string;
    stderr: string;
    /** The repository it ran for — the Console names it when there are several. */
    repo: RepoId;
  }) => void;
  /** Extra env merged into every spawn — askpass bridge vars (P0-T8). */
  baseEnv?: () => Record<string, string>;
  /** Test seam only: overrides the `-c` config args prepended to every call. */
  baseArgs?: string[];
}

/** Config args prepended to every invocation (stable, locale-independent paths/colors). */
const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false'];

/** Yield to the event loop after this many frames in one stream burst (§2). */
const STREAM_YIELD_EVERY = 2000;

const TRACE_ARG_MAX = 120;

export class GitExecutorImpl implements GitExecutor {
  readonly version: string;
  readonly caps: GitCapabilities;
  readonly gitPath: string;
  private readonly trace: (line: string) => void;
  private readonly onDidRun: ExecutorInit['onDidRun'];
  private readonly baseEnv: () => Record<string, string>;
  private readonly baseArgs: string[];

  constructor(init: ExecutorInit) {
    this.gitPath = init.gitPath;
    this.version = init.version;
    this.caps = buildCapabilities(init.version);
    this.trace = init.trace ?? (() => undefined);
    this.onDidRun = init.onDidRun;
    this.baseEnv = init.baseEnv ?? (() => ({}));
    this.baseArgs = init.baseArgs ?? BASE_ARGS;
  }

  private spawnGit(repo: RepoId, args: string[], o: ExecOpts): ChildProcessWithoutNullStreams {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.baseEnv(),
      GIT_TERMINAL_PROMPT: '0',
      ...(o.noOptionalLocks ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
      ...(o.structured ? { LC_ALL: 'C' } : {}),
      ...o.env,
    };
    return spawn(this.gitPath, [...this.baseArgs, ...args], {
      cwd: o.cwd ?? repo,
      env,
      windowsHide: true,
    });
  }

  private traceRun(
    repo: RepoId,
    args: string[],
    startedAt: number,
    exitCode: number,
    note = '',
    output: { stdout: string; stderr: string } = { stdout: '', stderr: '' },
  ): void {
    const ms = Date.now() - startedAt;
    const argv = args
      .map((a) => (a.length > TRACE_ARG_MAX ? `${a.slice(0, TRACE_ARG_MAX)}…(${a.length})` : a))
      .join(' ');
    this.trace(`git ${argv} → ${exitCode} in ${ms}ms${note ? ` (${note})` : ''}`);
    this.onDidRun?.({
      ts: startedAt,
      argv: args,
      exitCode,
      durationMs: ms,
      stdout: output.stdout,
      stderr: output.stderr,
      repo,
    });
  }

  async exec(repo: RepoId, args: string[], o: ExecOpts = {}): Promise<GitResult> {
    if (o.token?.isCancellationRequested) {
      throw new GitError('unknown', 'Operation cancelled before start', {
        args,
        exitCode: -1,
        stderr: '',
        stdout: '',
        cwd: repo,
      });
    }
    const startedAt = Date.now();
    const child = this.spawnGit(repo, args, o);
    let cancelled = false;
    const tokenSub = o.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    if (o.stdin !== undefined) {
      child.stdin.on('error', () => undefined); // EPIPE if git exits before reading
      child.stdin.write(o.stdin);
    }
    child.stdin.end();

    try {
      const exitCode = await waitForExit(child);
      const result: GitResult = {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
      };
      this.traceRun(repo, args, startedAt, exitCode, cancelled ? 'cancelled' : '', {
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (exitCode !== 0 && !o.allowNonZeroExit && !cancelled) {
        throw makeGitError({ args, exitCode, stderr: result.stderr, stdout: result.stdout, cwd: repo });
      }
      return result;
    } finally {
      tokenSub?.dispose();
    }
  }

  stream(repo: RepoId, args: string[], onLine: (l: string) => void, o: ExecOpts = {}): Cancellable {
    const startedAt = Date.now();
    const delimiter = o.delimiter ?? '\0';
    const child = this.spawnGit(repo, args, o);
    let cancelled = false;
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    if (o.stdin !== undefined) {
      child.stdin.on('error', () => undefined); // EPIPE if git exits early
      child.stdin.write(o.stdin);
    }
    child.stdin.end();

    let finished = false;
    let resolveDone!: (r: GitResult) => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<GitResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    let pending = '';
    let pumpScheduled = false;
    let exitCode: number | undefined;

    const tokenSub = o.token?.onCancellationRequested(() => {
      cancelled = true;
      killTree(child);
    });

    const finalize = (): void => {
      if (finished) return;
      finished = true;
      tokenSub?.dispose();
      // Flush a trailing unterminated frame (git ends -z output with NUL, but
      // LF-framed output may lack the final newline).
      if (!cancelled && pending.length > 0) {
        onLine(pending);
        pending = '';
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const code = exitCode ?? -1;
      this.traceRun(repo, args, startedAt, code, cancelled ? 'cancelled (stream)' : 'stream', {
        stdout: '',
        stderr,
      });
      if (code !== 0 && !cancelled && !o.allowNonZeroExit) {
        rejectDone(makeGitError({ args, exitCode: code, stderr, stdout: '', cwd: repo }));
      } else {
        resolveDone({ stdout: '', stderr, exitCode: code });
      }
    };

    // Drains complete frames from `pending`, yielding to the event loop every
    // STREAM_YIELD_EVERY frames (pause → setImmediate → continue) so a
    // 100k-record burst cannot starve the extension host (§2 process model).
    const pump = (): void => {
      pumpScheduled = false;
      if (finished) return;
      let count = 0;
      let idx: number;
      while (!cancelled && (idx = pending.indexOf(delimiter)) !== -1) {
        const frame = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        onLine(frame);
        if (++count >= STREAM_YIELD_EVERY) {
          pumpScheduled = true;
          child.stdout.pause();
          setImmediate(pump);
          return;
        }
      }
      if (exitCode !== undefined || cancelled) {
        finalize();
      } else {
        child.stdout.resume();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (!pumpScheduled) pump();
    });

    child.once('error', (e) => {
      if (!finished) {
        finished = true;
        tokenSub?.dispose();
        rejectDone(e);
      }
    });
    child.once('close', (code, signal) => {
      exitCode = code ?? (signal ? -1 : 0);
      if (!pumpScheduled) pump();
    });

    return {
      cancel: () => {
        cancelled = true;
        killTree(child);
      },
      done,
    };
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve(code ?? (signal ? -1 : 0));
    });
  });
}

/** SIGTERM on POSIX; `taskkill /T /F` on Windows so the whole tree dies (§4). */
export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
    const pid = child.pid;
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 2000).unref();
  }
}

// ---------------------------------------------------------------------------
// Locating git (T2 step 1). Pure logic here; P0-T7 supplies the settings.
// ---------------------------------------------------------------------------

export interface GitLocatorSettings {
  /**
   * `gittree.gitPath`. P14-T5 removed the built-in `git.path` fallback that
   * used to sit between this and PATH — GitTree reads no `git.*` configuration.
   */
  gittreeGitPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Ordered candidate list: settings → PATH → well-known Windows installs. */
export function resolveGitCandidates(s: GitLocatorSettings = {}): string[] {
  const platform = s.platform ?? process.platform;
  const env = s.env ?? process.env;
  const candidates: string[] = [];
  if (s.gittreeGitPath) candidates.push(s.gittreeGitPath);
  candidates.push('git'); // PATH lookup via spawn
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LocalAppData']].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    for (const root of roots) {
      candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    }
    candidates.push('C:\\Program Files\\Git\\cmd\\git.exe');
  } else if (platform === 'darwin') {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git');
  }
  // De-duplicate, preserving priority order.
  return [...new Set(candidates)];
}

export interface FoundGit {
  path: string;
  version: string;
}

/** Probes candidates with `git --version`; first one that answers wins. */
export async function findGit(candidates: string[]): Promise<FoundGit | undefined> {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const version = await probeVersion(candidate);
    if (version) return { path: candidate, version };
  }
  return undefined;
}

function probeVersion(gitPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(gitPath, ['--version'], { windowsHide: true });
    } catch {
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      resolve(parseGitVersion(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

/** Convenience bootstrap: locate git and build the executor. */
export async function createGitExecutor(
  settings: GitLocatorSettings,
  init: Omit<ExecutorInit, 'gitPath' | 'version'> = {},
): Promise<GitExecutorImpl | undefined> {
  const found = await findGit(resolveGitCandidates(settings));
  if (!found) return undefined;
  return new GitExecutorImpl({ ...init, gitPath: found.path, version: found.version });
}
