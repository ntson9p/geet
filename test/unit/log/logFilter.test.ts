import { describe, expect, it } from 'vitest';
import {
  buildLogArgs,
  filterKey,
  graphParents,
  graphSort,
  hidesCommit,
  isRevisionRange,
  isUnfiltered,
  missingFromBatchCheck,
  namedRevisions,
  parseRangeCounts,
  withoutMissingRefs,
  DEFAULT_FILTER,
  type LogFilter,
} from '../../../src/log/logFilter';

const FMT = 'FMT';
const PAGE = { skip: 0, maxCount: 2000 };

function args(f: Partial<LogFilter>): string[] {
  return buildLogArgs({ ...DEFAULT_FILTER, ...f }, FMT, PAGE);
}

describe('buildLogArgs', () => {
  // POST-P14y: date order, not topo — see DEFAULT_FILTER for why.
  it('default filter: HEAD history, date order, paging', () => {
    expect(args({})).toEqual([
      'log',
      `--format=${FMT}`,
      '--parents',
      '--decorate=full',
      '--date-order',
      '--skip=0',
      '--max-count=2000',
    ]);
  });

  it('POST-P14y: the sort the dropdown shows is the one that is applied', () => {
    // The bar renders `filter.sort` directly, so a default that disagrees
    // with the argv would label the view with an order it is not in.
    expect(DEFAULT_FILTER.sort).toBe('date');
  });

  it('sort modes map to git orderings (intelli reorders client-side over topo)', () => {
    expect(args({ sort: 'date' })).toContain('--date-order');
    expect(args({ sort: 'topo' })).toContain('--topo-order');
    expect(args({ sort: 'intelli' })).toContain('--topo-order');
  });

  it('asks for full ref names, so a local feature/x is not taken for a remote branch', () => {
    expect(args({})).toContain('--decorate=full');
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

  it('First Parent adds --first-parent and draws in date order whatever the sort', () => {
    expect(args({ firstParent: true })).toContain('--first-parent');
    for (const sort of ['date', 'topo', 'intelli'] as const) {
      const a = args({ sort, firstParent: true });
      expect(a).toContain('--date-order');
      expect(a).not.toContain('--topo-order');
    }
    expect(args({})).not.toContain('--first-parent');
    expect(args({ firstParent: false })).not.toContain('--first-parent');
  });

  it('No Merges is not handed to git — the host hides merges itself', () => {
    const a = args({ noMerges: true });
    expect(a).not.toContain('--no-merges');
    expect(a).toEqual(args({}));
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

  it('tells the Graph Options apart, and reads false as off', () => {
    expect(filterKey({ sort: 'date', firstParent: true })).not.toBe(filterKey({ sort: 'date' }));
    expect(filterKey({ sort: 'date', noMerges: true })).not.toBe(filterKey({ sort: 'date' }));
    expect(filterKey({ sort: 'date', firstParent: true })).not.toBe(
      filterKey({ sort: 'date', noMerges: true }),
    );
    expect(filterKey({ sort: 'date', firstParent: false, noMerges: false })).toBe(
      filterKey({ sort: 'date' }),
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

  it('First Parent and No Merges hide commits, so they count', () => {
    expect(isUnfiltered({ ...all, firstParent: true })).toBe(false);
    expect(isUnfiltered({ ...all, noMerges: true })).toBe(false);
    expect(isUnfiltered({ ...all, firstParent: false, noMerges: false })).toBe(true);
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

describe('Graph Options on the host', () => {
  it('graphSort: First Parent stands in for the sort, which waits underneath', () => {
    expect(graphSort({ sort: 'intelli' })).toBe('intelli');
    expect(graphSort({ sort: 'topo' })).toBe('topo');
    expect(graphSort({ sort: 'intelli', firstParent: true })).toBe('date');
    expect(graphSort({ sort: 'intelli', firstParent: false })).toBe('intelli');
  });

  it('graphParents: under First Parent a merge is drawn with its first parent only', () => {
    // git's --parents still lists every parent under --first-parent; a lane for
    // the second would wait for a commit the walk never reaches.
    expect(graphParents({ sort: 'date', firstParent: true }, ['p1', 'p2', 'p3'])).toEqual(['p1']);
    expect(graphParents({ sort: 'date' }, ['p1', 'p2'])).toEqual(['p1', 'p2']);
    expect(graphParents({ sort: 'date', firstParent: true }, [])).toEqual([]);
  });

  it('hidesCommit: only merges, and only under No Merges', () => {
    expect(hidesCommit({ sort: 'date', noMerges: true }, ['p1', 'p2'])).toBe(true);
    expect(hidesCommit({ sort: 'date', noMerges: true }, ['p1', 'p2', 'p3'])).toBe(true);
    expect(hidesCommit({ sort: 'date', noMerges: true }, ['p1'])).toBe(false);
    expect(hidesCommit({ sort: 'date', noMerges: true }, [])).toBe(false);
    expect(hidesCommit({ sort: 'date' }, ['p1', 'p2'])).toBe(false);
  });
});

describe('parseRangeCounts', () => {
  it('reads the two counts git prints on a line', () => {
    expect(parseRangeCounts('2\t3\n')).toEqual({ left: 2, right: 3 });
    expect(parseRangeCounts('0\t0\r\n')).toEqual({ left: 0, right: 0 });
  });

  it('is nothing when git printed anything else', () => {
    expect(parseRangeCounts('')).toBeUndefined();
    expect(parseRangeCounts('2\n')).toBeUndefined();
    expect(parseRangeCounts('fatal: ambiguous argument')).toBeUndefined();
  });
});

// POST-P14bh: Paths ▾ · Roots keeps the Branch selection, so a name can reach a
// repository that does not have it. It is left out of the read, not handed to
// git, which would refuse the whole log over it.
describe('a Branch selection another repository lacks', () => {
  it('checks single revisions and leaves ranges to git', () => {
    for (const range of ['main..topic', 'main...topic', 'main^!', 'main^@', 'main^-', 'main^-2']) {
      expect(isRevisionRange(range), range).toBe(true);
    }
    for (const single of ['main', 'feature/a.b', 'origin/main', 'v1.0.0', 'HEAD~2', 'main^', 'main^2', 'abc1234']) {
      expect(isRevisionRange(single), single).toBe(false);
    }
  });

  it('names a range’s two ends, or the selection’s names; HEAD and All name nothing', () => {
    expect(namedRevisions({ sort: 'date', refs: ['main', 'feature/x'] })).toEqual(['main', 'feature/x']);
    expect(namedRevisions({ sort: 'date', range: { a: 'main', b: 'topic' } })).toEqual(['main', 'topic']);
    // A range outranks refs in the argv build, so it does here too.
    expect(namedRevisions({ sort: 'date', refs: ['x'], range: { a: 'a', b: 'b' } })).toEqual(['a', 'b']);
    expect(namedRevisions({ sort: 'date', refs: 'HEAD' })).toEqual([]);
    expect(namedRevisions({ sort: 'date', refs: 'ALL' })).toEqual([]);
    expect(namedRevisions({ sort: 'date' })).toEqual([]);
    // A typed range expression is git's to read.
    expect(namedRevisions({ sort: 'date', refs: ['main..topic', 'main'] })).toEqual(['main']);
  });

  it("reads `git cat-file --batch-check`'s answers, one line per name", () => {
    const names = ['main', 'only-elsewhere', 'v1.0.0', 'abc12'];
    const stdout = 'commit\nonly-elsewhere^{commit} missing\ncommit\nabc12^{commit} ambiguous\n';
    // An ambiguous short hash fails `git log` as surely as a missing name.
    expect(missingFromBatchCheck(names, stdout)).toEqual(['only-elsewhere', 'abc12']);
    expect(missingFromBatchCheck(['main'], 'commit\n')).toEqual([]);
    // Windows line ends.
    expect(missingFromBatchCheck(['a', 'b'], 'commit\r\nb^{commit} missing\r\n')).toEqual(['b']);
  });

  it('calls nothing missing that git did not answer for', () => {
    // A short answer means git stopped early; the log read decides those, as before.
    expect(missingFromBatchCheck(['a', 'b', 'c'], 'commit\n')).toEqual([]);
    expect(missingFromBatchCheck(['a'], '')).toEqual([]);
  });

  it('reads the names the repository has, and nothing when it has none of them', () => {
    const f: LogFilter = { sort: 'date', refs: ['main', 'gone', 'topic'], authors: ['Ann'] };
    expect(withoutMissingRefs(f, ['gone'])).toEqual({ sort: 'date', refs: ['main', 'topic'], authors: ['Ann'] });
    expect(withoutMissingRefs(f, ['main', 'gone', 'topic'])).toBeUndefined();
    // Nothing missing: the filter itself, not a copy — the page cache keys on it.
    expect(withoutMissingRefs(f, [])).toBe(f);
    expect(withoutMissingRefs(f, ['not-selected'])).toBe(f);
  });

  it('reads no range with a missing end', () => {
    const f: LogFilter = { sort: 'topo', range: { a: 'main', b: 'gone' } };
    expect(withoutMissingRefs(f, ['gone'])).toBeUndefined();
    expect(withoutMissingRefs(f, ['other'])).toBe(f);
  });

  it('leaves HEAD and All alone', () => {
    const head: LogFilter = { sort: 'date', refs: 'HEAD' };
    const all: LogFilter = { sort: 'date', refs: 'ALL' };
    expect(withoutMissingRefs(head, ['x'])).toBe(head);
    expect(withoutMissingRefs(all, ['x'])).toBe(all);
  });
});
