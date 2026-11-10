import { describe, expect, it } from 'vitest';
import type { LogFilter } from '../../../src/log/logFilter';
import {
  MAIN_LOG_TAB,
  activateTab,
  closeTabs,
  findTab,
  initialTabsState,
  isClosable,
  openTab,
  restoreTabsState,
  sameView,
  updateTab,
  type LogTabRecord,
} from '../../../src/log/logTabs';

const HEAD: LogFilter = { sort: 'date', refs: 'HEAD' };
const HISTORY: LogFilter = { sort: 'topo', refs: 'ALL', paths: ['src/store.ts'], follow: true };
const COMPARE: LogFilter = { sort: 'topo', range: { a: 'feature/tags', b: 'main' } };

const sameRoot = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

describe('openTab (the strip\'s +, File History, Compare)', () => {
  it('appends a tab after the others and makes it the active one', () => {
    const first = openTab(initialTabsState(), HEAD, '/repo');
    expect(first.id).toBe('log-1');
    const second = openTab(first.state, HISTORY, '/repo');
    expect(second.id).toBe('log-2');
    expect(second.state.tabs.map((t) => t.id)).toEqual([MAIN_LOG_TAB, 'log-1', 'log-2']);
    expect(second.state.active).toBe('log-2');
  });

  it('keeps what the new tab shows and in which repository', () => {
    const { state, id } = openTab(initialTabsState(), COMPARE, '/repo-b');
    expect(state.tabs.find((t) => t.id === id)).toEqual({ id, filter: COMPARE, root: '/repo-b' });
  });

  it('never reuses an id, even after the tab closed', () => {
    const opened = openTab(initialTabsState(), HEAD, '/repo');
    const closed = closeTabs(opened.state, [opened.id]);
    expect(openTab(closed, HEAD, '/repo').id).toBe('log-2');
  });
});

describe('closeTabs', () => {
  const three = openTab(openTab(initialTabsState(), HEAD, '/r').state, HISTORY, '/r').state;

  it('closes the extra tabs it is given', () => {
    expect(closeTabs(three, ['log-1']).tabs.map((t) => t.id)).toEqual([MAIN_LOG_TAB, 'log-2']);
  });

  it('never closes the main tab', () => {
    expect(isClosable(MAIN_LOG_TAB)).toBe(false);
    expect(closeTabs(three, [MAIN_LOG_TAB, 'log-1', 'log-2']).tabs.map((t) => t.id)).toEqual([
      MAIN_LOG_TAB,
    ]);
    expect(closeTabs(three, [MAIN_LOG_TAB])).toBe(three);
  });

  it('falls back to the main tab when the active one closes', () => {
    expect(three.active).toBe('log-2');
    expect(closeTabs(three, ['log-2']).active).toBe(MAIN_LOG_TAB);
    expect(closeTabs(three, ['log-1']).active).toBe('log-2');
  });
});

describe('activateTab', () => {
  it('moves the active tab to one that exists, and ignores one that does not', () => {
    const { state } = openTab(initialTabsState(), HEAD, '/r');
    expect(activateTab(state, MAIN_LOG_TAB).active).toBe(MAIN_LOG_TAB);
    expect(activateTab(state, 'log-99')).toBe(state);
    expect(activateTab(state, 'log-1')).toBe(state);
  });
});

describe('updateTab', () => {
  it('records a tab\'s new filter', () => {
    const { state, id } = openTab(initialTabsState(), HEAD, '/r');
    expect(updateTab(state, id, HISTORY, undefined).tabs[1]).toEqual({ id, filter: HISTORY, root: '/r' });
  });

  it('moves an extra tab to another repository, never the main one', () => {
    const { state, id } = openTab(initialTabsState(), HEAD, '/r');
    expect(updateTab(state, id, HEAD, '/other').tabs[1]?.root).toBe('/other');
    // The main tab's repository is remembered elsewhere (`gittree.log.root`).
    expect(updateTab(state, MAIN_LOG_TAB, HEAD, '/other').tabs[0]).toEqual({ id: MAIN_LOG_TAB, filter: HEAD });
  });
});

describe('sameView', () => {
  it('ignores the sort: it orders the commits, it does not choose them', () => {
    expect(sameView(HISTORY, { ...HISTORY, sort: 'date' })).toBe(true);
  });

  it('treats empty lists, an empty search and an absent ref filter as nothing set', () => {
    expect(sameView(HEAD, { sort: 'topo' })).toBe(true);
    expect(sameView(HEAD, { ...HEAD, authors: [], paths: [], text: { q: '', regex: false, matchCase: false } })).toBe(true);
  });

  it('tells different views apart', () => {
    expect(sameView(HISTORY, { ...HISTORY, paths: ['src/cli.ts'] })).toBe(false);
    expect(sameView(HISTORY, { ...HISTORY, follow: false })).toBe(false);
    expect(sameView(COMPARE, { ...COMPARE, range: { a: 'main', b: 'feature/tags' } })).toBe(false);
  });

  it('counts First Parent and No Merges, which choose commits, and reads false as off', () => {
    expect(sameView(HEAD, { ...HEAD, firstParent: true })).toBe(false);
    expect(sameView(HEAD, { ...HEAD, noMerges: true })).toBe(false);
    expect(sameView(HEAD, { ...HEAD, firstParent: false, noMerges: false })).toBe(true);
  });
});

describe('findTab (running File History twice lands on one tab)', () => {
  const opened = openTab(initialTabsState(), HISTORY, '/Repo').state;
  const rootOf = (tab: LogTabRecord): string | undefined => (tab.id === MAIN_LOG_TAB ? '/main-repo' : tab.root);

  it('finds the tab showing the same thing in the same repository', () => {
    expect(findTab(opened, { ...HISTORY, sort: 'date' }, '/repo', rootOf, sameRoot)).toBe('log-1');
  });

  it('does not take a tab from another repository', () => {
    expect(findTab(opened, HISTORY, '/elsewhere', rootOf, sameRoot)).toBeUndefined();
  });

  it('can land on the main tab when it already shows exactly that', () => {
    expect(findTab(opened, HEAD, '/main-repo', rootOf, sameRoot)).toBe(MAIN_LOG_TAB);
  });

  it('asked for a new tab, passes over the main tab but still finds an extra one', () => {
    const atHead: LogFilter = { sort: 'date', refs: 'HEAD' };
    const mainOnly = initialTabsState(atHead);
    const rootOfMain = (tab: LogTabRecord): string | undefined => (tab.id === MAIN_LOG_TAB ? '/repo' : tab.root);
    expect(findTab(mainOnly, atHead, '/repo', rootOfMain, sameRoot)).toBe(MAIN_LOG_TAB);
    expect(findTab(mainOnly, atHead, '/repo', rootOfMain, sameRoot, { skipMain: true })).toBeUndefined();
    const withExtra = openTab(mainOnly, atHead, '/repo').state;
    expect(findTab(withExtra, atHead, '/repo', rootOfMain, sameRoot, { skipMain: true })).toBe('log-1');
  });

  it('finds nothing for a view no tab shows', () => {
    expect(findTab(opened, COMPARE, '/repo', rootOf, sameRoot)).toBeUndefined();
  });
});

describe('restoreTabsState (lazy restore after a restart)', () => {
  it('starts with the main tab alone when nothing was stored', () => {
    expect(restoreTabsState(undefined)).toEqual({
      tabs: [{ id: MAIN_LOG_TAB, filter: { refs: 'HEAD', sort: 'date' } }],
      active: MAIN_LOG_TAB,
      next: 1,
    });
  });

  it('seeds the main tab from the single log\'s old filter, once', () => {
    const legacy: LogFilter = { sort: 'topo', refs: ['main'] };
    expect(restoreTabsState(undefined, legacy).tabs[0]?.filter).toEqual(legacy);
  });

  it('brings back every tab, in order, with the one that was active', () => {
    const stored = {
      tabs: [
        { id: MAIN_LOG_TAB, filter: HEAD },
        { id: 'log-3', filter: HISTORY, root: '/r' },
        { id: 'log-5', filter: COMPARE, root: '/r' },
      ],
      active: 'log-5',
      next: 6,
    };
    expect(restoreTabsState(stored)).toEqual(stored);
  });

  it('drops malformed entries instead of losing the whole list', () => {
    const restored = restoreTabsState({
      tabs: [
        { id: 'log-1', filter: { sort: 'sideways' } },
        { id: 'log-2', filter: HEAD, root: '/r' },
        { id: 'log-2', filter: HISTORY, root: '/r' },
        { id: 'console', filter: HEAD },
        { id: 'log-4', filter: { sort: 'date', refs: [1, 2] } },
        { id: 'log-6', filter: { sort: 'date', range: { a: 'x' } } },
        null,
        'log-7',
      ],
      active: 'log-1',
      next: 'soon',
    });
    // The main tab is put back first even though it was not stored.
    expect(restored.tabs.map((t) => t.id)).toEqual([MAIN_LOG_TAB, 'log-2']);
    expect(restored.tabs[1]?.filter).toEqual(HEAD);
    // The stored active tab did not survive, so the main tab is active.
    expect(restored.active).toBe(MAIN_LOG_TAB);
    expect(restored.next).toBe(3);
  });

  it('brings back the Graph Options a tab had, and drops a tab whose are malformed', () => {
    const withOptions: LogFilter = { ...HEAD, sort: 'intelli', firstParent: true, noMerges: true };
    const restored = restoreTabsState({
      tabs: [
        { id: MAIN_LOG_TAB, filter: withOptions },
        { id: 'log-1', filter: { ...HEAD, firstParent: 'yes' }, root: '/r' },
        { id: 'log-2', filter: { ...HEAD, noMerges: 1 }, root: '/r' },
      ],
      active: MAIN_LOG_TAB,
      next: 3,
    });
    expect(restored.tabs.map((t) => t.id)).toEqual([MAIN_LOG_TAB]);
    expect(restored.tabs[0]?.filter).toEqual(withOptions);
  });

  it('moves the main tab to the front and drops a root it should not have', () => {
    const restored = restoreTabsState({
      tabs: [
        { id: 'log-1', filter: HISTORY, root: '/r' },
        { id: MAIN_LOG_TAB, filter: HEAD, root: '/ignored' },
      ],
      active: MAIN_LOG_TAB,
      next: 2,
    });
    expect(restored.tabs).toEqual([
      { id: MAIN_LOG_TAB, filter: HEAD },
      { id: 'log-1', filter: HISTORY, root: '/r' },
    ]);
  });

  it('never hands out an id below one already in use', () => {
    expect(restoreTabsState({ tabs: [{ id: 'log-9', filter: HEAD }], active: 'log-9', next: 2 }).next).toBe(10);
  });

  it('ignores anything that is not a stored list', () => {
    expect(restoreTabsState('tabs').tabs).toHaveLength(1);
    expect(restoreTabsState({ tabs: 'none' }).tabs).toHaveLength(1);
    expect(restoreTabsState(null).active).toBe(MAIN_LOG_TAB);
  });
});
