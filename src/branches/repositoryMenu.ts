/**
 * A repository's right-click menu in the Branches section: the menu the
 * Repositories section already shows for the same repository, so a repository
 * has one menu wherever its name is. Each entry runs its command with the
 * repository's root, which every one of them reads as "this repository only" —
 * `geet.fetch` included, which with no argument fetches every root.
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
  { command: 'geet.repositories.showInLog', label: 'Show in New Log Tab', group: 'view' },
  // POST-P14bx: this repository's update, named so. It was Update Project…,
  // which elsewhere updates every repository, and here updated this one alone.
  { command: 'geet.update.repository', label: 'Update Repository…', group: 'update' },
  // From each remote branch as last fetched: instant, and offline.
  { command: 'geet.update.repositoryWithoutFetch', label: 'Update Repository Without Fetching…', group: 'update' },
  { command: 'geet.push.dialog', label: 'Push…', group: 'update' },
  { command: 'geet.fetch', label: 'Fetch', group: 'update' },
  { command: 'geet.commit', label: 'Commit', group: 'commit' },
  { command: 'geet.branch.new', label: 'New Branch…', group: 'branch' },
  { command: 'geet.branches.checkoutRevision', label: 'Checkout Tag or Revision…', group: 'branch' },
  { command: 'geet.stash.dialog', label: 'Stash Changes…', group: 'stash' },
  { command: 'geet.unstash.dialog', label: 'Unstash Changes…', group: 'stash' },
  { command: 'geet.remotes.manage', label: 'Manage Remotes…', group: 'manage' },
];

/**
 * In the Repositories section's menu but not in this one: `Checkout Branch…`
 * opens the branch list for the repository, and in the Branches section that
 * list is the very thing you right-clicked in.
 */
export const LEFT_OUT_OF_BRANCHES_VIEW: readonly string[] = ['geet.branches.open'];

/**
 * POST-P14bx: with one repository, the repository is the project, so its menu
 * updates under the project's name, as `Ctrl+T` and the panel's own buttons do
 * there. Only the Repositories panel ever shows it so: the Repositories (Tree)
 * view is there only with several repositories.
 */
const AS_PROJECT: Readonly<Record<string, RepositoryMenuEntry>> = {
  'geet.update.repository': { command: 'geet.update.dialog', label: 'Update Project…', group: 'update' },
  'geet.update.repositoryWithoutFetch': {
    command: 'geet.update.withoutFetch',
    label: 'Update Project Without Fetching…',
    group: 'update',
  },
};

/** A repository's menu in a workspace of `repoCount` repositories: `REPOSITORY_MENU`, or with one, `AS_PROJECT`'s. */
export function repositoryMenuFor(repoCount: number): readonly RepositoryMenuEntry[] {
  return repoCount > 1 ? REPOSITORY_MENU : REPOSITORY_MENU.map((entry) => AS_PROJECT[entry.command] ?? entry);
}

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
