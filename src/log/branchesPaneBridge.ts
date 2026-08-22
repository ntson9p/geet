/**
 * Branches pane bridge (P12-T2): builds the ref snapshot the pane renders and
 * dispatches its rail/context actions through the shared `branchActions.ts`
 * registry — the same code paths the branches tree runs, and the same list
 * the P13-T5 popup will consume, so the surfaces cannot drift.
 */
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import {
  createBranchActions,
  findBranchAction,
  type BranchAction,
  type BranchActionContext,
} from '../branches/branchActions';
import type { BranchOps } from '../branches/branchOps';
import type { RefService } from '../branches/refService';
import type { LogBranchActionParamsDto, LogBranchesDto } from '../shared/protocol';

interface Phase02Shape {
  refServices: Map<string, RefService>;
  ops: BranchOps;
}

export class BranchesPaneBridge {
  private actionsCache: BranchAction[] | undefined;
  /** user.email per repo — read once, not on every refs push. */
  private readonly myAuthorCache = new Map<string, string | undefined>();
  private readonly myNameCache = new Map<string, string | undefined>();

  constructor(private readonly core: Core) {}

  private phase02(): Phase02Shape | undefined {
    return this.core.debugRegistry.get('phase02') as Phase02Shape | undefined;
  }

  refServiceFor(repo: RepoHandle): RefService | undefined {
    return this.phase02()?.refServices.get(canonicalKey(repo.root));
  }

  /** The registry, shared with the tree and (P13-T5) the popup. */
  actions(): BranchAction[] {
    if (!this.actionsCache) {
      const p2 = this.phase02();
      if (!p2) return [];
      this.actionsCache = createBranchActions({
        ops: p2.ops,
        refServiceFor: (repo) => {
          const service = this.refServiceFor(repo);
          if (!service) throw new Error(`no RefService for ${repo.root}`);
          return service;
        },
      });
    }
    return this.actionsCache;
  }

  async buildBranches(repo: RepoHandle): Promise<LogBranchesDto> {
    const service = this.refServiceFor(repo);
    if (!service) return { detached: false, locals: [], remotes: [], tags: [] };
    const favorites = await service.getFavorites();
    const current = service.currentBranch;
    const remoteGroups = new Map<string, string[]>();
    for (const ref of service.remoteBranches) {
      const remote = ref.remote ?? ref.name.split('/', 1)[0] ?? '';
      const list = remoteGroups.get(remote) ?? [];
      list.push(ref.name);
      remoteGroups.set(remote, list);
    }
    const cacheKey = canonicalKey(repo.root);
    let myAuthor = this.myAuthorCache.get(cacheKey);
    if (!this.myAuthorCache.has(cacheKey)) {
      const me = await repo.queue.enqueue({
        label: 'read user.email',
        kind: 'read',
        run: (git, token) =>
          git.exec(repo.root, ['config', '--get', 'user.email'], {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          }),
      });
      myAuthor = me.exitCode === 0 && me.stdout.trim().length > 0 ? me.stdout.trim() : undefined;
      this.myAuthorCache.set(cacheKey, myAuthor);
    }
    let myName = this.myNameCache.get(cacheKey);
    if (!this.myNameCache.has(cacheKey)) {
      const name = await repo.queue.enqueue({
        label: 'read user.name',
        kind: 'read',
        run: (git, token) =>
          git.exec(repo.root, ['config', '--get', 'user.name'], {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          }),
      });
      myName = name.exitCode === 0 && name.stdout.trim().length > 0 ? name.stdout.trim() : undefined;
      this.myNameCache.set(cacheKey, myName);
    }
    return {
      ...(current !== undefined ? { current: current.name } : {}),
      detached: current === undefined,
      locals: service.localBranches.map((b) => ({
        name: b.name,
        favorite: favorites.has(b.name),
      })),
      remotes: [...remoteGroups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([remote, branches]) => ({ remote, branches: branches.sort() })),
      tags: service.tags.map((t) => t.name),
      ...(myAuthor !== undefined ? { myAuthor } : {}),
      ...(myName !== undefined ? { myName } : {}),
    };
  }

  /** Rail + context-menu dispatch; `new` is the rail's `+` (branch from HEAD). */
  async dispatch(repo: RepoHandle, params: LogBranchActionParamsDto): Promise<void> {
    if (params.action === 'new') {
      await this.phase02()?.ops.newBranchFrom(repo, 'HEAD');
      return;
    }
    if (params.name === undefined) return;
    const action = findBranchAction(this.actions(), params.action);
    if (!action) throw new Error(`unknown branch action: ${params.action}`);
    const service = this.refServiceFor(repo);
    const ctx: BranchActionContext = {
      repo,
      name: params.name,
      type: params.type ?? 'local',
      isCurrent: service?.currentBranch?.name === params.name,
    };
    // `applies()` is for menu ENUMERATION (which items surfaces render).
    // Dispatch runs the action regardless: the menu was built from fresher
    // data than this snapshot may be (a checkout can outrun the refresher),
    // and a truly invalid action gets git's own clear error instead of a
    // silent second-guess.
    await action.run(ctx);
  }
}
