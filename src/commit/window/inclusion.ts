/**
 * Per-change inclusion (P11-T3): which individual changes inside a file take
 * part in the next commit — IntelliJ's per-hunk checkbox in the commit diff
 * (gap analysis S11).
 *
 * Shape: `Map<repoKey, Map<relPath, ChangeSelection>>`. An **absent entry means
 * the whole file**, so the common case costs nothing and every existing commit
 * path keeps working untouched.
 *
 * Staleness is the whole difficulty. A selection is a set of *indices* into a
 * `LineChange[]`, and that list is recomputed from HEAD and the worktree every
 * time it is needed — a reformat check, an external edit or the user's own
 * typing can renumber it under us. So each selection also stores a signature of
 * the change list it was made against; when the signature no longer matches,
 * `resolve` answers `undefined` (= commit the whole file) instead of applying
 * indices that now point at different lines. Silently committing the wrong hunk
 * is the one outcome this model exists to prevent.
 *
 * Session-scoped and in-memory on purpose: a stored selection that outlives the
 * extension host would be a stale selection nine times out of ten, and the
 * fallback above would discard it anyway.
 *
 * vscode-free so the staleness rules are unit-tested rather than clicked.
 */
import type { LineChange } from '../../core/patch/patchBuilder';

export interface ChangeSelection {
  /** Signature of the change list this selection was made against. */
  readonly signature: string;
  /** Indices into that list, ascending and deduped. */
  readonly included: readonly number[];
  /** Size of that list — the `N` in `M of N changes`. */
  readonly total: number;
}

/**
 * Identity of a change list: every change's four coordinates, in order. Two
 * lists with the same signature index the same changes, which is exactly the
 * guarantee `resolve` needs. Content is deliberately not hashed — editing text
 * *inside* a hunk without moving any line boundary leaves the selection
 * meaningful, and the patch is rebuilt from current content anyway.
 */
export function signChanges(changes: readonly LineChange[]): string {
  return changes
    .map(
      (c) =>
        `${c.originalStartLineNumber},${c.originalEndLineNumber},` +
        `${c.modifiedStartLineNumber},${c.modifiedEndLineNumber}`,
    )
    .join(';');
}

function normalize(indices: readonly number[], total: number): number[] {
  return [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < total).sort((a, b) => a - b);
}

export class InclusionModel {
  private readonly repos = new Map<string, Map<string, ChangeSelection>>();

  /** `repoKey` must already be canonical (`canonicalKey(repo.root)`). */
  get(repoKey: string, relPath: string): ChangeSelection | undefined {
    return this.repos.get(repoKey)?.get(relPath);
  }

  /**
   * Records which changes are included. A selection covering everything is
   * stored as *no* selection — "all of it" and "the whole file" must not be two
   * different states, or the commit path would have two ways to say the same
   * thing and only one of them tested.
   */
  set(repoKey: string, relPath: string, changes: readonly LineChange[], included: readonly number[]): void {
    const total = changes.length;
    const list = normalize(included, total);
    if (total === 0 || list.length === total) {
      this.clear(repoKey, relPath);
      return;
    }
    let byPath = this.repos.get(repoKey);
    if (!byPath) {
      byPath = new Map();
      this.repos.set(repoKey, byPath);
    }
    byPath.set(relPath, { signature: signChanges(changes), included: list, total });
  }

  clear(repoKey: string, relPath: string): void {
    const byPath = this.repos.get(repoKey);
    if (!byPath?.delete(relPath)) return;
    if (byPath.size === 0) this.repos.delete(repoKey);
  }

  clearRepo(repoKey: string): void {
    this.repos.delete(repoKey);
  }

  /**
   * Drops selections for files that are no longer pending — status moved on.
   * Answers whether anything went, so the caller can skip a needless re-render.
   */
  prune(repoKey: string, live: Iterable<string>): boolean {
    const byPath = this.repos.get(repoKey);
    if (!byPath) return false;
    const keep = new Set(live);
    let changed = false;
    for (const relPath of [...byPath.keys()]) {
      if (!keep.has(relPath)) {
        byPath.delete(relPath);
        changed = true;
      }
    }
    if (byPath.size === 0) this.repos.delete(repoKey);
    return changed;
  }

  /** Every live selection in a repo — the source of the `M of N changes` badges. */
  entries(repoKey: string): Array<[string, ChangeSelection]> {
    const byPath = this.repos.get(repoKey);
    return byPath ? [...byPath] : [];
  }

  /** Selections held for a repo, without materialising them. */
  count(repoKey: string): number {
    return this.repos.get(repoKey)?.size ?? 0;
  }

  /**
   * Indices to commit, or `undefined` for "the whole file" — which is also the
   * answer for a selection that no longer matches `changes`. Callers must treat
   * `undefined` as whole-file and never as "nothing".
   */
  resolve(repoKey: string, relPath: string, changes: readonly LineChange[]): number[] | undefined {
    const selection = this.get(repoKey, relPath);
    if (!selection) return undefined;
    if (selection.signature !== signChanges(changes)) return undefined;
    return [...selection.included];
  }

  /** A selection exists but the file's changes have been renumbered under it. */
  isStale(repoKey: string, relPath: string, changes: readonly LineChange[]): boolean {
    const selection = this.get(repoKey, relPath);
    return selection !== undefined && selection.signature !== signChanges(changes);
  }

  dispose(): void {
    this.repos.clear();
  }
}
