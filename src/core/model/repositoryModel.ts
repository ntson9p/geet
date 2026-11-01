/**
 * RepositoryModel (master §4): one observable immutable snapshot per repo.
 * All views subscribe to onDidChange(sections); none run git directly.
 * `update()` produces the next snapshot, diffs it against the previous one and
 * fires only the sections whose content actually changed.
 */
import type { GitCapabilities } from '../git/capabilities';
import type { RepoId } from '../git/executor';
import type { StashInfo } from '../git/parsers/stashList';
import { Emitter, type Event } from '../util/events';
import type { InProgressOp } from './inProgressOp';
import { refEquals, type RefInfo } from './refs';
import { statusEntryEquals, type StatusEntry } from './statusEntry';

export type ModelSection = 'head' | 'status' | 'refs' | 'stashes' | 'op' | 'caps';

export interface RepoSnapshot {
  /** Current branch short name; undefined when detached or unborn-without-name. */
  readonly headRef?: string;
  /** HEAD commit sha; undefined on an unborn branch. */
  readonly headSha?: string;
  readonly detached: boolean;
  /** Unborn branch (no commits yet). */
  readonly initial: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly upstreamGone: boolean;
  readonly refs: readonly RefInfo[];
  readonly statusEntries: readonly StatusEntry[];
  readonly inProgressOp?: InProgressOp;
  readonly stashes: readonly StashInfo[];
  /** Unix ms of the last completed fetch (ours or detected external). */
  readonly lastFetchAt?: number;
  readonly capabilities?: GitCapabilities;
}

export const EMPTY_SNAPSHOT: RepoSnapshot = Object.freeze({
  detached: false,
  initial: false,
  upstreamGone: false,
  refs: [],
  statusEntries: [],
  stashes: [],
});

export class RepositoryModel {
  private _snapshot: RepoSnapshot = EMPTY_SNAPSHOT;
  private _workdirGeneration = 0;
  private _refsGeneration = 0;
  private readonly _onDidChange = new Emitter<ReadonlySet<ModelSection>>();
  readonly onDidChange: Event<ReadonlySet<ModelSection>> = this._onDidChange.event;

  constructor(readonly repoId: RepoId) {}

  get snapshot(): RepoSnapshot {
    return this._snapshot;
  }

  /** Monotonic counter bumped on worktree file events; cache invalidation key part. */
  get workdirGeneration(): number {
    return this._workdirGeneration;
  }

  bumpWorkdirGeneration(): void {
    this._workdirGeneration++;
  }

  /**
   * Monotonic counter bumped whenever a ref or HEAD changes — a branch made,
   * renamed or switched to at the same commit, a fetch moving `origin/*`.
   * Caches whose content shows refs key on it: `headSha` alone does not move
   * for any of those.
   */
  get refsGeneration(): number {
    return this._refsGeneration;
  }

  /** `(HEAD sha, workdir generation)` invalidation key (master §4 caches). */
  get invalidationKey(): string {
    return `${this._snapshot.headSha ?? 'unborn'}:${this._workdirGeneration}`;
  }

  /**
   * Applies a partial snapshot, fires changed sections. Returns the set of
   * sections that actually changed (empty set → no event fired).
   */
  update(partial: Partial<RepoSnapshot>): ReadonlySet<ModelSection> {
    const prev = this._snapshot;
    const next: RepoSnapshot = Object.freeze({ ...prev, ...partial });
    const changed = diffSections(prev, next);
    if (changed.size > 0) {
      this._snapshot = next;
      if (changed.has('refs') || changed.has('head')) this._refsGeneration++;
      this._onDidChange.fire(changed);
    }
    return changed;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function diffSections(a: RepoSnapshot, b: RepoSnapshot): Set<ModelSection> {
  const changed = new Set<ModelSection>();
  if (
    a.headRef !== b.headRef ||
    a.headSha !== b.headSha ||
    a.detached !== b.detached ||
    a.initial !== b.initial ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.upstreamGone !== b.upstreamGone ||
    a.lastFetchAt !== b.lastFetchAt
  ) {
    changed.add('head');
  }
  if (!arrayEquals(a.statusEntries, b.statusEntries, statusEntryEquals)) changed.add('status');
  if (!arrayEquals(a.refs, b.refs, refEquals)) changed.add('refs');
  if (!arrayEquals(a.stashes, b.stashes, stashEquals)) changed.add('stashes');
  if (!opEquals(a.inProgressOp, b.inProgressOp)) changed.add('op');
  if (a.capabilities !== b.capabilities) changed.add('caps');
  return changed;
}

function arrayEquals<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean,
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i] as T, b[i] as T)) return false;
  }
  return true;
}

function stashEquals(a: StashInfo, b: StashInfo): boolean {
  return a.selector === b.selector && a.sha === b.sha && a.message === b.message;
}

function opEquals(a: InProgressOp | undefined, b: InProgressOp | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.step === b.step &&
    a.total === b.total &&
    a.headName === b.headName &&
    a.todoRemaining === b.todoRemaining
  );
}
