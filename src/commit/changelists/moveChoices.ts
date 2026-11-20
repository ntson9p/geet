/**
 * Move to Another Changelist…'s choices (IntelliJ's `ChangeListChooser` in
 * `MoveChangesToAnotherListAction`), for files that may span several
 * repositories. Geet keeps a changelist per repository (D23) and the
 * Commit window merges them by name, the default list by being the default;
 * the picker merges the same way, so one choice is one row of the tree.
 * Free of `vscode`, so the merging is unit-tested.
 */

export interface ListLike {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Where a file sits that is in no list: the Unversioned Files bucket. */
export const UNVERSIONED_KEY = '@unversioned';

/** The key two repositories' copies of one changelist share: the tree's merge rule. */
export function listKeyOf(list: Pick<ListLike, 'name' | 'isDefault'>): string {
  return list.isDefault ? '@default' : `name:${list.name}`;
}

export interface MoveChoice {
  readonly key: string;
  /** The first repository's name for it, as the tree's row shows it. */
  readonly label: string;
}

export interface MoveSource {
  readonly lists: readonly ListLike[];
  /** The keys of where the files sit now: `listKeyOf`, or `UNVERSIONED_KEY`. */
  readonly fromKeys: ReadonlySet<string>;
}

/**
 * The lists to offer: the default first, the others in the order they first
 * appear. As IntelliJ's chooser does, the one list every file already sits in
 * is left out, since moving them there would change nothing — even when it is
 * the only list (POST-QA): it used to stay on offer, first and focused, so
 * Enter moved the files nowhere. The picker's New changelist… is then the
 * one choice, which is what moving out of the only list means.
 */
export function moveChoices(sources: readonly MoveSource[]): MoveChoice[] {
  const byKey = new Map<string, MoveChoice>();
  let defaultChoice: MoveChoice | undefined;
  for (const source of sources) {
    for (const list of source.lists) {
      const key = listKeyOf(list);
      if (byKey.has(key)) continue;
      const choice = { key, label: list.name };
      byKey.set(key, choice);
      if (list.isDefault) defaultChoice ??= choice;
    }
  }
  const from = new Set(sources.flatMap((s) => [...s.fromKeys]));
  const only = from.size === 1 ? [...from][0] : undefined;
  const ordered = [
    ...(defaultChoice !== undefined ? [defaultChoice] : []),
    ...[...byKey.values()].filter((c) => c !== defaultChoice),
  ];
  return ordered.filter((c) => c.key !== only);
}

/** A repository's list for a choice; `undefined` when it has no copy of it yet. */
export function listIdFor(lists: readonly ListLike[], key: string): string | undefined {
  return lists.find((l) => listKeyOf(l) === key)?.id;
}

/**
 * Splits a long path list so one git call stays under Windows' command-line
 * limit: a repository's every unversioned file can run to thousands.
 */
export function chunked<T>(items: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
