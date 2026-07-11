/**
 * RefService (P2-T1): branch metadata on top of the RepositoryModel — recent
 * branches scored from the reflog (frequency × recency decay), favorites
 * persisted per repo-identity (remote-URL hash so favorites survive
 * re-clones). vscode-free: storage is injected.
 */
import * as crypto from 'node:crypto';
import type { RepoHandle } from '../core/core';
import { parseCheckoutEvents, REFLOG_FORMAT, type CheckoutEvent } from '../core/git/parsers/reflog';
import type { RefInfo } from '../core/model/refs';
import { Emitter, type Event } from '../core/util/events';

export interface FavoritesStorage {
  get(key: string): readonly string[] | undefined;
  update(key: string, value: readonly string[]): Promise<void> | void;
}

export const DEFAULT_RECENT_HALF_LIFE_DAYS = 14;

/**
 * Frequency × recency score: each checkout of a branch contributes
 * 0.5^(age / halfLife). Deleted/renamed branches are filtered by the caller
 * passing the set of existing local branches.
 */
export function scoreRecentBranches(
  events: readonly CheckoutEvent[],
  existingBranches: ReadonlySet<string>,
  options: { now?: number; halfLifeDays?: number; exclude?: string } = {},
): string[] {
  const now = options.now ?? Date.now() / 1000;
  const halfLifeSeconds = (options.halfLifeDays ?? DEFAULT_RECENT_HALF_LIFE_DAYS) * 24 * 60 * 60;
  const scores = new Map<string, number>();
  for (const e of events) {
    // Both sides of a checkout are "recently used".
    for (const branch of [e.to, e.from]) {
      if (!existingBranches.has(branch)) continue;
      if (branch === options.exclude) continue;
      const age = Math.max(0, now - e.time);
      const weight = Math.pow(0.5, age / halfLifeSeconds) * (branch === e.to ? 1 : 0.5);
      scores.set(branch, (scores.get(branch) ?? 0) + weight);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

export class RefService {
  private readonly _onDidChangeFavorites = new Emitter<void>();
  readonly onDidChangeFavorites: Event<void> = this._onDidChangeFavorites.event;
  private favoritesKeyCache: string | undefined;

  constructor(
    private readonly repo: RepoHandle,
    private readonly storage: FavoritesStorage,
    private readonly recentCount: () => number,
  ) {}

  get localBranches(): RefInfo[] {
    return this.repo.model.snapshot.refs.filter((r) => r.type === 'head');
  }

  get remoteBranches(): RefInfo[] {
    return this.repo.model.snapshot.refs.filter(
      (r) => r.type === 'remote' && r.symrefTarget === undefined,
    );
  }

  get tags(): RefInfo[] {
    return this.repo.model.snapshot.refs.filter((r) => r.type === 'tag');
  }

  get currentBranch(): RefInfo | undefined {
    return this.repo.model.snapshot.refs.find((r) => r.type === 'head' && r.isHead);
  }

  /** Reflog-derived recent branch names (excluding current), best first. */
  async getRecentBranches(): Promise<string[]> {
    const result = await this.repo.queue.enqueue({
      label: 'read reflog',
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['reflog', `--format=${REFLOG_FORMAT}`, '-n', '2000'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (result.exitCode !== 0) return [];
    const events = parseCheckoutEvents(result.stdout);
    const existing = new Set(this.localBranches.map((b) => b.name));
    const scored = scoreRecentBranches(events, existing, {
      exclude: this.currentBranch?.name,
    });
    return scored.slice(0, this.recentCount());
  }

  // ---- Favorites -----------------------------------------------------------

  /** Stable per-repo identity: first remote URL hashed, else the root path. */
  private async favoritesKey(): Promise<string> {
    if (this.favoritesKeyCache) return this.favoritesKeyCache;
    const result = await this.repo.queue.enqueue({
      label: 'read remote url',
      kind: 'read',
      run: (git, token) =>
        git.exec(this.repo.root, ['config', '--get', 'remote.origin.url'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    const identity = result.exitCode === 0 && result.stdout.trim().length > 0
      ? result.stdout.trim()
      : this.repo.root;
    this.favoritesKeyCache = `gittree.favorites.${crypto
      .createHash('sha256')
      .update(identity)
      .digest('hex')
      .slice(0, 16)}`;
    return this.favoritesKeyCache;
  }

  async getFavorites(): Promise<Set<string>> {
    const key = await this.favoritesKey();
    return new Set(this.storage.get(key) ?? []);
  }

  async toggleFavorite(branch: string): Promise<boolean> {
    const key = await this.favoritesKey();
    const favorites = new Set(this.storage.get(key) ?? []);
    let nowFavorite: boolean;
    if (favorites.has(branch)) {
      favorites.delete(branch);
      nowFavorite = false;
    } else {
      favorites.add(branch);
      nowFavorite = true;
    }
    await this.storage.update(key, [...favorites]);
    this._onDidChangeFavorites.fire();
    return nowFavorite;
  }

  dispose(): void {
    this._onDidChangeFavorites.dispose();
  }
}
