import { describe, expect, it } from 'vitest';
import type { LogTabDto } from '../../../src/shared/protocol';
import {
  MAIN_LOG_TAB,
  afterClose,
  closeTargets,
  comparedRefs,
  shortRef,
  sideLabel,
  stripOrder,
  tabTitle,
} from '../../../webview-ui/src/log/logTabsModel';

describe('tabTitle (IntelliJ titles a Log tab by what it shows)', () => {
  it('is plain Log with nothing filtered', () => {
    expect(tabTitle({ sort: 'date', refs: 'HEAD' })).toBe('Log');
    expect(tabTitle({ sort: 'topo' })).toBe('Log');
  });

  it('names the branch filter unlabelled, as in "Log: 2026.1"', () => {
    expect(tabTitle({ sort: 'date', refs: ['2026.1'] })).toBe('Log: 2026.1');
    expect(tabTitle({ sort: 'date', refs: ['main', 'feature/tags'] })).toBe('Log: main, feature/tags');
    expect(tabTitle({ sort: 'date', refs: 'ALL' })).toBe('Log: All');
  });

  it('calls two branches side by side a comparison, as IntelliJ does', () => {
    expect(tabTitle({ sort: 'topo', range: { a: 'feature/tags', b: 'main' } })).toBe(
      'Compare: feature/tags and main',
    );
  });

  it('reads what an update brought in as a range, with its commit hashes shortened', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(tabTitle({ sort: 'topo', range: { a, b } })).toBe('Log: aaaaaaa...bbbbbbb');
  });

  it('calls one file followed through renames its History', () => {
    expect(
      tabTitle({ sort: 'topo', refs: 'ALL', paths: ['src/utils/strings.ts'], follow: true }),
    ).toBe('History: strings.ts');
  });

  it("reads one filter bare, in IntelliJ's words for its value", () => {
    expect(tabTitle({ sort: 'date', authors: ['Ava Tran', 'Ben Okafor'] })).toBe('Log: Ava Tran, Ben Okafor');
    expect(tabTitle({ sort: 'date', dateRange: { from: '2026-10-01' } })).toBe('Log: since 2026-10-01');
    expect(tabTitle({ sort: 'date', dateRange: { to: '2026-10-31' } })).toBe('Log: until 2026-10-31');
    expect(tabTitle({ sort: 'date', dateRange: { from: '2026-10-01', to: '2026-10-31' } })).toBe(
      'Log: between 2026-10-01 and 2026-10-31',
    );
    // A path filter is named by the files' and folders' own names.
    expect(tabTitle({ sort: 'date', paths: ['src/store.ts', 'docs'] })).toBe('Log: store.ts, docs');
    expect(tabTitle({ sort: 'date', text: { q: 'fix', regex: false, matchCase: false } })).toBe(
      "Log: 'fix'",
    );
    expect(tabTitle({ sort: 'date', noMerges: true })).toBe('Log: --no-merges');
  });

  it('prefixes every filter once there are several, joined by spaces — "Log: on HEAD --no-merges"', () => {
    expect(tabTitle({ sort: 'date', refs: ['HEAD'], noMerges: true })).toBe('Log: on HEAD --no-merges');
    expect(
      tabTitle({
        sort: 'date',
        refs: ['main'],
        authors: ['Ava Tran'],
        dateRange: { from: '2026-10-01' },
        paths: ['src', 'docs'],
        text: { q: 'fix', regex: false, matchCase: false },
        noMerges: true,
      }),
    ).toBe("Log: on main by Ava Tran made since 2026-10-01 for src, docs containing 'fix' --no-merges");
    expect(tabTitle({ sort: 'date', refs: 'ALL', authors: ['Ava Tran'] })).toBe('Log: on All by Ava Tran');
  });

  it('gives a range no prefix among others, as IntelliJ does', () => {
    expect(tabTitle({ sort: 'topo', range: { a: 'feature/tags', b: 'main' }, authors: ['Ava Tran'] })).toBe(
      'Compare: feature/tags and main by Ava Tran',
    );
  });

  it('leaves the sort and First Parent out: they draw the graph, they are not filters', () => {
    expect(tabTitle({ sort: 'intelli', firstParent: true })).toBe('Log');
    expect(tabTitle({ sort: 'intelli', firstParent: true, refs: ['main'] })).toBe('Log: main');
  });

  it("names a file's history History even under No Merges", () => {
    expect(
      tabTitle({ sort: 'topo', refs: 'ALL', paths: ['src/utils/strings.ts'], follow: true, noMerges: true }),
    ).toBe('History: strings.ts');
  });

  it('leaves out an empty search and empty lists', () => {
    expect(
      tabTitle({ sort: 'date', authors: [], paths: [], text: { q: '', regex: true, matchCase: false } }),
    ).toBe('Log');
  });
});

const tab = (id: string): LogTabDto => ({
  id,
  filter: { sort: 'date', refs: 'HEAD' },
  closable: id !== MAIN_LOG_TAB,
});
const TABS = [tab(MAIN_LOG_TAB), tab('log-1'), tab('log-4')];

describe('stripOrder', () => {
  it('puts Console and Worktrees right after the main tab, then the extra Log tabs', () => {
    expect(stripOrder(TABS)).toEqual([MAIN_LOG_TAB, 'console', 'worktrees', 'log-1', 'log-4']);
  });
});

describe('afterClose', () => {
  const order = stripOrder(TABS);

  it('keeps the tab in front when another one closes', () => {
    expect(afterClose(order, MAIN_LOG_TAB, ['log-1'])).toBe(MAIN_LOG_TAB);
  });

  it('moves to the nearest tab on the left when the one in front closes', () => {
    expect(afterClose(order, 'log-4', ['log-4'])).toBe('log-1');
    expect(afterClose(order, 'log-1', ['log-1'])).toBe('worktrees');
    expect(afterClose(order, 'log-4', ['log-1', 'log-4'])).toBe('worktrees');
  });
});

describe('closeTargets (Close Tab / Close Other Tabs / Close All Tabs)', () => {
  it('closes only the clicked tab, and only if it can close', () => {
    expect(closeTargets(TABS, 'log-1', 'close')).toEqual(['log-1']);
    expect(closeTargets(TABS, MAIN_LOG_TAB, 'close')).toEqual([]);
    expect(closeTargets(TABS, 'console', 'close')).toEqual([]);
  });

  it('closes every other extra tab', () => {
    expect(closeTargets(TABS, 'log-1', 'others')).toEqual(['log-4']);
    expect(closeTargets(TABS, MAIN_LOG_TAB, 'others')).toEqual(['log-1', 'log-4']);
  });

  it('closes every extra tab, never the main one', () => {
    expect(closeTargets(TABS, 'log-4', 'all')).toEqual(['log-1', 'log-4']);
    expect(closeTargets([tab(MAIN_LOG_TAB)], MAIN_LOG_TAB, 'all')).toEqual([]);
  });
});

describe('the line above a comparison', () => {
  it('is for two named sides', () => {
    const range = { a: 'feature/tags', b: 'main' };
    expect(comparedRefs({ sort: 'topo', range })).toEqual(range);
    // A detached checkout compares a branch with HEAD: still two sides.
    expect(comparedRefs({ sort: 'topo', range: { a: 'main', b: 'HEAD' } })).toEqual({ a: 'main', b: 'HEAD' });
  });

  it('is not for the commits an update brought in, or a log with no range', () => {
    expect(comparedRefs({ sort: 'topo', range: { a: 'a'.repeat(40), b: 'b'.repeat(40) } })).toBeUndefined();
    expect(comparedRefs({ sort: 'date', refs: 'HEAD' })).toBeUndefined();
  });

  it('counts the commits only one side has', () => {
    expect(sideLabel(2)).toBe('2 commits only on');
    expect(sideLabel(1)).toBe('1 commit only on');
    expect(sideLabel(0)).toBe('0 commits only on');
  });

  it('still says what the mark means with no count', () => {
    expect(sideLabel(undefined)).toBe('Only on');
  });

  it('names a branch whole, and a commit by the start of its hash', () => {
    expect(shortRef('feature/tags')).toBe('feature/tags');
    expect(shortRef('a'.repeat(40))).toBe('aaaaaaa');
  });
});
