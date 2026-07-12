/**
 * BlameService (P4-T6): per-line blame with dirty-buffer support. Dirty
 * documents blame via `git blame --incremental --contents -` (buffer piped
 * to stdin) so annotations are correct without saving; clean docs use the
 * plain path invocation. Results cached by (uri, docVersion).
 */
import type { RepoHandle } from '../../core/core';
import { createBlameIncrementalParser, type BlameRun } from '../../core/git/parsers/blameIncremental';
import { repoRelative } from '../../core/util/paths';

export interface LineBlame {
  sha: string;
  author: string;
  /** Unix seconds; 0 for uncommitted lines. */
  authorTime: number;
  summary: string;
  isUncommitted: boolean;
}

export interface FileBlame {
  /** Index = 0-based line number. */
  lines: LineBlame[];
  /** Distinct commit times (for heat-map bucketing). */
  times: number[];
}

const ZERO_SHA = /^0+$/;

export function assembleFileBlame(runs: readonly BlameRun[], lineCount: number): FileBlame {
  const lines: LineBlame[] = new Array<LineBlame>(lineCount);
  const times = new Set<number>();
  for (const run of runs) {
    const uncommitted = ZERO_SHA.test(run.sha);
    const entry: LineBlame = {
      sha: run.sha,
      author: uncommitted ? 'Uncommitted' : run.author,
      authorTime: uncommitted ? 0 : run.authorTime,
      summary: uncommitted ? 'Uncommitted changes' : run.summary,
      isUncommitted: uncommitted,
    };
    if (!uncommitted) times.add(run.authorTime);
    for (let i = 0; i < run.count; i++) {
      const line = run.finalLine - 1 + i;
      if (line >= 0 && line < lineCount) lines[line] = entry;
    }
  }
  // Fill any holes (shouldn't happen, but stay total).
  for (let i = 0; i < lineCount; i++) {
    lines[i] ??= { sha: '0'.repeat(40), author: 'Uncommitted', authorTime: 0, summary: '', isUncommitted: true };
  }
  return { lines, times: [...times].sort((a, b) => a - b) };
}

interface CacheEntry {
  version: number;
  blame: FileBlame;
}

export class BlameService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repo: RepoHandle) {}

  invalidate(fsPath?: string): void {
    if (fsPath === undefined) this.cache.clear();
    else this.cache.delete(fsPath);
  }

  /**
   * @param content   current document text (used when dirty)
   * @param isDirty   blame the buffer via --contents - instead of the file
   * @param docVersion cache key component
   */
  async blameFile(
    fsPath: string,
    content: string,
    isDirty: boolean,
    docVersion: number,
    lineCount: number,
  ): Promise<FileBlame | undefined> {
    const cached = this.cache.get(fsPath);
    if (cached && cached.version === docVersion) return cached.blame;

    const rel = repoRelative(this.repo.root, fsPath);
    if (rel === undefined) return undefined;

    const runs: BlameRun[] = [];
    const args = ['blame', '--incremental'];
    if (isDirty) args.push('--contents', '-');
    args.push('--', rel);

    try {
      await this.repo.queue.enqueue({
        label: `blame ${rel}`,
        kind: 'read',
        run: async (git, token) => {
          runs.length = 0; // requeued reruns start clean
          const parser = createBlameIncrementalParser();
          const handle = git.stream(
            this.repo.root,
            args,
            (line) => {
              const run = parser.feedLine(line);
              if (run) runs.push(run);
            },
            {
              structured: true,
              noOptionalLocks: true,
              delimiter: '\n',
              token,
              ...(isDirty ? { stdin: content } : {}),
            },
          );
          await handle.done;
          // Cancelled reads must throw so the queue requeues them — a
          // resolved-but-truncated blame would be cached as authoritative.
          if (token.isCancellationRequested) {
            runs.length = 0;
            throw new Error('blame read cancelled');
          }
        },
      });
    } catch {
      return undefined; // untracked file, blame failure — no annotations
    }
    if (runs.length === 0) return undefined;

    const blame = assembleFileBlame(runs, lineCount);
    this.cache.set(fsPath, { version: docVersion, blame });
    if (this.cache.size > 50) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return blame;
  }

  getCommitForLine(fsPath: string, line: number): LineBlame | undefined {
    return this.cache.get(fsPath)?.blame.lines[line];
  }
}
