/**
 * Graph Options, the button after `Paths ▾` (IntelliJ's
 * `Vcs.Log.GraphOptionsGroup`): a `Sort` group — By Commit Date,
 * Topologically — then an `Options` group — First Parent, No Merges. Pure, so
 * what each row ticks and what a click changes are testable without a page.
 */
import type { LogFilterDto } from '../../../src/shared/protocol';

type SortRow = 'date' | 'topo';

/**
 * A row of the menu: the two shapes of `Menu`'s `MenuItem` it uses, spelled
 * out here so this module stays free of React and testable in plain Node.
 */
export type GraphOptionRow =
  | { readonly kind: 'header'; readonly id: string; readonly label: string }
  | { readonly kind: 'item'; readonly id: string; readonly label: string; readonly checked: boolean };

/**
 * Which Sort row is ticked. None while First Parent is on: IntelliJ makes it a
 * graph mode in the sort's place, not a toggle beside it.
 *
 * IntelliJ's Topologically is its IntelliSort ("in case of merge, show
 * incoming commits first, directly below merge commit"). git's plain
 * topological order, which File History, Compare with Current and older saved
 * filters carry, is topological too, so it ticks the same row.
 */
function sortRow(filter: LogFilterDto): SortRow | undefined {
  if (filter.firstParent === true) return undefined;
  return filter.sort === 'date' ? 'date' : 'topo';
}

export function graphOptionsItems(filter: LogFilterDto): GraphOptionRow[] {
  const sort = sortRow(filter);
  return [
    { kind: 'header', id: 'sort', label: 'Sort' },
    { kind: 'item', id: 'sort:date', label: 'By Commit Date', checked: sort === 'date' },
    { kind: 'item', id: 'sort:topo', label: 'Topologically', checked: sort === 'topo' },
    { kind: 'header', id: 'options', label: 'Options' },
    { kind: 'item', id: 'firstParent', label: 'First Parent', checked: filter.firstParent === true },
    { kind: 'item', id: 'noMerges', label: 'No Merges', checked: filter.noMerges === true },
  ];
}

/**
 * The filter a click on menu row `id` makes, or `undefined` when it changes
 * nothing — every change re-runs the log, so a click on the row that is
 * already ticked must not.
 *
 * Picking a sort ends First Parent, the other half of IntelliJ's one choice.
 * Ticking First Parent keeps the sort underneath, so unticking it brings that
 * sort back rather than a default.
 */
export function applyGraphOption(filter: LogFilterDto, id: string): LogFilterDto | undefined {
  switch (id) {
    case 'sort:date':
    case 'sort:topo': {
      const row: SortRow = id === 'sort:date' ? 'date' : 'topo';
      if (sortRow(filter) === row) return undefined;
      const next: LogFilterDto = {
        ...filter,
        // A topological sort already stored (git's own, from File History) is
        // what this row means for that tab; anything else gets IntelliSort.
        sort: row === 'date' ? 'date' : filter.sort === 'date' ? 'intelli' : filter.sort,
      };
      delete next.firstParent;
      return next;
    }
    case 'firstParent':
    case 'noMerges': {
      const next: LogFilterDto = { ...filter };
      if (filter[id] === true) delete next[id];
      else next[id] = true;
      return next;
    }
    default:
      return undefined;
  }
}

/**
 * IntelliJ's dot on the button: shown whenever the graph is not the default
 * one — By Commit Date with no option ticked.
 */
export function graphOptionsChanged(filter: LogFilterDto): boolean {
  return filter.sort !== 'date' || filter.firstParent === true || filter.noMerges === true;
}
