/**
 * LogService (P4-T1): streaming pager over the P0-T3 log format with an
 * LRU page cache, ref-decoration chips, commit details, author autocomplete
 * and commit-graph maintenance. vscode-free (executor/queue injected) apart
 * from Uri-free DTOs so vitest can drive it.
 */
import type { RepoHandle } from '../core/core';
import { parseNameStatusZ, type NameStatusEntry } from '../branches/parsing';
import {
  LOG_FORMAT,
  LOG_RECORD_SEPARATOR,
  parseDecorations,
  parseLogRecord,
  type Commit,
} from '../core/git/parsers/logFormat';
import { buildLogArgs, filterKey, type LogFilter } from './logFilter';

export const PAGE_SIZE = 2000;
const CHUNK_ROWS = 500;
const CACHE_CAPACITY = 20;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  private authorsCache: { headSha: string | undefined; authors: string[] } | undefined;

  constructor(
    private readonly repo: RepoHandle,
    private readonly storage?: MaintenanceStorage,
    private readonly trace: (line: string) => void = () => undefined,
  ) {}

  private cacheKey(filter: LogFilter, page: number): string {
    return `${filterKey(filter)}|${page}|${this.repo.model.snapshot.headSha ?? 'unborn'}`;
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
      run: (git, token) => {
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
        return handle.done;
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

  async getCommitDetails(sha: string): Promise<CommitDetails | undefined> {
    const format = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%D%x00%B%x1e';
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
    if (meta.length < 10) return undefined;
    // After \x1e git emits a newline then the -z name-status stream.
    const filesRaw = result.stdout.slice(sep + 1).replace(/^\n+/, '');
    return {
      sha: meta[0] as string,
      parents: (meta[1] as string).length > 0 ? (meta[1] as string).split(' ') : [],
      authorName: meta[2] as string,
      authorEmail: meta[3] as string,
      authorTime: Number.parseInt(meta[4] as string, 10),
      committerName: meta[5] as string,
      committerEmail: meta[6] as string,
      committerTime: Number.parseInt(meta[7] as string, 10),
      refs: (meta[8] as string).length > 0 ? (meta[8] as string).split(', ') : [],
      body: meta.slice(9).join('\0').replace(/\n+$/, ''),
      files: parseNameStatusZ(filesRaw),
    };
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
      run: (git, token) => {
        const handle = git.stream(
          this.repo.root,
          ['log', '--all', '--format=%aN <%aE>', '--use-mailmap'],
          (line) => {
            if (line.trim().length > 0 && seen.size < 100_000) seen.add(line.trim());
          },
          { structured: true, noOptionalLocks: true, delimiter: '\n', token },
        );
        return handle.done;
      },
    });
    const authors = [...seen].sort((a, b) => a.localeCompare(b));
    this.authorsCache = { headSha, authors };
    return authors;
  }

  /** Throttled `commit-graph write` maintenance (capability-gated, daily). */
  async maybeMaintain(): Promise<void> {
    if (!this.repo.queue || this.storage === undefined) return;
    const capsOk = this.repo.model.snapshot.capabilities?.commitGraph === true;
    if (!capsOk) return;
    const key = `gittree.commitGraph.${this.repo.root}`;
    const last = this.storage.get<number>(key) ?? 0;
    if (Date.now() - last < MAINTENANCE_INTERVAL_MS) return;
    await this.storage.update(key, Date.now());
    try {
      await this.repo.queue.enqueue({
        label: 'commit-graph maintenance',
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(
            this.repo.root,
            ['commit-graph', 'write', '--reachable', '--changed-paths'],
            { token, allowNonZeroExit: true },
          );
        },
      });
    } catch (err) {
      this.trace(`commit-graph maintenance failed: ${String(err)}`);
    }
  }
}
