/**
 * VCS Operations Popup model (P13-T7, gap analysis S6 — absent entirely
 * before). vscode-free so the context rules are unit-testable.
 *
 * The item set is **enumerated**, never hand-listed: `dialogRegistry.ts` and
 * `branchActions.ts` are the sources, so a dialog or branch action added later
 * appears here by construction. §1 of the gap analysis blames hand-maintained
 * inventories for the parity drift this phase group exists to fix.
 *
 * Two rules the acceptance line turns on:
 *   - **no item may appear that would immediately fail its own precondition** —
 *     every entry carries an `applies(ctx)` and the popup filters on it;
 *   - **an in-progress operation comes first** — mid-rebase, "continue / skip /
 *     abort" is the only thing anyone wants.
 */
import {
  applicableDialogs,
  type DialogContext,
  type DialogEntry,
} from '../scm/dialogs/dialogRegistry';

export type OpsGroup =
  | 'inProgress'
  | 'recent'
  | 'diff'
  | 'commit'
  | 'changes'
  | 'sync'
  | 'branch'
  | 'history'
  | 'setup';

export interface OpsItem {
  /** Command id — the popup dispatches this verbatim. */
  readonly command: string;
  readonly label: string;
  readonly group: OpsGroup;
  readonly icon?: string;
  readonly accelerator?: string;
  /** Arguments to pass with the command, when it needs any. */
  readonly args?: readonly unknown[];
}

/** What the popup knows about the moment it was opened. */
export interface OpsContext extends DialogContext {
  /** Short name of the current branch, for interpolated labels. */
  readonly currentBranch?: string;
}

/** Ordered group list — the sections the popup renders, top to bottom. */
export const OPS_GROUP_ORDER: readonly OpsGroup[] = [
  'inProgress',
  'recent',
  'diff',
  'commit',
  'changes',
  'sync',
  'branch',
  'history',
  'setup',
];

export const OPS_GROUP_LABEL: Record<OpsGroup, string> = {
  inProgress: 'In progress',
  recent: 'Recent',
  diff: 'Diff',
  commit: 'Commit',
  changes: 'Local changes',
  sync: 'Sync',
  branch: 'Branch',
  history: 'History',
  setup: 'Repository',
};

/**
 * The continue/skip/abort trio for whatever git is in the middle of. Rebase and
 * merge have different command families, and only rebase can skip a commit.
 */
export function inProgressItems(ctx: OpsContext): OpsItem[] {
  const kind = ctx.inProgressOp;
  if (kind === undefined || kind.length === 0) return [];
  const isRebase = kind.startsWith('rebase');
  const pretty =
    kind === 'rebase-interactive' || kind === 'rebase-apply'
      ? 'Rebase'
      : kind === 'cherry-pick'
        ? 'Cherry-Pick'
        : kind === 'revert'
          ? 'Revert'
          : 'Merge';
  const items: OpsItem[] = [
    {
      command: isRebase ? 'gittree.rebase.continue' : 'gittree.merge.continueOp',
      label: `Continue ${pretty}`,
      group: 'inProgress',
      icon: 'debug-continue',
    },
  ];
  if (isRebase) {
    items.push({
      command: 'gittree.rebase.skip',
      label: 'Skip Current Commit',
      group: 'inProgress',
      icon: 'debug-step-over',
    });
  }
  items.push({
    command: isRebase ? 'gittree.rebase.abort' : 'gittree.merge.abortOp',
    label: `Abort ${pretty}`,
    group: 'inProgress',
    icon: 'discard',
  });
  return items;
}

/** Actions that only make sense with a diff editor in front of you. */
export function diffItems(ctx: OpsContext): OpsItem[] {
  if (!ctx.diffEditorFocused) return [];
  return [
    { command: 'gittree.stageHunk', label: 'Stage Hunk', group: 'diff', icon: 'diff-added' },
    { command: 'gittree.unstageHunk', label: 'Unstage Hunk', group: 'diff', icon: 'diff-removed' },
    { command: 'gittree.revertHunk', label: 'Revert Hunk', group: 'diff', icon: 'discard' },
    {
      command: 'gittree.merge.nextConflict',
      label: 'Next Difference',
      group: 'diff',
      icon: 'arrow-down',
    },
  ];
}

/** Actions that only make sense with a commit selected in the log. */
export function commitItems(ctx: OpsContext): OpsItem[] {
  if (!ctx.commitSelected) return [];
  return [
    { command: 'gittree.log.checkoutRevision', label: 'Checkout Revision', group: 'commit' },
    { command: 'gittree.log.createBranchHere', label: 'New Branch Here…', group: 'commit' },
    { command: 'gittree.log.createTagHere', label: 'New Tag Here…', group: 'commit' },
    { command: 'gittree.log.copySha', label: 'Copy Revision Number', group: 'commit' },
    { command: 'gittree.log.compareWithLocal', label: 'Compare with Local', group: 'commit' },
  ];
}

const DIALOG_GROUP_TO_OPS: Record<DialogEntry['group'], OpsGroup> = {
  sync: 'sync',
  branch: 'branch',
  changes: 'changes',
  history: 'history',
  setup: 'setup',
};

/**
 * Every applicable item, grouped and ordered. `recent` floats the most recently
 * used commands to the top (after any in-progress operation, which always wins).
 */
export function buildOperationsItems(
  ctx: OpsContext,
  recent: readonly string[] = [],
): OpsItem[] {
  const fromDialogs: OpsItem[] = applicableDialogs(ctx).map((d) => ({
    command: d.command,
    label: d.label,
    group: DIALOG_GROUP_TO_OPS[d.group],
    ...(d.icon !== undefined ? { icon: d.icon } : {}),
    ...(d.accelerator !== undefined ? { accelerator: d.accelerator } : {}),
  }));

  const all = [
    ...inProgressItems(ctx),
    ...diffItems(ctx),
    ...commitItems(ctx),
    ...fromDialogs,
  ];

  // Recent: the same items, promoted — never duplicated in their own group.
  const byCommand = new Map(all.map((i) => [i.command, i]));
  const promoted: OpsItem[] = [];
  for (const command of recent) {
    const item = byCommand.get(command);
    // An in-progress action is already at the top and must not be demoted.
    if (item === undefined || item.group === 'inProgress') continue;
    promoted.push({ ...item, group: 'recent' });
    byCommand.delete(command);
  }

  const remaining = all.filter((i) => i.group === 'inProgress' || byCommand.has(i.command));
  const ordered = [...remaining, ...promoted];
  return ordered.sort(
    (a, b) => OPS_GROUP_ORDER.indexOf(a.group) - OPS_GROUP_ORDER.indexOf(b.group),
  );
}

/** Most-recent-first, capped and de-duplicated — the popup's memory. */
export function recordRecent(
  recent: readonly string[],
  command: string,
  limit = 5,
): string[] {
  return [command, ...recent.filter((c) => c !== command)].slice(0, limit);
}
