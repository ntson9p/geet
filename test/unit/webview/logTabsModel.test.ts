import { describe, expect, it } from 'vitest';
import type { LogTabDto } from '../../../src/shared/protocol';
import {
  MAIN_LOG_TAB,
  afterClose,
  closeTargets,
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

  it('reads a range as a range, with commit hashes shortened', () => {
    expect(tabTitle({ sort: 'topo', range: { a: 'feature/tags', b: 'main' } })).toBe(
      'Log: feature/tags...main',
    );
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(tabTitle({ sort: 'topo', range: { a, b } })).toBe('Log: aaaaaaa...bbbbbbb');
  });

  it('calls one file followed through renames its History', () => {
    expect(
      tabTitle({ sort: 'topo', refs: 'ALL', paths: ['src/utils/strings.ts'], follow: true }),
    ).toBe('History: strings.ts');
  });

  it('labels the other filters, after the branch', () => {
    expect(
      tabTitle({
        sort: 'date',
        refs: ['main'],
        authors: ['Ava Tran'],
        dateRange: { from: '2026-10-01' },
        paths: ['src', 'docs'],
        text: { q: 'fix', regex: false, matchCase: false },
      }),
    ).toBe('Log: main, User: Ava Tran, Date: 2026-10-01 → …, Paths: src, docs, Text: fix');
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
