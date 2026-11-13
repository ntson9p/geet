import { describe, expect, it } from 'vitest';
import {
  applyViewOption,
  viewOptionsChanged,
  viewOptionsItems,
  type ViewOptionRow,
} from '../../../webview-ui/src/commit/viewOptions';

const items = (rows: ViewOptionRow[]) => rows.flatMap((r) => (r.kind === 'item' ? [r] : []));

describe("the Commit window's View Options › Group By (D37, D44)", () => {
  it('starts with neither changelists nor folders: every file under its repository, in one list (POST-P14cb)', () => {
    const rows = viewOptionsItems({ groupBy: 'none', directory: false, multiRepo: false });
    expect(rows).toEqual([
      { kind: 'header', id: 'groupBy', label: 'Group By' },
      expect.objectContaining({ kind: 'item', id: 'changelist', label: 'Changelist', checked: false }),
      expect.objectContaining({ kind: 'item', id: 'directory', label: 'Directory', checked: false }),
    ]);
    // Toggles, as IntelliJ's Group By has them, not a run of radio items.
    for (const row of items(rows)) expect(row.radio).toBeUndefined();
  });

  it('ticks what is shown', () => {
    const rows = items(viewOptionsItems({ groupBy: 'repository', directory: true, multiRepo: false }));
    expect(rows.filter((r) => r.checked).map((r) => r.id)).toEqual(['changelist', 'directory']);
  });

  it('with several repositories, offers the order of changelists and repositories, greyed out while changelists are off', () => {
    const off = viewOptionsItems({ groupBy: 'none', directory: false, multiRepo: true });
    expect(off.map((r) => r.id)).toEqual([
      'groupBy',
      'changelist',
      'directory',
      'order',
      'withChangelists',
      'order:changelist',
      'order:repository',
    ]);
    const orders = items(off).filter((r) => r.radio === true);
    expect(orders.map((r) => [r.label, r.checked, r.disabled])).toEqual([
      ['Changelist › Repository', false, true],
      ['Repository › Changelist', false, true],
    ]);

    const on = items(viewOptionsItems({ groupBy: 'repository', directory: false, multiRepo: true }));
    expect(on.filter((r) => r.radio === true).map((r) => [r.id, r.checked, r.disabled])).toEqual([
      ['order:changelist', false, undefined],
      ['order:repository', true, undefined],
    ]);
  });

  it('says on hover what each choice does', () => {
    const titles = items(viewOptionsItems({ groupBy: 'changelist', directory: false, multiRepo: true })).map(
      (r) => r.title,
    );
    expect(titles).toEqual([
      "Changelist rows, each with its files beneath. Off: every file under its repository, as VS Code's Source Control view lists them",
      'Folder rows over the files. Off: one list, each file naming its folder',
      "Changelists at the top, each repository's share of a list beneath it",
      'Repositories at the top, each with its own changelists beneath it',
    ]);
  });

  it('Changelist turns changelists on, changelists first, and off again', () => {
    expect(applyViewOption({ groupBy: 'none', directory: false }, 'changelist')).toEqual({ groupBy: 'changelist' });
    expect(applyViewOption({ groupBy: 'changelist', directory: false }, 'changelist')).toEqual({ groupBy: 'none' });
    expect(applyViewOption({ groupBy: 'repository', directory: true }, 'changelist')).toEqual({ groupBy: 'none' });
  });

  it('Directory turns the folder rows on and off, whatever the grouping', () => {
    expect(applyViewOption({ groupBy: 'none', directory: false }, 'directory')).toEqual({ directory: true });
    expect(applyViewOption({ groupBy: 'changelist', directory: true }, 'directory')).toEqual({ directory: false });
  });

  it('picks the other order; the one shown, an order while changelists are off, and a caption change nothing', () => {
    expect(applyViewOption({ groupBy: 'changelist', directory: false }, 'order:repository')).toEqual({
      groupBy: 'repository',
    });
    expect(applyViewOption({ groupBy: 'repository', directory: false }, 'order:changelist')).toEqual({
      groupBy: 'changelist',
    });
    expect(applyViewOption({ groupBy: 'changelist', directory: false }, 'order:changelist')).toBeUndefined();
    expect(applyViewOption({ groupBy: 'none', directory: false }, 'order:repository')).toBeUndefined();
    expect(applyViewOption({ groupBy: 'none', directory: false }, 'groupBy')).toBeUndefined();
    expect(applyViewOption({ groupBy: 'none', directory: false }, 'constructor')).toBeUndefined();
  });

  it("shows IntelliJ's dot only off the defaults", () => {
    expect(viewOptionsChanged({ groupBy: 'none', directory: false })).toBe(false);
    expect(viewOptionsChanged({ groupBy: 'changelist', directory: false })).toBe(true);
    expect(viewOptionsChanged({ groupBy: 'repository', directory: false })).toBe(true);
    expect(viewOptionsChanged({ groupBy: 'none', directory: true })).toBe(true);
  });
});
