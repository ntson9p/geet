import { describe, expect, it } from 'vitest';
import {
  buildLogArgs,
  filterKey,
  isUnfiltered,
  DEFAULT_FILTER,
  type LogFilter,
} from '../../../src/log/logFilter';

const FMT = 'FMT';
const PAGE = { skip: 0, maxCount: 2000 };

function args(f: Partial<LogFilter>): string[] {
  return buildLogArgs({ ...DEFAULT_FILTER, ...f }, FMT, PAGE);
}

describe('buildLogArgs', () => {
  it('default filter: HEAD history, topo order, paging', () => {
    expect(args({})).toEqual([
      'log',
      `--format=${FMT}`,
      '--parents',
      '--topo-order',
      '--skip=0',
      '--max-count=2000',
    ]);
  });

  it('sort modes map to git orderings (intelli reorders client-side over topo)', () => {
    expect(args({ sort: 'date' })).toContain('--date-order');
    expect(args({ sort: 'topo' })).toContain('--topo-order');
    expect(args({ sort: 'intelli' })).toContain('--topo-order');
  });

  it('refs: ALL → --all; list → refs; HEAD → nothing', () => {
    expect(args({ refs: 'ALL' })).toContain('--all');
    const withRefs = args({ refs: ['main', 'feature/x'] });
    expect(withRefs).toContain('main');
    expect(withRefs).toContain('feature/x');
    expect(withRefs).not.toContain('--all');
    expect(args({ refs: 'HEAD' })).not.toContain('--all');
  });

  it('range mode wins over refs and adds --left-right', () => {
    const a = args({ range: { a: 'feature', b: 'main' }, refs: 'ALL' });
    expect(a).toContain('--left-right');
    expect(a).toContain('feature...main');
    expect(a).not.toContain('--all');
  });

  it('authors repeat --author (OR within, intersects across kinds)', () => {
    const a = args({ authors: ['Alice', 'bob@x.dev'] });
    expect(a).toContain('--author=Alice');
    expect(a).toContain('--author=bob@x.dev');
  });

  it('date range maps to --since/--until', () => {
    const a = args({ dateRange: { from: '2026-01-01', to: '2026-02-01' } });
    expect(a).toContain('--since=2026-01-01');
    expect(a).toContain('--until=2026-02-01');
    expect(args({ dateRange: { from: '2026-01-01' } })).not.toContain('--until=undefined');
  });

  it('text search: literal vs regex, case toggles', () => {
    const literal = args({ text: { q: 'fix bug', regex: false, matchCase: false } });
    expect(literal).toContain('--grep=fix bug');
    expect(literal).toContain('-i');
    expect(literal).toContain('--fixed-strings');

    const rx = args({ text: { q: 'fix(es)?', regex: true, matchCase: true } });
    expect(rx).toContain('--extended-regexp');
    expect(rx).not.toContain('-i');

    // P12-T5 acceptance: EVERY regex/match-case combination.
    const rxNoCase = args({ text: { q: 'x', regex: true, matchCase: false } });
    expect(rxNoCase).toContain('--extended-regexp');
    expect(rxNoCase).toContain('-i');

    const literalCase = args({ text: { q: 'x', regex: false, matchCase: true } });
    expect(literalCase).toContain('--fixed-strings');
    expect(literalCase).not.toContain('-i');
  });

  it('paths go after --, with --follow only in single-path follow mode', () => {
    const a = args({ paths: ['src/a.ts', 'docs'] });
    const sep = a.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(a.slice(sep + 1)).toEqual(['src/a.ts', 'docs']);
    expect(a).not.toContain('--follow');

    const follow = args({ paths: ['src/a.ts'], follow: true });
    expect(follow).toContain('--follow');
    const noFollow = args({ paths: ['a', 'b'], follow: true });
    expect(noFollow).not.toContain('--follow');
  });

  it('intersecting filter combines every kind', () => {
    const a = args({
      refs: ['main'],
      authors: ['Alice'],
      dateRange: { from: '2026-01-01' },
      paths: ['src'],
      text: { q: 'refactor', regex: false, matchCase: false },
    });
    for (const expected of ['main', '--author=Alice', '--since=2026-01-01', '--grep=refactor', '--']) {
      expect(a).toContain(expected);
    }
    // paging stays before the pathspec separator
    expect(a.indexOf('--skip=0')).toBeLessThan(a.indexOf('--'));
  });

  it('paging arguments reflect the page', () => {
    const a = buildLogArgs(DEFAULT_FILTER, FMT, { skip: 4000, maxCount: 2000 });
    expect(a).toContain('--skip=4000');
    expect(a).toContain('--max-count=2000');
  });
});

describe('filterKey', () => {
  it('is order-insensitive for sets and stable', () => {
    expect(filterKey({ sort: 'topo', refs: ['b', 'a'], authors: ['y', 'x'] })).toBe(
      filterKey({ sort: 'topo', refs: ['a', 'b'], authors: ['x', 'y'] }),
    );
  });

  it('distinguishes different filters', () => {
    expect(filterKey({ sort: 'topo' })).not.toBe(filterKey({ sort: 'date' }));
    expect(filterKey({ sort: 'topo', refs: 'ALL' })).not.toBe(filterKey({ sort: 'topo', refs: 'HEAD' }));
    expect(filterKey({ sort: 'topo', text: { q: 'a', regex: false, matchCase: false } })).not.toBe(
      filterKey({ sort: 'topo', text: { q: 'a', regex: true, matchCase: false } }),
    );
  });

  it('treats undefined refs as HEAD', () => {
    expect(filterKey({ sort: 'topo' })).toBe(filterKey({ sort: 'topo', refs: 'HEAD' }));
  });
});

describe('isUnfiltered', () => {
  const all: LogFilter = { refs: 'ALL', sort: 'topo' };

  it('only `refs: ALL` with no predicates hides nothing', () => {
    expect(isUnfiltered(all)).toBe(true);
  });

  it('the DEFAULT filter is NOT unfiltered — refs:HEAD is one branch', () => {
    // The whole reason a reveal misses in a log nobody thinks they filtered.
    expect(isUnfiltered(DEFAULT_FILTER)).toBe(false);
  });

  it('sort never shortens the stream, so it does not count as a filter', () => {
    expect(isUnfiltered({ ...all, sort: 'date' })).toBe(true);
    expect(isUnfiltered({ ...all, sort: 'intelli' })).toBe(true);
  });

  it('every narrowing field counts', () => {
    expect(isUnfiltered({ ...all, refs: ['main'] })).toBe(false);
    expect(isUnfiltered({ ...all, range: { a: 'main', b: 'dev' } })).toBe(false);
    expect(isUnfiltered({ ...all, authors: ['a@x.dev'] })).toBe(false);
    expect(isUnfiltered({ ...all, dateRange: { from: '2026-01-01' } })).toBe(false);
    expect(isUnfiltered({ ...all, paths: ['src'] })).toBe(false);
    expect(isUnfiltered({ ...all, text: { q: 'fix', regex: false, matchCase: false } })).toBe(false);
    expect(isUnfiltered({ ...all, follow: true })).toBe(false);
  });

  it('an empty narrowing field is not a filter — buildLogArgs ignores it too', () => {
    // `paths: []` pushes no pathspec, so treating it as narrowing would report
    // a filter that git was never given.
    expect(isUnfiltered({ ...all, paths: [] })).toBe(true);
    expect(isUnfiltered({ ...all, authors: [] })).toBe(true);
    expect(isUnfiltered({ ...all, text: { q: '', regex: false, matchCase: false } })).toBe(true);
    expect(args({ refs: 'ALL', paths: [] })).not.toContain('--');
  });
});
