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
  /** HEAD when this blame was computed — see `headSha()`. */
  headSha: string | undefined;
  blame: FileBlame;
}

export class BlameService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repo: RepoHandle) {}

  /**
   * The other half of the cache key, beside the document version.
   *
   * `docVersion` alone cannot see git: committing the lines you just edited
   * leaves the buffer byte-for-byte identical, so the version does not move
   * and the cache would keep serving the pre-commit answer — every line still
   * reading `Uncommitted`, or, after an `--amend`, attributed to a sha that is
   * no longer reachable from HEAD and yet still offered behind the hover's
   * `Copy sha` / `Show Diff` / `Show in Log`.
   *
   * HEAD's sha is not an approximation here, it is *complete*: blame walks
   * HEAD's ancestry, and that ancestry is fully determined by HEAD's sha, so
   * no history change that leaves HEAD alone can change the answer. Content is
   * already covered by `docVersion` — a dirty buffer blames through
   * `--contents -`, and a clean file whose bytes change on disk is reloaded by
   * VS Code, which bumps the version. Staging does not enter into it: `git
   * blame` reports an uncommitted line as all-zero whether it is staged or not.
   *
   * `RepositoryModel.invalidationKey` is the §4 facility for this and is
   * deliberately NOT used — it folds in `workdirGeneration`, which bumps on
   * every worktree file event in the repository, so any save anywhere would
   * evict the blame of every file.
   */
  private headSha(): string | undefined {
    return this.repo.model.snapshot.headSha;
  }

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
    const head = this.headSha();
    const cached = this.cache.get(fsPath);
    if (cached && cached.version === docVersion && cached.headSha === head) return cached.blame;

    const rel = repoRelative(this.repo.root, fsPath);
    if (rel === undefined) return undefined;

    const runs: BlameRun[] = [];
    const args = ['blame', '--incremental'];
    if (isDirty) args.push('--contents', '-');
    // The file's own name, not a pathspec: blame reads `[id].tsx` literally,
    // and would take a `:(literal)` prefix for part of the name (POST-P14ck).
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
    // Only cache a result that provably did not straddle a HEAD move. Reads
    // are cancelled and requeued when a mutation lands, so a blame started
    // before a commit can finish after it — and the head watcher's
    // `invalidate()` will already have run by then. Writing the entry anyway
    // is a write-after-invalidate: stamped with the newer sha it would serve
    // data that predates it, and stamped with the older one it could never
    // match again and nothing would ever recompute it, so every reader would
    // answer `undefined` for good. Hand this result to the caller — the
    // watcher has a re-blame scheduled — and leave the cache empty.
    if (this.headSha() !== head) return blame;
    this.cache.set(fsPath, { version: docVersion, headSha: head, blame });
    if (this.cache.size > 50) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return blame;
  }

  /**
   * The line's commit as last computed — read by the hover, the status bar and
   * `cursorCommit`, none of which recompute. It answers `undefined` rather
   * than a line from a superseded HEAD: those three surfaces put the sha
   * behind `Copy sha`, `Show Diff` and `Show in Log`, and after an `--amend`
   * the cached sha is not reachable from HEAD at all. Silence is recoverable;
   * a wrong sha presented as fact is not.
   */
  getCommitForLine(fsPath: string, line: number): LineBlame | undefined {
    const cached = this.cache.get(fsPath);
    if (!cached || cached.headSha !== this.headSha()) return undefined;
    return cached.blame.lines[line];
  }
}
