/**
 * POST-P14k — the Worktrees tab's host bridge. The pane names a repository and
 * a path; everything else is resolved here, against live state, and dispatched
 * to the same `gittree.worktree.*` commands the tree view ran.
 */
import { describe, expect, it } from 'vitest';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { WorktreeInfo } from '../../../src/core/git/parsers/worktreeList';
import { WorktreesPaneBridge } from '../../../src/log/worktreesPaneBridge';

function wt(over: Partial<WorktreeInfo> & { path: string }): WorktreeInfo {
  return {
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: false,
    ...over,
  };
}

interface Harness {
  bridge: WorktreesPaneBridge;
  calls: Array<{ command: string; args: unknown[] }>;
}

function harness(
  repos: Array<{ root: string; worktrees: WorktreeInfo[] | (() => Promise<WorktreeInfo[]>) }>,
  opts: { registry?: boolean } = {},
): Harness {
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const handles = repos.map((r) => ({ root: r.root }) as unknown as RepoHandle);
  const debugRegistry = new Map<string, unknown>();
  if (opts.registry !== false) {
    debugRegistry.set('worktrees', {
      provider: { refresh: () => calls.push({ command: 'provider.refresh', args: [] }) },
      serviceFor: (repo: RepoHandle) => ({
        list: async () => {
          const found = repos.find((r) => r.root === repo.root);
          if (!found) return [];
          return typeof found.worktrees === 'function' ? found.worktrees() : found.worktrees;
        },
      }),
    });
  }
  const core = { repos: handles, debugRegistry } as unknown as Core;
  const bridge = new WorktreesPaneBridge(core, (command, ...args) => {
    calls.push({ command, args });
    return Promise.resolve(undefined);
  });
  return { bridge, calls };
}

describe('WorktreesPaneBridge.buildState', () => {
  it('groups worktrees per repository, in core.repos order', async () => {
    const { bridge } = harness([
      { root: '/a', worktrees: [wt({ path: '/a', branch: 'main', isMain: true })] },
      { root: '/b', worktrees: [wt({ path: '/b', branch: 'dev', isMain: true })] },
    ]);
    const state = await bridge.buildState();
    expect(state.repos.map((r) => r.root)).toEqual(['/a', '/b']);
    expect(state.repos[0]?.label).toBe('a');
    expect(state.repos[0]?.worktrees[0]).toMatchObject({ path: '/a', branch: 'main', isMain: true });
  });

  it('carries the lock and prune reasons the pane shows as labels', async () => {
    const { bridge } = harness([
      {
        root: '/a',
        worktrees: [
          wt({ path: '/a', isMain: true, branch: 'main' }),
          wt({ path: '/a-wt', branch: 'topic', locked: true, lockReason: 'on a usb stick' }),
          wt({ path: '/gone', prunable: true, prunableReason: 'directory is missing' }),
        ],
      },
    ]);
    const [row1, row2] = (await bridge.buildState()).repos[0]!.worktrees.slice(1);
    expect(row1).toMatchObject({ locked: true, lockReason: 'on a usb stick' });
    expect(row2).toMatchObject({ prunable: true, prunableReason: 'directory is missing' });
  });

  it('a repository that cannot be listed contributes an empty group, not a failure', async () => {
    const { bridge } = harness([
      {
        root: '/broken',
        worktrees: () => Promise.reject(new Error('fatal: not a git repository')),
      },
      { root: '/ok', worktrees: [wt({ path: '/ok', isMain: true, branch: 'main' })] },
    ]);
    const state = await bridge.buildState();
    expect(state.repos[0]?.worktrees).toEqual([]);
    expect(state.repos[1]?.worktrees).toHaveLength(1);
  });

  it('is empty until P13-T6 has registered its registry', async () => {
    const { bridge } = harness([{ root: '/a', worktrees: [] }], { registry: false });
    expect(await bridge.buildState()).toEqual({ repos: [] });
  });
});

describe('WorktreesPaneBridge.dispatch', () => {
  it('sends the tree view node shape to the row commands', async () => {
    const info = wt({ path: '/a-wt', branch: 'topic' });
    const { bridge, calls } = harness([
      { root: '/a', worktrees: [wt({ path: '/a', isMain: true, branch: 'main' }), info] },
    ]);
    await bridge.dispatch({ action: 'remove', repoRoot: '/a', path: '/a-wt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('gittree.worktree.remove');
    expect(calls[0]?.args[0]).toMatchObject({ kind: 'worktree', info: { path: '/a-wt' } });
  });

  it('add and prune name their repository and carry no row', async () => {
    const { bridge, calls } = harness([{ root: '/a', worktrees: [] }]);
    await bridge.dispatch({ action: 'add', repoRoot: '/a' });
    await bridge.dispatch({ action: 'prune', repoRoot: '/a' });
    expect(calls.map((c) => c.command)).toEqual(['gittree.worktree.add', 'gittree.worktree.prune']);
    // `add` takes (branchOrNode, repoRoot); an undefined seed means "from HEAD".
    expect(calls[0]?.args).toEqual([undefined, '/a']);
  });

  it('drops a row whose worktree vanished between render and click', async () => {
    const { bridge, calls } = harness([
      { root: '/a', worktrees: [wt({ path: '/a', isMain: true, branch: 'main' })] },
    ]);
    await bridge.dispatch({ action: 'open', repoRoot: '/a', path: '/a-wt-removed' });
    expect(calls).toEqual([]);
  });

  it('drops an action naming a repository that is no longer in the workspace', async () => {
    const { bridge, calls } = harness([{ root: '/a', worktrees: [] }]);
    await bridge.dispatch({ action: 'open', repoRoot: '/vanished', path: '/x' });
    expect(calls).toEqual([]);
  });

  it('refresh runs no git and no command — it pokes the shared provider', async () => {
    const { bridge, calls } = harness([{ root: '/a', worktrees: [] }]);
    await bridge.dispatch({ action: 'refresh' });
    expect(calls).toEqual([{ command: 'provider.refresh', args: [] }]);
  });
});
