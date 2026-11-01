import { describe, expect, it } from 'vitest';
import type { LogFilterDto } from '../../../src/shared/protocol';
import {
  applyGraphOption,
  graphOptionsChanged,
  graphOptionsItems,
} from '../../../webview-ui/src/log/graphOptions';

const DEFAULT: LogFilterDto = { sort: 'date', refs: 'HEAD' };

/** The ticked rows' ids, so a test reads as the menu does. */
function ticked(filter: LogFilterDto): string[] {
  return graphOptionsItems(filter)
    .filter((i) => i.kind === 'item' && i.checked)
    .map((i) => i.id);
}

describe('graphOptionsItems (IntelliJ\'s Graph Options menu)', () => {
  it('reads Sort · By Commit Date · Topologically · Options · First Parent · No Merges', () => {
    expect(graphOptionsItems(DEFAULT).map((i) => i.label)).toEqual([
      'Sort',
      'By Commit Date',
      'Topologically',
      'Options',
      'First Parent',
      'No Merges',
    ]);
    expect(graphOptionsItems(DEFAULT).filter((i) => i.kind === 'header')).toHaveLength(2);
  });

  it('ticks the sort the log is in', () => {
    expect(ticked(DEFAULT)).toEqual(['sort:date']);
    expect(ticked({ ...DEFAULT, sort: 'intelli' })).toEqual(['sort:topo']);
  });

  it("ticks Topologically for git's plain topological order too (File History, Compare)", () => {
    expect(ticked({ sort: 'topo', refs: 'ALL', paths: ['a.ts'], follow: true })).toEqual(['sort:topo']);
  });

  it('ticks no sort while First Parent is on: it is the sort\'s alternative, not an addition', () => {
    expect(ticked({ ...DEFAULT, sort: 'intelli', firstParent: true })).toEqual(['firstParent']);
  });

  it('ticks No Merges beside the sort', () => {
    expect(ticked({ ...DEFAULT, noMerges: true })).toEqual(['sort:date', 'noMerges']);
    expect(ticked({ ...DEFAULT, firstParent: true, noMerges: true })).toEqual(['firstParent', 'noMerges']);
  });
});

describe('applyGraphOption', () => {
  it('Topologically picks IntelliSort, By Commit Date picks date order', () => {
    expect(applyGraphOption(DEFAULT, 'sort:topo')).toEqual({ ...DEFAULT, sort: 'intelli' });
    expect(applyGraphOption({ ...DEFAULT, sort: 'intelli' }, 'sort:date')).toEqual(DEFAULT);
  });

  it('changes nothing for the sort already ticked, so the log is not re-run', () => {
    expect(applyGraphOption(DEFAULT, 'sort:date')).toBeUndefined();
    expect(applyGraphOption({ ...DEFAULT, sort: 'intelli' }, 'sort:topo')).toBeUndefined();
    expect(applyGraphOption({ ...DEFAULT, sort: 'topo' }, 'sort:topo')).toBeUndefined();
  });

  it('picking a sort ends First Parent', () => {
    expect(applyGraphOption({ ...DEFAULT, firstParent: true }, 'sort:date')).toEqual(DEFAULT);
    expect(applyGraphOption({ ...DEFAULT, firstParent: true }, 'sort:topo')).toEqual({
      ...DEFAULT,
      sort: 'intelli',
    });
  });

  it("keeps a tab's own topological order when Topologically ends First Parent there", () => {
    const history: LogFilterDto = { sort: 'topo', refs: 'ALL', paths: ['a.ts'], follow: true, firstParent: true };
    const next = applyGraphOption(history, 'sort:topo');
    expect(next?.sort).toBe('topo');
    expect(next?.firstParent).toBeUndefined();
  });

  it('First Parent keeps the sort underneath, so unticking it brings that sort back', () => {
    const on = applyGraphOption({ ...DEFAULT, sort: 'intelli' }, 'firstParent');
    expect(on).toEqual({ ...DEFAULT, sort: 'intelli', firstParent: true });
    const off = applyGraphOption(on!, 'firstParent');
    expect(off).toEqual({ ...DEFAULT, sort: 'intelli' });
    expect(off).not.toHaveProperty('firstParent');
  });

  it('No Merges toggles, leaving the sort and First Parent alone', () => {
    const on = applyGraphOption({ ...DEFAULT, firstParent: true }, 'noMerges');
    expect(on).toEqual({ ...DEFAULT, firstParent: true, noMerges: true });
    const off = applyGraphOption(on!, 'noMerges');
    expect(off).toEqual({ ...DEFAULT, firstParent: true });
    expect(off).not.toHaveProperty('noMerges');
  });

  it('keeps every other filter as it was', () => {
    const busy: LogFilterDto = {
      sort: 'date',
      refs: ['main'],
      authors: ['Ava Tran'],
      text: { q: 'fix', regex: true, matchCase: false },
    };
    expect(applyGraphOption(busy, 'noMerges')).toEqual({ ...busy, noMerges: true });
    expect(applyGraphOption(busy, 'sort:topo')).toEqual({ ...busy, sort: 'intelli' });
  });

  it('ignores the headers and anything else', () => {
    expect(applyGraphOption(DEFAULT, 'sort')).toBeUndefined();
    expect(applyGraphOption(DEFAULT, 'options')).toBeUndefined();
    expect(applyGraphOption(DEFAULT, 'linear')).toBeUndefined();
  });
});

describe('graphOptionsChanged (the dot on the button)', () => {
  it('is off for By Commit Date with no option ticked', () => {
    expect(graphOptionsChanged(DEFAULT)).toBe(false);
    expect(graphOptionsChanged({ ...DEFAULT, firstParent: false, noMerges: false })).toBe(false);
  });

  it('is on for anything else, Topologically alone included', () => {
    expect(graphOptionsChanged({ ...DEFAULT, sort: 'intelli' })).toBe(true);
    expect(graphOptionsChanged({ ...DEFAULT, sort: 'topo' })).toBe(true);
    expect(graphOptionsChanged({ ...DEFAULT, firstParent: true })).toBe(true);
    expect(graphOptionsChanged({ ...DEFAULT, noMerges: true })).toBe(true);
  });
});
