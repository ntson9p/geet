/**
 * View Options, the eye in the Commit tab's toolbar (IntelliJ's
 * `ChangesView.ViewOptions`): its `Group By` section.
 *
 * POST-P14cb: two toggles, as IntelliJ's Group By has toggles. **Changelist**:
 * changelist rows with their files beneath; off by default, so every file is
 * listed under its repository as VS Code's Source Control view lists it (D44).
 * **Directory**: folder rows over the files; off by default, one list. With
 * several repositories and changelists shown, which come first, changelists or
 * repositories (D37), greyed out while changelists are off. Pure, so what each
 * row ticks and what a click changes are testable without a page.
 */
import type { CommitGroupBy } from '../../../src/shared/protocol';

/** What the menu shows the state of. */
export interface ViewOptionsState {
  /** `gittree.commit.groupBy` as set: `none` is changelists off. */
  readonly groupBy: CommitGroupBy;
  /** `gittree.commit.groupByDirectory`: folder rows. */
  readonly directory: boolean;
  /** Several repositories, where the order of changelists and repositories means something. */
  readonly multiRepo: boolean;
}

/** A row of the menu, in the shape of `Menu`'s `MenuItem`, spelled out so this module stays free of React. */
export type ViewOptionRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'separator'; readonly id: string }
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      readonly checked: boolean;
      readonly radio?: true;
      readonly disabled?: boolean;
      readonly title: string;
    };

export function viewOptionsItems(state: ViewOptionsState): ViewOptionRow[] {
  const changelists = state.groupBy !== 'none';
  const off = changelists ? {} : { disabled: true };
  return [
    { kind: 'header', id: 'groupBy', label: 'Group By' },
    {
      kind: 'item',
      id: 'changelist',
      label: 'Changelist',
      checked: changelists,
      title: "Changelist rows, each with its files beneath. Off: every file under its repository, as VS Code's Source Control view lists them",
    },
    {
      kind: 'item',
      id: 'directory',
      label: 'Directory',
      checked: state.directory,
      title: 'Folder rows over the files. Off: one list, each file naming its folder',
    },
    ...(state.multiRepo
      ? ([
          { kind: 'separator', id: 'order' },
          { kind: 'header', id: 'withChangelists', label: 'With Changelists' },
          {
            kind: 'item',
            id: 'order:changelist',
            label: 'Changelist › Repository',
            checked: state.groupBy === 'changelist',
            radio: true,
            ...off,
            title: "Changelists at the top, each repository's share of a list beneath it",
          },
          {
            kind: 'item',
            id: 'order:repository',
            label: 'Repository › Changelist',
            checked: state.groupBy === 'repository',
            radio: true,
            ...off,
            title: 'Repositories at the top, each with its own changelists beneath it',
          },
        ] satisfies ViewOptionRow[])
      : []),
  ];
}

/** What a click changes: the grouping, the folder rows, or neither. */
export interface ViewOptionChange {
  readonly groupBy?: CommitGroupBy;
  readonly directory?: boolean;
}

/** The change a click on row `id` makes, or `undefined` when it changes nothing. */
export function applyViewOption(
  state: Pick<ViewOptionsState, 'groupBy' | 'directory'>,
  id: string,
): ViewOptionChange | undefined {
  switch (id) {
    case 'changelist':
      // On, in IntelliJ's order: changelists first.
      return { groupBy: state.groupBy === 'none' ? 'changelist' : 'none' };
    case 'directory':
      return { directory: !state.directory };
    case 'order:changelist':
    case 'order:repository': {
      const next: CommitGroupBy = id === 'order:changelist' ? 'changelist' : 'repository';
      // Greyed out without changelists; the order shown changes nothing.
      return state.groupBy === 'none' || state.groupBy === next ? undefined : { groupBy: next };
    }
    default:
      return undefined;
  }
}

/** IntelliJ's dot on the button, as on the log's Graph Options: the view is not the default one. */
export function viewOptionsChanged(state: Pick<ViewOptionsState, 'groupBy' | 'directory'>): boolean {
  return state.groupBy !== 'none' || state.directory;
}
