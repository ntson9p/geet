import { describe, expect, it } from 'vitest';
import {
  applyViewOption,
  viewOptionsChanged,
  viewOptionsItems,
} from '../../../webview-ui/src/commit/viewOptions';

describe("the Commit window's View Options › Group By (D37)", () => {
  it("ticks the grouping shown, under IntelliJ's Group By caption, as radio items", () => {
    expect(viewOptionsItems('changelist')).toEqual([
      { kind: 'header', id: 'groupBy', label: 'Group By' },
      expect.objectContaining({ id: 'changelist', label: 'Changelist › Repository', checked: true, radio: true }),
      expect.objectContaining({ id: 'repository', label: 'Repository › Changelist', checked: false, radio: true }),
    ]);
    const byRepo = viewOptionsItems('repository');
    expect(byRepo.filter((r) => r.kind === 'item' && r.checked).map((r) => r.id)).toEqual(['repository']);
  });

  it('says on hover what each grouping puts at the top', () => {
    const titles = viewOptionsItems('changelist').flatMap((r) => (r.kind === 'item' ? [r.title] : []));
    expect(titles).toEqual([
      "Changelists at the top, each repository's share of a list beneath it",
      'Repositories at the top, each with its own changelists beneath it',
    ]);
  });

  it('picks the other grouping, and the one shown changes nothing', () => {
    expect(applyViewOption('changelist', 'repository')).toBe('repository');
    expect(applyViewOption('repository', 'changelist')).toBe('changelist');
    expect(applyViewOption('changelist', 'changelist')).toBeUndefined();
    expect(applyViewOption('repository', 'repository')).toBeUndefined();
    // The caption is not a choice.
    expect(applyViewOption('changelist', 'groupBy')).toBeUndefined();
  });

  it("shows IntelliJ's dot only off the default grouping", () => {
    expect(viewOptionsChanged('changelist')).toBe(false);
    expect(viewOptionsChanged('repository')).toBe(true);
  });
});
