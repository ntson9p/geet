import { describe, expect, it } from 'vitest';
import { EMPTY_DIALOG_CONTEXT } from '../../../src/scm/dialogs/dialogRegistry';
import {
  buildOperationsItems,
  commitItems,
  diffItems,
  inProgressItems,
  OPS_GROUP_ORDER,
  recordRecent,
  syncItems,
  type OpsContext,
} from '../../../src/ui/operationsModel';

/**
 * P13-T7 accept: "the popup's item set differs correctly across four contexts
 * (clean tree, dirty tree, mid-rebase, diff editor focused); no item appears
 * that would immediately fail its own precondition."
 */

const ctx = (over: Partial<OpsContext> = {}): OpsContext => ({
  ...EMPTY_DIALOG_CONTEXT,
  hasRepo: true,
  ...over,
});

const commandsOf = (c: OpsContext, recent: string[] = []): string[] =>
  buildOperationsItems(c, recent).map((i) => i.command);

describe('inProgressItems', () => {
  it('is empty when nothing is in progress', () => {
    expect(inProgressItems(ctx())).toEqual([]);
  });

  it('offers continue / skip / abort for a rebase', () => {
    const items = inProgressItems(ctx({ inProgressOp: 'rebase-interactive' }));
    expect(items.map((i) => i.command)).toEqual([
      'gittree.rebase.continue',
      'gittree.rebase.skip',
      'gittree.rebase.abort',
    ]);
    expect(items[0]?.label).toBe('Continue Rebase');
  });

  it('offers continue / abort for a merge — a merge has no "skip"', () => {
    const items = inProgressItems(ctx({ inProgressOp: 'merge' }));
    expect(items.map((i) => i.command)).toEqual([
      'gittree.merge.continueOp',
      'gittree.merge.abortOp',
    ]);
    expect(items.map((i) => i.command)).not.toContain('gittree.rebase.skip');
  });

  it('names the operation it is continuing', () => {
    expect(inProgressItems(ctx({ inProgressOp: 'cherry-pick' }))[0]?.label).toBe(
      'Continue Cherry-Pick',
    );
    expect(inProgressItems(ctx({ inProgressOp: 'revert' }))[0]?.label).toBe('Continue Revert');
  });
});

describe('diffItems / commitItems', () => {
  it('only appear when their context does', () => {
    expect(diffItems(ctx())).toEqual([]);
    expect(commitItems(ctx())).toEqual([]);
    expect(diffItems(ctx({ diffEditorFocused: true })).length).toBeGreaterThan(0);
    expect(commitItems(ctx({ commitSelected: true })).length).toBeGreaterThan(0);
  });

  it('offer hunk actions in a diff editor', () => {
    expect(diffItems(ctx({ diffEditorFocused: true })).map((i) => i.command)).toContain(
      'gittree.stageHunk',
    );
  });
});

describe('buildOperationsItems across the four contexts', () => {
  it('a clean tree hides the change actions', () => {
    const commands = commandsOf(ctx());
    expect(commands).not.toContain('gittree.stash.dialog');
    expect(commands).not.toContain('gittree.rollback.dialog');
    expect(commands).not.toContain('gittree.commit');
    // Branch-level actions still apply.
    expect(commands).toContain('gittree.merge.dialog');
  });

  it('a dirty tree adds commit / stash / shelve / rollback', () => {
    const commands = commandsOf(ctx({ dirty: true }));
    for (const c of [
      'gittree.commit',
      'gittree.stash.dialog',
      'gittree.shelve.dialog',
      'gittree.rollback.dialog',
    ]) {
      expect(commands).toContain(c);
    }
  });

  it('mid-rebase puts continue/skip/abort first', () => {
    const items = buildOperationsItems(ctx({ dirty: true, inProgressOp: 'rebase-apply' }));
    expect(items[0]?.command).toBe('gittree.rebase.continue');
    expect(items[0]?.group).toBe('inProgress');
    // The rest of the popup is still there beneath it.
    expect(items.map((i) => i.command)).toContain('gittree.commit');
  });

  it('a focused diff editor adds the hunk actions and keeps the rest', () => {
    const commands = commandsOf(ctx({ diffEditorFocused: true }));
    expect(commands).toContain('gittree.revertHunk');
    expect(commands).toContain('gittree.merge.dialog');
  });

  it('the four contexts really differ from one another', () => {
    const clean = commandsOf(ctx()).join(',');
    const dirty = commandsOf(ctx({ dirty: true })).join(',');
    const rebasing = commandsOf(ctx({ inProgressOp: 'rebase-apply' })).join(',');
    const diffing = commandsOf(ctx({ diffEditorFocused: true })).join(',');
    expect(new Set([clean, dirty, rebasing, diffing]).size).toBe(4);
  });
});

describe('preconditions', () => {
  it('never offers Push without a remote, or Update without an upstream', () => {
    const bare = commandsOf(ctx());
    expect(bare).not.toContain('gittree.push.dialog');
    expect(bare).not.toContain('gittree.update.dialog');

    const wired = commandsOf(ctx({ hasRemote: true, hasUpstream: true }));
    expect(wired).toContain('gittree.push.dialog');
    expect(wired).toContain('gittree.update.dialog');
  });

  it('POST-P14ae: dispatches Update Project for the project, not the popup\'s repository', () => {
    // The popup passes its repository to any item without args of its own;
    // an explicit empty list is how Fetch already stays project-wide.
    const update = buildOperationsItems(ctx({ hasRemote: true, hasUpstream: true })).find(
      (i) => i.command === 'gittree.update.dialog',
    );
    expect(update?.args).toEqual([]);
  });

  it('never offers Unstash with no stash', () => {
    expect(commandsOf(ctx())).not.toContain('gittree.unstash.dialog');
    expect(commandsOf(ctx({ hasStash: true }))).toContain('gittree.unstash.dialog');
  });

  it('offers only Clone with no repository at all', () => {
    expect(commandsOf({ ...EMPTY_DIALOG_CONTEXT })).toEqual(['gittree.clone.dialog']);
  });
});

/**
 * POST-P14o: Fetch was absent from this popup entirely — the item set is
 * enumerated from `dialogRegistry` and fetch has no dialog.
 */
describe('syncItems — Fetch', () => {
  it('needs a remote: no remote, no Fetch', () => {
    expect(syncItems(ctx())).toEqual([]);
    expect(syncItems({ ...EMPTY_DIALOG_CONTEXT })).toEqual([]);
    expect(syncItems(ctx({ hasRemote: true })).map((i) => i.command)).toEqual([
      'gittree.fetch.all',
    ]);
  });

  it('is project-wide: an explicit empty argument list, so the popup cannot scope it', () => {
    // The popup passes the active repo root to anything with no args of its
    // own; Fetch must not be narrowed back down to one root by that.
    expect(syncItems(ctx({ hasRemote: true }))[0]?.args).toEqual([]);
  });

  it('names itself for the workspace it is in', () => {
    expect(syncItems(ctx({ hasRemote: true }))[0]?.label).toBe('Fetch');
    expect(syncItems(ctx({ hasRemote: true, repoCount: 1 }))[0]?.label).toBe('Fetch');
    expect(syncItems(ctx({ hasRemote: true, repoCount: 4 }))[0]?.label).toBe(
      'Fetch All Repositories',
    );
  });

  it('reaches the assembled popup, in the sync group', () => {
    const items = buildOperationsItems(ctx({ hasRemote: true, hasUpstream: true }));
    const fetch = items.find((i) => i.command === 'gittree.fetch.all');
    expect(fetch?.group).toBe('sync');
  });
});

describe('groups and recency', () => {
  it('emits groups in the documented order', () => {
    const items = buildOperationsItems(
      ctx({ dirty: true, hasRemote: true, hasUpstream: true, inProgressOp: 'merge' }),
    );
    const seen = items.map((i) => OPS_GROUP_ORDER.indexOf(i.group));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('floats a recently used command into its own group, exactly once', () => {
    const items = buildOperationsItems(ctx({ dirty: true }), ['gittree.stash.dialog']);
    const stash = items.filter((i) => i.command === 'gittree.stash.dialog');
    expect(stash).toHaveLength(1);
    expect(stash[0]?.group).toBe('recent');
  });

  it('never demotes an in-progress action into "recent"', () => {
    const items = buildOperationsItems(ctx({ inProgressOp: 'merge' }), [
      'gittree.merge.continueOp',
    ]);
    const cont = items.filter((i) => i.command === 'gittree.merge.continueOp');
    expect(cont).toHaveLength(1);
    expect(cont[0]?.group).toBe('inProgress');
    expect(items[0]?.command).toBe('gittree.merge.continueOp');
  });

  it('ignores a remembered command that does not apply now', () => {
    const items = buildOperationsItems(ctx(), ['gittree.unstash.dialog']);
    expect(items.map((i) => i.command)).not.toContain('gittree.unstash.dialog');
  });
});

describe('recordRecent', () => {
  it('puts the newest first and de-duplicates', () => {
    expect(recordRecent(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
    expect(recordRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('caps the list', () => {
    expect(recordRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(recordRecent(['a', 'b'], 'c', 2)).toEqual(['c', 'a']);
  });
});
