/**
 * Worktrees pane bridge (POST-P14k): builds the worktree snapshot the Git tool
 * window's third tab renders, and dispatches its actions through the existing
 * `geet.worktree.*` commands — the same handlers the tree view runs, so the
 * confirmation modals, the lock-reason prompt and the error reporting are one
 * implementation rather than two.
 *
 * JetBrains puts this list in the Git tool window ("Alt+9, then select
 * Worktrees"), not under the Commit window, which is why it moved here.
 */
import type { Core, RepoHandle } from '../core/core';
import type { WorktreeInfo } from '../core/git/parsers/worktreeList';
import { canonicalKey } from '../core/repoDiscovery';
import type { LogWorktreeActionParamsDto, LogWorktreesDto } from '../shared/protocol';

/** The slice of P13-T6's registry this pane needs; fetched live, never cached. */
interface WorktreeRegistryShape {
  provider: { refresh: () => void };
  serviceFor: (repo: RepoHandle) => { list: () => Promise<WorktreeInfo[]> };
}

/** Command id per action — `refresh` is handled here, it runs no git. */
const COMMAND_OF: Record<Exclude<LogWorktreeActionParamsDto['action'], 'refresh'>, string> = {
  add: 'geet.worktree.add',
  open: 'geet.worktree.open',
  remove: 'geet.worktree.remove',
  lock: 'geet.worktree.lock',
  unlock: 'geet.worktree.unlock',
  prune: 'geet.worktree.prune',
};

export class WorktreesPaneBridge {
  constructor(
    private readonly core: Core,
    /** Injected so the host's `vscode` import stays out of this module's tests. */
    private readonly execCommand: (command: string, ...args: unknown[]) => Thenable<unknown>,
  ) {}

  private registry(): WorktreeRegistryShape | undefined {
    return this.core.debugRegistry.get('worktrees') as WorktreeRegistryShape | undefined;
  }

  /**
   * Every repository at once. The tree view did the same: a worktree belongs to
   * a repository, and a workspace with two checkouts has two lists that are
   * only meaningful side by side.
   */
  async buildState(): Promise<LogWorktreesDto> {
    const registry = this.registry();
    if (!registry) return { repos: [] };
    const repos: LogWorktreesDto['repos'] = [];
    for (const repo of this.core.repos) {
      let list: WorktreeInfo[];
      try {
        list = await registry.serviceFor(repo).list();
      } catch {
        // A repository that cannot be listed (mid-clone, permissions) must not
        // take the whole pane down with it — it contributes an empty group.
        list = [];
      }
      repos.push({
        root: repo.root,
        label: repo.root.split(/[\\/]/u).pop() ?? repo.root,
        worktrees: list.map((info) => toDto(info)),
      });
    }
    return { repos };
  }

  /**
   * Row and toolbar actions. The webview names a repository and a path; both
   * are resolved against live state here, so a row clicked after the list moved
   * underneath it is simply dropped rather than acting on the wrong worktree.
   */
  async dispatch(params: LogWorktreeActionParamsDto): Promise<void> {
    if (params.action === 'refresh') {
      this.registry()?.provider.refresh();
      return;
    }
    const repo = this.repoOf(params.repoRoot);
    if (!repo) return;
    const command = COMMAND_OF[params.action];
    if (params.action === 'add' || params.action === 'prune') {
      // `add` takes (branchOrNode, repoRoot); a bare `undefined` seeds from HEAD.
      await this.execCommand(command, undefined, repo.root);
      return;
    }
    const info = await this.infoOf(repo, params.path);
    if (!info) return;
    // The command handlers read `{repo, info}` — the tree's own node shape.
    await this.execCommand(command, { kind: 'worktree', repo, info });
  }

  private repoOf(repoRoot: string | undefined): RepoHandle | undefined {
    if (repoRoot === undefined) return this.core.repos[0];
    const key = canonicalKey(repoRoot);
    return this.core.repos.find((r) => canonicalKey(r.root) === key);
  }

  private async infoOf(repo: RepoHandle, path: string | undefined): Promise<WorktreeInfo | undefined> {
    if (path === undefined) return undefined;
    const registry = this.registry();
    if (!registry) return undefined;
    const key = canonicalKey(path);
    return (await registry.serviceFor(repo).list()).find((w) => canonicalKey(w.path) === key);
  }
}

function toDto(info: WorktreeInfo): LogWorktreesDto['repos'][number]['worktrees'][number] {
  return {
    path: info.path,
    ...(info.branch !== undefined ? { branch: info.branch } : {}),
    ...(info.head !== undefined ? { head: info.head } : {}),
    isMain: info.isMain,
    bare: info.bare,
    locked: info.locked,
    ...(info.lockReason !== undefined ? { lockReason: info.lockReason } : {}),
    prunable: info.prunable,
    ...(info.prunableReason !== undefined ? { prunableReason: info.prunableReason } : {}),
  };
}
