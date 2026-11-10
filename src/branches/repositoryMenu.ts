/**
 * A repository's right-click menu in the Branches section: the menu the
 * Repositories section already shows for the same repository, so a repository
 * has one menu wherever its name is. Each entry runs its command with the
 * repository's root, which every one of them reads as "this repository only" —
 * `gittree.fetch` included, which with no argument fetches every root.
 *
 * The Repositories section's menu lives in `package.json` (`view/item/context`);
 * a unit test holds this list to it, entry for entry, so the two cannot drift.
 * Pure and vscode-free.
 */
import type { BranchesActionDto } from '../shared/protocol';

export interface RepositoryMenuEntry {
  readonly command: string;
  /** The command's title, as the Repositories section shows it. */
  readonly label: string;
  /** Entries of one group sit together; a rule separates the groups. */
  readonly group: 'view' | 'update' | 'commit' | 'branch' | 'stash' | 'manage';
}

export const REPOSITORY_MENU: readonly RepositoryMenuEntry[] = [
  // The repository's history at HEAD, in a Log tab of its own.
  { command: 'gittree.repositories.showInLog', label: 'Show in New Log Tab', group: 'view' },
  { command: 'gittree.update.dialog', label: 'Update Project…', group: 'update' },
  { command: 'gittree.push.dialog', label: 'Push…', group: 'update' },
  { command: 'gittree.fetch', label: 'Fetch', group: 'update' },
  { command: 'gittree.commit', label: 'Commit', group: 'commit' },
  { command: 'gittree.branch.new', label: 'New Branch…', group: 'branch' },
  { command: 'gittree.branches.checkoutRevision', label: 'Checkout Tag or Revision…', group: 'branch' },
  { command: 'gittree.stash.dialog', label: 'Stash Changes…', group: 'stash' },
  { command: 'gittree.unstash.dialog', label: 'Unstash Changes…', group: 'stash' },
  { command: 'gittree.remotes.manage', label: 'Manage Remotes…', group: 'manage' },
];

/**
 * In the Repositories section's menu but not in this one: `Checkout Branch…`
 * opens the branch list for the repository, and in the Branches section that
 * list is the very thing you right-clicked in.
 */
export const LEFT_OUT_OF_BRANCHES_VIEW: readonly string[] = ['gittree.branches.open'];

/** The menu as the view draws it: ids are the commands, a rule before each new group. */
export function repositoryMenuDto(): BranchesActionDto[] {
  let lastGroup: string | undefined;
  return REPOSITORY_MENU.map((entry) => {
    const separator = lastGroup !== undefined && entry.group !== lastGroup;
    lastGroup = entry.group;
    return { id: entry.command, label: entry.label, ...(separator ? { separator: true } : {}) };
  });
}

export function repositoryMenuEntry(command: unknown): RepositoryMenuEntry | undefined {
  return typeof command === 'string' ? REPOSITORY_MENU.find((e) => e.command === command) : undefined;
}
