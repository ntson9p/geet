/**
 * LogService (P4-T1): streaming pager over the P0-T3 log format with an
 * LRU page cache, ref-decoration chips, commit details, author autocomplete
 * and commit-graph maintenance. vscode-free (executor/queue injected) apart
 * from Uri-free DTOs so vitest can drive it.
 */
import type { RepoHandle } from '../core/core';
import type { GitExecutor } from '../core/git/executor';
import { parseNameStatusZ, type NameStatusEntry } from '../branches/parsing';
import {
  LOG_FORMAT,
  LOG_RECORD_SEPARATOR,
  parseDecorations,
  parseLogRecord,
  type Commit,
} from '../core/git/parsers/logFormat';
import { buildLogArgs, filterKey, type LogFilter } from './logFilter';
import { parseCommitsNameStatus, type CommitFiles } from './zipChanges';

export const PAGE_SIZE = 2000;
const CHUNK_ROWS = 500;
const CACHE_CAPACITY = 20;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Opening a repository is its busiest minute; the maintenance waits it out. */
export const MAINTENANCE_DELAY_MS = 60_000;
/** A git operation is running: the maintenance looks again this much later. */
export const MAINTENANCE_RETRY_MS = 15_000;

export interface LogRow extends Commit {
  /** '<' | '>' side marker in range mode. */
  side?: 'left' | 'right';
}

export interface LogPageResult {
  rows: LogRow[];
  /** True when git returned fewer rows than requested (history exhausted). */
  eof: boolean;
  page: number;
}

export interface CommitDetails {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  /** `%G?` — G good, B bad, U/X/Y/R unverified shades, E cannot check, N none. */
  signature: string;
  refs: string[];
  body: string;
  files: NameStatusEntry[];
}

interface MaintenanceStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export class LogService {
  private readonly pageCache = new Map<string, LogPageResult>(); // insertion-ordered LRU
  /** The maintenance waiting for its moment, or running. */
  private maintenance: Promise<void> | undefined;
  /** Ends the maintenance's current wait early (dispose). */
  private wakeMaintenance: (() => void) | undefined;
  private disposed = false;
  private authorsCache: { headSha: string | undefined; authors: string[] } | undefined;

  constructor(
    private readonly repo: RepoHandle,
    private readonly storage?: MaintenanceStorage,
    private readonly trace: (line: string) => void = () => undefined,
  ) {}

  /**
   * Keyed on the refs as well as HEAD: the rows carry their branch labels, and
   * a branch made, renamed or switched to at the same commit leaves `headSha`
   * where it was. With HEAD alone a repository the log was not showing at the
   * time came back with its old labels — `HEAD → master` on a repository now
   * on `abc`.
   */
  private cacheKey(filter: LogFilter, page: number): string {
    const model = this.repo.model;
    return `${filterKey(filter)}|${page}|${model.snapshot.headSha ?? 'unborn'}|${model.refsGeneration}`;
  }

  /**
   * Loads one page (streamed + chunk-yielded). onChunk receives incremental
   * row batches for progressive painting; the promise resolves the full page.
   */
  async getPage(
    filter: LogFilter,
    page: number,
    onChunk?: (rows: LogRow[]) => void,
  ): Promise<LogPageResult> {
    const key = this.cacheKey(filter, page);
    const cached = this.pageCache.get(key);
    if (cached) {
      // refresh LRU position
      this.pageCache.delete(key);
      this.pageCache.set(key, cached);
      onChunk?.(cached.rows);
      return cached;
    }

    const rangeMode = filter.range !== undefined;
    const format = rangeMode ? `%m%x00${LOG_FORMAT}` : LOG_FORMAT;
    const args = buildLogArgs(filter, format, { skip: page * PAGE_SIZE, maxCount: PAGE_SIZE });

    const rows: LogRow[] = [];
    let pendingChunk: LogRow[] = [];

    await this.repo.queue.enqueue({
      label: `log page ${page}`,
      kind: 'read',
      run: async (git, token) => {
        rows.length = 0; // requeued reruns start clean
        pendingChunk = [];
        const handle = git.stream(
          this.repo.root,
          args,
          (frame) => {
            const row = this.parseFrame(frame, rangeMode);
            if (row) {
              rows.push(row);
              pendingChunk.push(row);
              if (pendingChunk.length >= CHUNK_ROWS) {
                onChunk?.(pendingChunk);
                pendingChunk = [];
              }
            }
          },
          { structured: true, noOptionalLocks: true, delimiter: LOG_RECORD_SEPARATOR, token },
        );
        await handle.done;
        // stream() RESOLVES on cancellation (partial output) — a cancelled
        // read must THROW so the OperationQueue requeues it after the
        // mutation instead of caching a truncated page.
        if (token.isCancellationRequested) {
          rows.length = 0;
          pendingChunk = [];
          throw new Error('log page read cancelled');
        }
      },
    });
    if (pendingChunk.length > 0) onChunk?.(pendingChunk);

    const result: LogPageResult = { rows, eof: rows.length < PAGE_SIZE, page };
    this.pageCache.set(key, result);
    while (this.pageCache.size > CACHE_CAPACITY) {
      const oldest = this.pageCache.keys().next().value as string;
      this.pageCache.delete(oldest);
    }
    return result;
  }

  private parseFrame(frame: string, rangeMode: boolean): LogRow | undefined {
    if (!rangeMode) return parseLogRecord(frame);
    // Range mode prefixes a %m marker field: strip it, remember the side.
    const cleaned = frame.startsWith('\n') ? frame.slice(1) : frame;
    const nul = cleaned.indexOf('\0');
    if (nul === -1) return undefined;
    const marker = cleaned.slice(0, nul);
    const row = parseLogRecord(cleaned.slice(nul + 1));
    if (!row) return undefined;
    return { ...row, side: marker === '<' ? 'left' : 'right' };
  }

  invalidate(): void {
    this.pageCache.clear();
  }

  /** Branch/tag/HEAD chips per sha for the current page rows. */
  decorationsFor(rows: readonly LogRow[]): Map<string, ReturnType<typeof parseDecorations>> {
    const map = new Map<string, ReturnType<typeof parseDecorations>>();
    for (const row of rows) {
      if (row.refs.length > 0) map.set(row.sha, parseDecorations(row.refs));
    }
    return map;
  }

  /**
   * P12-T3 — the aggregate change set of a multi-commit selection, which is
   * how IntelliJ's "Compare Versions" reads: `git diff <oldest>^..<newest>`.
   * A root commit has no parent; the empty tree stands in so the aggregate
   * still means "everything these commits introduced".
   */
  /**
   * The files each of `shas` changed, in the order given — one `git log` for
   * any number of commits, the shas passed on stdin so a long selection never
   * meets the Windows command-line limit. A merge lists its changes against
   * its first parent, which is what a merge's own row shows.
   */
  async getCommitsFiles(shas: readonly string[]): Promise<CommitFiles[]> {
    if (shas.length === 0) return [];
    const result = await this.repo.queue.enqueue({
      label: `files of ${shas.length} commits`,
      kind: 'read',
      run: (git, token) =>
        git.exec(
          this.repo.root,
          [
            'log',
            '--no-walk=unsorted',
            '--stdin',
            '-m',
            '--first-parent',
            '--format=%x1e%H',
            '--name-status',
            '-z',
            '-M',
          ],
          {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            stdin: `${shas.join('\n')}\n`,
            token,
          },
        ),
    });
    if (result.exitCode !== 0) return [];
    return parseCommitsNameStatus(result.stdout, parseNameStatusZ);
  }

  /**
   * POST-P14x — the full message of one commit, and nothing else.
   *
   * `getCommitDetails` would answer this too, but it pays for a
   * `--name-status -M` diff on the way; a hover must not cost a rename
   * detection over the whole commit.
   */
  async getCommitMessage(sha: string): Promise<string | undefined> {
    const result = await this.repo.queue.enqueue({
      label: `message ${sha.slice(0, 7)}`,
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['log', '-1', '--format=%B', sha], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return undefined;
    // git pads the body with the trailing newlines its own format adds; a
    // tooltip sized to them would have a blank line under every message.
    return result.stdout.replace(/(?:\r?\n)+$/u, '');
  }

  async getCommitDetails(sha: string): Promise<CommitDetails | undefined> {
    // %G? — GPG signature state (P12-T4): G good, B bad, U/X/Y/R unverified
    // shades, E cannot check, N none. Costs nothing when gpg is absent.
    const format = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%G?%x00%D%x00%B%x1e';
    const result = await this.repo.queue.enqueue({
      label: `show ${sha.slice(0, 7)}`,
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['show', '--name-status', '-z', '-M', `--format=${format}`, sha], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return undefined;
    const sep = result.stdout.indexOf('\x1e');
    if (sep === -1) return undefined;
    const meta = result.stdout.slice(0, sep).split('\0');
    if (meta.length < 11) return undefined;
    // After \x1e git emits a NUL and a newline before the -z name-status
    // stream (measured: `…\x1e\0\nR100\0old\0new\0`).
    const filesRaw = result.stdout.slice(sep + 1).replace(/^[\0\n]+/, '');
    return {
      sha: meta[0] as string,
      parents: (meta[1] as string).length > 0 ? (meta[1] as string).split(' ') : [],
      authorName: meta[2] as string,
      authorEmail: meta[3] as string,
      authorTime: Number.parseInt(meta[4] as string, 10),
      committerName: meta[5] as string,
      committerEmail: meta[6] as string,
      committerTime: Number.parseInt(meta[7] as string, 10),
      signature: meta[8] as string,
      refs: (meta[9] as string).length > 0 ? (meta[9] as string).split(', ') : [],
      body: meta.slice(10).join('\0').replace(/\n+$/, ''),
      files: parseNameStatusZ(filesRaw),
    };
  }

  /** P12-T4 — how many times `--contains` ran (laziness acceptance seam). */
  containsCalls = 0;

  /**
   * `Contained in branches` — deliberately lazy: `git branch --contains` walks
   * history and is slow on large repos, so it runs on click, never on
   * selection (the test asserts this counter stays at zero until then).
   */
  async getContainingBranches(sha: string): Promise<string[]> {
    this.containsCalls++;
    const result = await this.repo.queue.enqueue({
      label: `branch --contains ${sha.slice(0, 7)}`,
      kind: 'read',
      run: (git, token) =>
        git.exec(
          this.repo.root,
          ['branch', '--contains', sha, '--format=%(refname:short)'],
          {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          },
        ),
    });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /** Deduped `Author <email>` list for the filter bar autocomplete. */
  async getAuthors(): Promise<string[]> {
    const headSha = this.repo.model.snapshot.headSha;
    if (this.authorsCache && this.authorsCache.headSha === headSha) {
      return this.authorsCache.authors;
    }
    const seen = new Set<string>();
    await this.repo.queue.enqueue({
      label: 'author list',
      kind: 'read',
      run: async (git, token) => {
        const handle = git.stream(
          this.repo.root,
          ['log', '--all', '--format=%aN <%aE>', '--use-mailmap'],
          (line) => {
            if (line.trim().length > 0 && seen.size < 100_000) seen.add(line.trim());
          },
          { structured: true, noOptionalLocks: true, delimiter: '\n', token },
        );
        await handle.done;
        if (token.isCancellationRequested) {
          seen.clear();
          throw new Error('author list read cancelled');
        }
      },
    });
    const authors = [...seen].sort((a, b) => a.localeCompare(b));
    this.authorsCache = { headSha, authors };
    return authors;
  }

  /**
   * The daily `commit-graph write` (capability-gated), in the background.
   *
   * It used to go on the queue's mutation lane the moment a Log session
   * started. A mutation stops every read and cancels the ones in flight, so
   * the first Log of the day — its first page, and the status, the branches,
   * the details with it — waited for a write that takes seconds on a large
   * history and a minute on a very large one, under a progress notification.
   * The write changes nothing anyone sees: refs, index and worktree are not
   * touched, and git swaps the file in whole. So it needs no lane. It waits
   * out the opening minute, steps aside while a git operation runs, and then
   * runs on its own. Resolves when it is done or has nothing to do.
   */
  maybeMaintain(
    git: GitExecutor,
    timing: { delayMs?: number; retryMs?: number } = {},
  ): Promise<void> {
    if (this.maintenance !== undefined) return this.maintenance;
    const storage = this.storage;
    if (storage === undefined || this.disposed) return Promise.resolve();
    if (this.repo.model.snapshot.capabilities?.commitGraph !== true) return Promise.resolve();
    const key = `gittree.commitGraph.${this.repo.root}`;
    const due = (): boolean =>
      Date.now() - (storage.get<number>(key) ?? 0) >= MAINTENANCE_INTERVAL_MS;
    if (!due()) return Promise.resolve();
    const run = async (): Promise<void> => {
      await this.waitFor(timing.delayMs ?? MAINTENANCE_DELAY_MS);
      while (!this.disposed && this.repo.queue.isMutationActive) {
        await this.waitFor(timing.retryMs ?? MAINTENANCE_RETRY_MS);
      }
      // Gone, or another window of this workspace did it meanwhile.
      if (this.disposed || !due()) return;
      // Stamped when it starts, not when asked: a window closed during the
      // wait leaves the day's write to the next one.
      await storage.update(key, Date.now());
      const res = await git.exec(
        this.repo.root,
        ['commit-graph', 'write', '--reachable', '--changed-paths'],
        { allowNonZeroExit: true },
      );
      if (res.exitCode !== 0) {
        this.trace(`commit-graph maintenance exited ${res.exitCode}: ${res.stderr.trim()}`);
      }
    };
    this.maintenance = run()
      .catch((err: unknown) => {
        this.trace(`commit-graph maintenance failed: ${String(err)}`);
      })
      .finally(() => {
        this.maintenance = undefined;
      });
    return this.maintenance;
  }

  private waitFor(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wakeMaintenance === done) this.wakeMaintenance = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wakeMaintenance = done;
    });
  }

  /** The repository has gone: a maintenance still waiting does not run. */
  dispose(): void {
    this.disposed = true;
    this.wakeMaintenance?.();
  }
}
