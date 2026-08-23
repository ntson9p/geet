import { describe, expect, it } from 'vitest';
import { formatGitCommand } from '../../../src/scm/dialogs/commandLine';
import {
  buildMergeArgs,
  EMPTY_MERGE_OPTIONS,
  validateMergeOptions,
  type MergeOptions,
} from '../../../src/scm/dialogs/mergeArgs';
import {
  buildRebaseArgs,
  EMPTY_REBASE_OPTIONS,
  validateRebaseOptions,
  type RebaseOptions,
} from '../../../src/scm/dialogs/rebaseArgs';
import {
  buildResetArgs,
  describeResetImpact,
  resetNeedsConfirm,
  resetNeedsSnapshot,
  RESET_MODES,
  validateResetOptions,
} from '../../../src/scm/dialogs/resetArgs';
import {
  isEmptyRollbackPlan,
  planRollback,
  rollbackCommands,
  rollbackKindOf,
} from '../../../src/scm/dialogs/rollbackPlan';

/**
 * P13-T3 accept: "argv assembly per option matrix (one test per flag, plus
 * mutually exclusive pairs rejected)". These are the flags S4 says GitTree
 * hides entirely today, so every one of them gets its own assertion.
 */

// ---- Merge ------------------------------------------------------------------

const merge = (over: Partial<MergeOptions> = {}): string[] =>
  buildMergeArgs({ ...EMPTY_MERGE_OPTIONS, ref: 'feature/x', ...over });

describe('buildMergeArgs', () => {
  it('is a plain merge with an unambiguous ref by default', () => {
    expect(merge()).toEqual(['merge', '--', 'feature/x']);
  });

  it('emits --no-ff', () => {
    expect(merge({ noFf: true })).toEqual(['merge', '--no-ff', '--', 'feature/x']);
  });

  it('emits --ff-only', () => {
    expect(merge({ ffOnly: true })).toEqual(['merge', '--ff-only', '--', 'feature/x']);
  });

  it('emits --squash', () => {
    expect(merge({ squash: true })).toEqual(['merge', '--squash', '--', 'feature/x']);
  });

  it('emits --no-commit', () => {
    expect(merge({ noCommit: true })).toEqual(['merge', '--no-commit', '--', 'feature/x']);
  });

  it('emits --allow-unrelated-histories', () => {
    expect(merge({ allowUnrelatedHistories: true })).toEqual([
      'merge',
      '--allow-unrelated-histories',
      '--',
      'feature/x',
    ]);
  });

  it('emits the strategy and the strategy option separately', () => {
    expect(merge({ strategy: 'ours' })).toEqual(['merge', '--strategy', 'ours', '--', 'feature/x']);
    expect(merge({ strategyOption: 'theirs' })).toEqual([
      'merge',
      '--strategy-option',
      'theirs',
      '--',
      'feature/x',
    ]);
    expect(merge({ strategy: 'ort', strategyOption: 'ignore-space-change' })).toEqual([
      'merge',
      '--strategy',
      'ort',
      '--strategy-option',
      'ignore-space-change',
      '--',
      'feature/x',
    ]);
  });

  it('passes a custom message, trimmed', () => {
    expect(merge({ message: '  merge the thing  ' })).toEqual([
      'merge',
      '-m',
      'merge the thing',
      '--',
      'feature/x',
    ]);
  });

  it('never emits -m for a squash — no commit is created to carry it', () => {
    expect(merge({ squash: true, message: 'dropped' })).not.toContain('-m');
  });

  it('combines the whole matrix in a stable order', () => {
    expect(
      merge({
        noFf: true,
        noCommit: true,
        allowUnrelatedHistories: true,
        strategy: 'recursive',
        strategyOption: 'ours',
        message: 'big merge',
      }),
    ).toEqual([
      'merge',
      '--no-ff',
      '--no-commit',
      '--allow-unrelated-histories',
      '--strategy',
      'recursive',
      '--strategy-option',
      'ours',
      '-m',
      'big merge',
      '--',
      'feature/x',
    ]);
  });
});

describe('validateMergeOptions', () => {
  const opts = (over: Partial<MergeOptions>): MergeOptions => ({
    ...EMPTY_MERGE_OPTIONS,
    ref: 'feature/x',
    ...over,
  });

  it('accepts a plain merge', () => {
    expect(validateMergeOptions(opts({}))).toEqual([]);
  });

  it('requires a ref', () => {
    expect(validateMergeOptions(opts({ ref: '   ' }))).toHaveLength(1);
  });

  it('rejects --no-ff with --ff-only', () => {
    expect(validateMergeOptions(opts({ noFf: true, ffOnly: true })).join(' ')).toMatch(
      /contradict/i,
    );
  });

  it('rejects --squash with --no-ff, as git does', () => {
    expect(validateMergeOptions(opts({ squash: true, noFf: true })).join(' ')).toMatch(/--squash/);
  });

  it('rejects a message that a squash would silently drop', () => {
    expect(validateMergeOptions(opts({ squash: true, message: 'hi' })).join(' ')).toMatch(
      /dropped/i,
    );
  });
});

// ---- Rebase -----------------------------------------------------------------

const rebase = (over: Partial<RebaseOptions> = {}): string[] =>
  buildRebaseArgs({ ...EMPTY_REBASE_OPTIONS, onto: 'main', ...over });

describe('buildRebaseArgs', () => {
  it('rebases onto a ref by default', () => {
    expect(rebase()).toEqual(['rebase', 'main']);
  });

  it('emits --interactive', () => {
    expect(rebase({ interactive: true })).toEqual(['rebase', '--interactive', 'main']);
  });

  it('emits --rebase-merges (never the removed --preserve-merges)', () => {
    expect(rebase({ rebaseMerges: true })).toEqual(['rebase', '--rebase-merges', 'main']);
    expect(rebase({ rebaseMerges: true })).not.toContain('--preserve-merges');
  });

  it('emits --autostash', () => {
    expect(rebase({ autostash: true })).toEqual(['rebase', '--autostash', 'main']);
  });

  it('emits --no-verify', () => {
    expect(rebase({ noVerify: true })).toEqual(['rebase', '--no-verify', 'main']);
  });

  it('emits --keep-empty', () => {
    expect(rebase({ keepEmpty: true })).toEqual(['rebase', '--keep-empty', 'main']);
  });

  it('transplants a range with --onto when a From ref is given', () => {
    expect(rebase({ from: 'old-base' })).toEqual(['rebase', '--onto', 'main', 'old-base']);
  });

  it('combines the whole matrix in a stable order', () => {
    expect(
      rebase({
        interactive: true,
        rebaseMerges: true,
        autostash: true,
        noVerify: true,
        keepEmpty: true,
        from: 'old-base',
      }),
    ).toEqual([
      'rebase',
      '--interactive',
      '--rebase-merges',
      '--autostash',
      '--no-verify',
      '--keep-empty',
      '--onto',
      'main',
      'old-base',
    ]);
  });
});

describe('validateRebaseOptions', () => {
  it('requires an onto ref', () => {
    expect(validateRebaseOptions({ ...EMPTY_REBASE_OPTIONS })).toHaveLength(1);
  });

  it('rejects a From identical to Onto', () => {
    expect(
      validateRebaseOptions({ ...EMPTY_REBASE_OPTIONS, onto: 'main', from: ' main ' }).join(' '),
    ).toMatch(/nothing to replay/i);
  });

  it('accepts a real transplant', () => {
    expect(
      validateRebaseOptions({ ...EMPTY_REBASE_OPTIONS, onto: 'main', from: 'old-base' }),
    ).toEqual([]);
  });
});

// ---- Reset ------------------------------------------------------------------

describe('buildResetArgs', () => {
  it('emits one flag per mode, including keep', () => {
    for (const mode of RESET_MODES) {
      expect(buildResetArgs({ ref: 'abc1234', mode })).toEqual(['reset', `--${mode}`, 'abc1234']);
    }
  });

  it('trims the revision the user typed', () => {
    expect(buildResetArgs({ ref: '  HEAD~2 ', mode: 'mixed' })).toEqual([
      'reset',
      '--mixed',
      'HEAD~2',
    ]);
  });

  it('requires a revision', () => {
    expect(validateResetOptions({ ref: '', mode: 'hard' })).toHaveLength(1);
    expect(validateResetOptions({ ref: 'HEAD~1', mode: 'hard' })).toEqual([]);
  });
});

describe('reset safety classification', () => {
  it('snapshots the two modes that move the worktree', () => {
    expect(resetNeedsSnapshot('soft')).toBe(false);
    expect(resetNeedsSnapshot('mixed')).toBe(false);
    expect(resetNeedsSnapshot('hard')).toBe(true);
    expect(resetNeedsSnapshot('keep')).toBe(true);
  });

  it('only --hard needs the destructive confirmation — --keep refuses instead', () => {
    expect(resetNeedsConfirm('hard')).toBe(true);
    expect(resetNeedsConfirm('keep')).toBe(false);
    expect(resetNeedsConfirm('soft')).toBe(false);
    expect(resetNeedsConfirm('mixed')).toBe(false);
  });
});

describe('describeResetImpact', () => {
  it('says nothing is lost for soft', () => {
    expect(describeResetImpact('soft', 5, 2)).toMatch(/untouched/i);
  });

  it('counts what mixed unstages, and says the disk is safe', () => {
    expect(describeResetImpact('mixed', 5, 2)).toMatch(/unstages 2 staged changes/);
    expect(describeResetImpact('mixed', 5, 2)).toMatch(/untouched/i);
    expect(describeResetImpact('mixed', 0, 0)).toMatch(/Nothing is currently staged/);
  });

  it('shouts about what hard discards, and singularizes', () => {
    expect(describeResetImpact('hard', 3, 0)).toMatch(/DISCARDS 3 local changes/);
    expect(describeResetImpact('hard', 1, 0)).toMatch(/DISCARDS 1 local change\./);
    expect(describeResetImpact('hard', 0, 0)).toMatch(/currently clean/i);
  });

  it('explains that keep refuses rather than discarding', () => {
    expect(describeResetImpact('keep', 4, 0)).toMatch(/refuses the reset instead of discarding/);
  });
});

// ---- Rollback ---------------------------------------------------------------

describe('rollbackKindOf', () => {
  it('classifies by status, not by name', () => {
    expect(rollbackKindOf({ kind: 'untracked', x: '?', y: '?' })).toBe('untracked');
    expect(rollbackKindOf({ kind: 'ordinary', x: 'A', y: '.' })).toBe('added');
    expect(rollbackKindOf({ kind: 'ordinary', x: '.', y: 'M' })).toBe('restore');
    expect(rollbackKindOf({ kind: 'renamed', x: 'R', y: '.' })).toBe('restore');
    expect(rollbackKindOf({ kind: 'unmerged', x: 'U', y: 'U' })).toBe('restore');
  });
});

describe('planRollback', () => {
  const files = [
    { path: 'a.txt', kind: 'restore' as const },
    { path: 'new.txt', kind: 'added' as const },
    { path: 'scratch.txt', kind: 'untracked' as const },
    { path: 'renamed.txt', kind: 'restore' as const, origPath: 'original.txt' },
  ];

  it('restores tracked changes and brings a rename source back', () => {
    const plan = planRollback(files, true);
    expect(plan.restorePaths).toEqual(['a.txt', 'renamed.txt', 'original.txt']);
  });

  it('deletes added and untracked local copies when the box is ticked', () => {
    const plan = planRollback(files, true);
    expect(plan.unstagePaths).toEqual(['new.txt']);
    expect(plan.deletePaths).toEqual(['new.txt', 'scratch.txt']);
  });

  it('keeps the files on disk when the box is unticked, but still unstages', () => {
    const plan = planRollback(files, false);
    expect(plan.unstagePaths).toEqual(['new.txt']);
    expect(plan.deletePaths).toEqual([]);
    // The tracked restores are unaffected by the checkbox.
    expect(plan.restorePaths).toEqual(['a.txt', 'renamed.txt', 'original.txt']);
  });

  it('does not repeat a path that two files agree on', () => {
    const plan = planRollback(
      [
        { path: 'x.txt', kind: 'restore' },
        { path: 'y.txt', kind: 'restore', origPath: 'x.txt' },
      ],
      false,
    );
    expect(plan.restorePaths).toEqual(['x.txt', 'y.txt']);
  });

  it('reports an empty plan for an empty selection', () => {
    expect(isEmptyRollbackPlan(planRollback([], true))).toBe(true);
    expect(isEmptyRollbackPlan(planRollback(files, false))).toBe(false);
    // Untracked-only with the box off really is a no-op.
    expect(isEmptyRollbackPlan(planRollback([{ path: 'u.txt', kind: 'untracked' }], false))).toBe(
      true,
    );
  });
});

describe('rollbackCommands', () => {
  it('previews the restore and the unstage, in that order', () => {
    const plan = planRollback(
      [
        { path: 'a.txt', kind: 'restore' },
        { path: 'new.txt', kind: 'added' },
      ],
      true,
    );
    expect(rollbackCommands(plan).map((c) => formatGitCommand(c))).toEqual([
      'git restore --source=HEAD --staged --worktree -- a.txt',
      'git rm --cached -q -- new.txt',
    ]);
  });

  it('previews nothing when only deletions are planned', () => {
    const plan = planRollback([{ path: 'u.txt', kind: 'untracked' }], true);
    expect(rollbackCommands(plan)).toEqual([]);
    expect(plan.deletePaths).toEqual(['u.txt']);
  });
});
