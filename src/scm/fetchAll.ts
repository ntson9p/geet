/**
 * Fetch-across-every-root orchestration, vscode-free so the fan-out rules are
 * unit-testable without a window.
 *
 * IntelliJ's Fetch is a **project** operation: the one button in the branches
 * popup header fetches every root, and there is no per-root fetch gesture at
 * all — fetch only moves `refs/remotes` and `FETCH_HEAD`, so scoping it buys
 * nothing and costs a decision. GitTree follows that, which makes three rules
 * matter here:
 *
 *   - **one slow root must not hide the others.** A failure is recorded and the
 *     fan-out continues; the caller reports once at the end rather than firing
 *     an error dialog per repository.
 *   - **the pool is bounded.** Every fetch is a spawn plus a network
 *     connection; a fifteen-root workspace should not open fifteen at once.
 *   - **cancellation stops scheduling.** Roots not yet started come back
 *     `cancelled`, so the summary can say what was actually done.
 */

/** What a fan-out entry needs: an identity to report, whatever else the caller carries. */
export interface FetchTarget {
  readonly root: string;
  /** Display name — the workspace folder name, not the whole path. */
  readonly name: string;
}

export type FetchStatus = 'ok' | 'failed' | 'cancelled';

export interface FetchOutcome {
  readonly root: string;
  readonly name: string;
  readonly status: FetchStatus;
  /** First line of the git failure, when there was one. */
  readonly message?: string;
}

export interface FetchAllOptions {
  /** Max fetches in flight (default 4, matching repository-open concurrency). */
  readonly concurrency?: number;
  /** Polled before each target starts; true stops scheduling the rest. */
  readonly isCancelled?: () => boolean;
  /** Fired as each target settles, for incremental progress reporting. */
  readonly onSettled?: (outcome: FetchOutcome, done: number, total: number) => void;
}

export const DEFAULT_FETCH_CONCURRENCY = 4;

/** The first line of an error, which is the part worth showing in a summary. */
export function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n', 1)[0]?.trim() ?? '';
}

/**
 * Runs `fetchOne` over every target with a bounded pool. Never rejects: the
 * outcome list — in input order — is the whole result.
 */
export async function runFetchAll<T extends FetchTarget>(
  targets: readonly T[],
  fetchOne: (target: T) => Promise<void>,
  options: FetchAllOptions = {},
): Promise<FetchOutcome[]> {
  const total = targets.length;
  const outcomes = new Array<FetchOutcome>(total);
  const isCancelled = options.isCancelled ?? ((): boolean => false);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const target = targets[index];
      if (target === undefined) return;
      let outcome: FetchOutcome;
      if (isCancelled()) {
        outcome = { root: target.root, name: target.name, status: 'cancelled' };
      } else {
        try {
          await fetchOne(target);
          outcome = { root: target.root, name: target.name, status: 'ok' };
        } catch (err) {
          outcome = {
            root: target.root,
            name: target.name,
            status: 'failed',
            message: firstLine(err),
          };
        }
      }
      outcomes[index] = outcome;
      done++;
      options.onSettled?.(outcome, done, total);
    }
  };

  const width = Math.max(1, Math.min(options.concurrency ?? DEFAULT_FETCH_CONCURRENCY, total));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return outcomes;
}

export interface FetchSummary {
  readonly ok: number;
  readonly cancelled: number;
  readonly failures: readonly FetchOutcome[];
  readonly total: number;
}

/** Counts for the one notification the fan-out is allowed to raise. */
export function summarizeFetch(outcomes: readonly FetchOutcome[]): FetchSummary {
  return {
    ok: outcomes.filter((o) => o.status === 'ok').length,
    cancelled: outcomes.filter((o) => o.status === 'cancelled').length,
    failures: outcomes.filter((o) => o.status === 'failed'),
    total: outcomes.length,
  };
}

/**
 * The remote-tracking branches `git fetch --prune` removed, read from its
 * output: ` - [deleted]  (none) -> origin/feature`. Older gits mark the line
 * with `x` rather than `-` — IntelliJ's `PRUNE_PATTERN` reads that form.
 */
export function parsePrunedRefs(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*[-x]\s*\[deleted\].*->\s*(\S+)\s*$/.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** One repository's pruned references, named for a several-repository report. */
export interface PrunedRefs {
  readonly name: string;
  readonly refs: readonly string[];
}

/**
 * IntelliJ's Fetch result: *Fetch successful*, and the references the fetch
 * pruned (`Pruned obsolete remote references: …`). With several repositories
 * each reference names its repository.
 */
export function fetchSuccessMessage(pruned: readonly PrunedRefs[], severalRepositories: boolean): string {
  const refs = pruned.flatMap((p) =>
    p.refs.map((ref) => (severalRepositories ? `${ref} (${p.name})` : ref)),
  );
  if (refs.length === 0) return 'Fetch successful';
  const noun = refs.length === 1 ? 'reference' : 'references';
  return `Fetch successful. Pruned obsolete remote ${noun}: ${refs.join(', ')}`;
}
