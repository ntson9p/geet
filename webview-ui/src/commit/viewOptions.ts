/**
 * View Options, the eye in the Commit tab's toolbar (IntelliJ's
 * `ChangesView.ViewOptions`): its `Group By` section. IntelliJ ticks
 * Directory, Module and Repository there; GitTree always groups by directory
 * and by repository, and offers which of changelists and repositories comes
 * first instead (D37). Pure, so what each row ticks and what a click changes
 * are testable without a page.
 */
import type { CommitGroupBy } from '../../../src/shared/protocol';

/** A row of the menu, in the shape of `Menu`'s `MenuItem`, spelled out so this module stays free of React. */
export type ViewOptionRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'item';
      readonly id: CommitGroupBy;
      readonly label: string;
      readonly checked: boolean;
      readonly radio: true;
      readonly title: string;
    };

export function viewOptionsItems(groupBy: CommitGroupBy): ViewOptionRow[] {
  return [
    { kind: 'header', id: 'groupBy', label: 'Group By' },
    {
      kind: 'item',
      id: 'changelist',
      label: 'Changelist › Repository',
      checked: groupBy === 'changelist',
      radio: true,
      title: "Changelists at the top, each repository's share of a list beneath it",
    },
    {
      kind: 'item',
      id: 'repository',
      label: 'Repository › Changelist',
      checked: groupBy === 'repository',
      radio: true,
      title: 'Repositories at the top, each with its own changelists beneath it',
    },
  ];
}

/** The grouping a click on row `id` picks, or `undefined` when it changes nothing. */
export function applyViewOption(groupBy: CommitGroupBy, id: string): CommitGroupBy | undefined {
  if (id !== 'changelist' && id !== 'repository') return undefined;
  return id === groupBy ? undefined : id;
}

/** IntelliJ's dot on the button, as on the log's Graph Options: the view is not the default one. */
export function viewOptionsChanged(groupBy: CommitGroupBy): boolean {
  return groupBy !== 'changelist';
}
