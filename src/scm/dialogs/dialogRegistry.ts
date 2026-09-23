/**
 * The one registry of GitTree's dialogs (P13-T4 step 6). P13-T7's VCS
 * Operations Popup enumerates *this* rather than a hand-maintained list, so a
 * dialog added later cannot silently go missing from the hub — the gap analysis
 * §1 blames exactly that kind of hand-kept inventory for the parity drift.
 *
 * vscode-free: `applies` is fed a plain context the caller assembles, so the
 * whole table is unit-testable.
 */

export interface DialogContext {
  /** A repository is open. */
  readonly hasRepo: boolean;
  /** The worktree has uncommitted changes. */
  readonly dirty: boolean;
  /** The current branch has an upstream. */
  readonly hasUpstream: boolean;
  /** At least one remote is configured. */
  readonly hasRemote: boolean;
  /** At least one stash entry exists. */
  readonly hasStash: boolean;
  /** A merge/rebase/cherry-pick/revert is in progress. */
  readonly inProgressOp?: string;
  /** The focused editor is a diff editor. */
  readonly diffEditorFocused: boolean;
  /** A commit is selected in the log. */
  readonly commitSelected: boolean;
}

export const EMPTY_DIALOG_CONTEXT: DialogContext = {
  hasRepo: false,
  dirty: false,
  hasUpstream: false,
  hasRemote: false,
  hasStash: false,
  diffEditorFocused: false,
  commitSelected: false,
};

export type DialogGroup = 'sync' | 'branch' | 'changes' | 'history' | 'setup';

export interface DialogEntry {
  /** Command id — the popup dispatches this verbatim. */
  readonly command: string;
  /** Menu label, IntelliJ's wording. */
  readonly label: string;
  readonly group: DialogGroup;
  /** Keyboard hint shown right-aligned, when the IntelliJ keymap is on. */
  readonly accelerator?: string;
  /** Codicon name without the prefix. */
  readonly icon?: string;
  /**
   * Arguments to dispatch with. Omitted, a caller that knows a repository
   * passes its root; an explicit `[]` keeps a project-wide command from
   * being scoped back down to one repository — Fetch's idiom (POST-P14o).
   */
  readonly args?: readonly unknown[];
  /**
   * Whether the entry is offered in this context. The rule for T7 is that no
   * item may appear that would immediately fail its own precondition.
   */
  readonly applies: (ctx: DialogContext) => boolean;
}

const needsRepo = (ctx: DialogContext): boolean => ctx.hasRepo;

export const DIALOG_REGISTRY: readonly DialogEntry[] = [
  {
    command: 'gittree.update.dialog',
    label: 'Update Project…',
    group: 'sync',
    accelerator: 'Ctrl+T',
    icon: 'sync',
    // POST-P14ae: the project, as IntelliJ's is — never just the repository
    // the popup happened to open over.
    args: [],
    applies: (ctx) => ctx.hasRepo && ctx.hasUpstream,
  },
  {
    command: 'gittree.push.dialog',
    label: 'Push…',
    group: 'sync',
    accelerator: 'Ctrl+Shift+K',
    icon: 'repo-push',
    applies: (ctx) => ctx.hasRepo && ctx.hasRemote,
  },
  {
    command: 'gittree.commit',
    label: 'Commit…',
    group: 'changes',
    accelerator: 'Ctrl+K',
    icon: 'check',
    applies: (ctx) => ctx.hasRepo && ctx.dirty,
  },
  {
    command: 'gittree.merge.dialog',
    label: 'Merge…',
    group: 'branch',
    icon: 'git-merge',
    applies: needsRepo,
  },
  {
    command: 'gittree.rebase.dialog',
    label: 'Rebase…',
    group: 'branch',
    applies: needsRepo,
  },
  {
    command: 'gittree.reset.dialog',
    label: 'Reset…',
    group: 'history',
    icon: 'discard',
    applies: needsRepo,
  },
  {
    command: 'gittree.rollback.dialog',
    label: 'Rollback…',
    group: 'changes',
    accelerator: 'Ctrl+Alt+Z',
    icon: 'discard',
    applies: (ctx) => ctx.hasRepo && ctx.dirty,
  },
  {
    command: 'gittree.cherryPick.dialog',
    label: 'Cherry-Pick…',
    group: 'history',
    applies: needsRepo,
  },
  {
    command: 'gittree.stash.dialog',
    label: 'Stash Changes…',
    group: 'changes',
    applies: (ctx) => ctx.hasRepo && ctx.dirty,
  },
  {
    command: 'gittree.unstash.dialog',
    label: 'Unstash Changes…',
    group: 'changes',
    applies: (ctx) => ctx.hasRepo && ctx.hasStash,
  },
  {
    command: 'gittree.shelve.dialog',
    label: 'Shelve Changes…',
    group: 'changes',
    icon: 'archive',
    applies: (ctx) => ctx.hasRepo && ctx.dirty,
  },
  {
    command: 'gittree.patch.applyDialog',
    label: 'Apply Patch…',
    group: 'changes',
    applies: needsRepo,
  },
  {
    command: 'gittree.remotes.manage',
    label: 'Manage Remotes…',
    group: 'setup',
    icon: 'remote',
    applies: needsRepo,
  },
  {
    command: 'gittree.clone.dialog',
    label: 'Clone…',
    group: 'setup',
    icon: 'repo-clone',
    // The only entry that works without an open repository.
    applies: () => true,
  },
];

/** Entries valid in a context, in registry order. */
export function applicableDialogs(ctx: DialogContext): DialogEntry[] {
  return DIALOG_REGISTRY.filter((d) => d.applies(ctx));
}

/** Registry lookup by command id — the popup's "recently used" needs it. */
export function findDialog(command: string): DialogEntry | undefined {
  return DIALOG_REGISTRY.find((d) => d.command === command);
}
