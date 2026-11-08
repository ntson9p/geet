/**
 * The per-repository part of a branch's menu, when the branch is in several
 * repositories (new-way-6): each repository's own menu, so the branch can be
 * acted on in one of them without narrowing the panel first.
 *
 * A few are listed as they are, under *In one repository*. Past that, they are
 * one row, *In One Repository*, holding them all: twenty copies of a project
 * made the menu taller than the sidebar, with the actions buried above twenty
 * repository names. IntelliJ's own branch menu across repositories has no
 * such list at all: its actions run in all of them, and one repository's are
 * in that repository's part of the popup.
 *
 * Free of `vscode`, so the rule is unit-tested; `panelActions.ts` supplies the
 * words and each repository's menu.
 */
import type { BranchPanelMenuItemDto } from '../shared/protocol';

/** Repositories listed as they are; past this many they are one row. */
export const INLINE_REPOSITORIES = 5;

export interface OneRepositoryWords {
  /** The heading over the listed repositories: `In one repository`. */
  readonly header: string;
  /** The one row holding them, past the limit: `In One Repository`. */
  readonly folded: string;
}

/**
 * The menu's last part: a heading and the repositories' own submenus while
 * there are `INLINE_REPOSITORIES` or fewer, else one submenu holding them.
 */
export function oneRepositoryItems(
  perRepository: readonly BranchPanelMenuItemDto[],
  words: OneRepositoryWords,
): BranchPanelMenuItemDto[] {
  if (perRepository.length === 0) return [];
  if (perRepository.length <= INLINE_REPOSITORIES) {
    return [{ kind: 'header', label: words.header }, ...perRepository];
  }
  return [{ kind: 'submenu', label: words.folded, icon: 'repo', items: [...perRepository] }];
}
