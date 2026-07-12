import { describe, expect, it } from 'vitest';
import { GraphLayout, type GraphInputCommit } from '../../../src/log/graphLayout/layout';
import { intelliSort } from '../../../src/log/graphLayout/intelliSort';
import { renderAscii } from './asciiRender';

/** newest-first commit list builder: c('a', 'b') = commit a with parent b. */
function c(sha: string, ...parents: string[]): GraphInputCommit {
  return { sha, parents };
}

function draw(commits: GraphInputCommit[]): string {
  const layout = new GraphLayout();
  return renderAscii(layout.appendPage(commits), (sha) => sha);
}

describe('GraphLayout goldens', () => {
  it('linear history', () => {
    expect(draw([c('c3', 'c2'), c('c2', 'c1'), c('c1')])).toBe(
      ['* c3', '|', '* c2', '|', '* c1'].join('\n'),
    );
  });

  it('single merge (feature branch merged into main)', () => {
    // m merges f into main; f branched from b.
    const commits = [c('m', 'a', 'f'), c('a', 'b'), c('f', 'b'), c('b', 'r'), c('r')];
    expect(draw(commits)).toBe(
      [
        '* m',
        '|\\',
        '* | a',
        '| |',
        '| * f',
        '|/',
        '* b',
        '|',
        '* r',
      ].join('\n'),
    );
  });

  it('octopus merge (3 parents)', () => {
    const commits = [c('o', 'p1', 'p2', 'p3'), c('p1', 'b'), c('p2', 'b'), c('p3', 'b'), c('b')];
    expect(draw(commits)).toBe(
      [
        '* o',
        '|\\ \\',
        '* | | p1',
        '| | |',
        '| * | p2',
        '| | |',
        '| | * p3',
        '|/_/',
        '* b',
      ].join('\n'),
    );
  });

  it('criss-cross merges', () => {
    // x merges (a,b); y merges (b,a) — classic criss-cross below two heads.
    const commits = [c('x', 'a', 'b'), c('y', 'b2', 'a2'), c('a', 'a2'), c('b', 'b2'), c('a2', 'r'), c('b2', 'r'), c('r')];
    const layout = new GraphLayout();
    const rows = layout.appendPage(commits);
    // Structural assertions (exact art is noisy for criss-cross):
    const bySha = new Map(rows.map((r) => [r.sha, r]));
    expect(bySha.get('x')!.forks).toHaveLength(2);
    expect(bySha.get('y')!.forks).toHaveLength(2);
    // a2 receives joins from both x's second-parent chain? — a2 has children a and y.
    const a2 = bySha.get('a2')!;
    const b2 = bySha.get('b2')!;
    expect(a2.joins.length + (a2.lanesBefore.some((l) => l.lane === a2.nodeLane) ? 1 : 0)).toBeGreaterThanOrEqual(1);
    expect(b2.joins.length).toBeGreaterThanOrEqual(1);
    // Root sees exactly two converging lanes.
    const r = bySha.get('r')!;
    expect(r.joins).toHaveLength(1);
    expect(r.forks).toHaveLength(0);
  });

  it('orphan root mid-stream (second root history)', () => {
    const commits = [c('a2', 'a1'), c('a1'), c('b2', 'b1'), c('b1')];
    expect(draw(commits)).toBe(
      ['* a2', '|', '* a1', '', '* b2', '|', '* b1'].join('\n').replace('\n\n', '\n'),
    );
  });

  it('page-boundary lane carry: two pages equal one', () => {
    const commits = [c('m', 'a', 'f'), c('a', 'b'), c('f', 'b'), c('b', 'r'), c('r')];
    const whole = new GraphLayout();
    const wholeRows = whole.appendPage(commits);
    const paged = new GraphLayout();
    const pagedRows = [...paged.appendPage(commits.slice(0, 2)), ...paged.appendPage(commits.slice(2))];
    expect(JSON.stringify(pagedRows)).toBe(JSON.stringify(wholeRows));
  });

  it('lane recycling keeps width stable', () => {
    // Two independent merges in sequence must not grow lanes unboundedly.
    const commits = [
      c('m2', 'x', 'g'),
      c('g', 'x'),
      c('x', 'm1'),
      c('m1', 'y', 'h'),
      c('h', 'y'),
      c('y', 'r'),
      c('r'),
    ];
    const layout = new GraphLayout();
    layout.appendPage(commits);
    expect(layout.laneCount).toBeLessThanOrEqual(2);
  });
});

describe('IntelliSort', () => {
  it('emits the merged branch block contiguously below the merge', () => {
    // git date-order style interleaving:
    const interleaved = [
      c('m', 'a3', 'f2'),
      c('a3', 'a2'),
      c('f2', 'f1'),
      c('a2', 'a1'),
      c('f1', 'base'),
      c('a1', 'base'),
      c('base'),
    ];
    const sorted = intelliSort(interleaved).map((x) => x.sha);
    expect(sorted).toEqual(['m', 'f2', 'f1', 'a3', 'a2', 'a1', 'base']);
  });

  it('golden: IntelliSorted merge renders as one contiguous block', () => {
    const interleaved = [
      c('m', 'a2', 'f2'),
      c('a2', 'a1'),
      c('f2', 'f1'),
      c('f1', 'b'),
      c('a1', 'b'),
      c('b'),
    ];
    const layout = new GraphLayout();
    const rows = layout.appendPage(intelliSort(interleaved));
    expect(renderAscii(rows, (s) => s)).toBe(
      [
        '* m',
        '|\\',
        '| * f2',
        '| |',
        '| * f1',
        '| |',
        '* | a2',
        '| |',
        '* | a1',
        '|/',
        '* b',
      ].join('\n'),
    );
  });

  it('is a valid topological order (children before parents)', () => {
    const commits = [
      c('m', 'a', 'f'),
      c('a', 'b'),
      c('f', 'b'),
      c('b', 'r'),
      c('r'),
    ];
    const sorted = intelliSort(commits);
    const pos = new Map(sorted.map((x, i) => [x.sha, i]));
    for (const commit of commits) {
      for (const p of commit.parents) {
        expect(pos.get(commit.sha)!).toBeLessThan(pos.get(p)!);
      }
    }
  });

  it('leaves cross-page spills in input order at the tail', () => {
    // 'a' has a child outside the window — must not be reordered before it.
    const window = [c('x', 'a'), c('b', 'a')]; // both children of a, but only page sees them
    const sorted = intelliSort(window).map((s) => s.sha);
    expect(sorted).toEqual(['x', 'b']);
  });
});

describe('GraphLayout performance', () => {
  it('lays out 100k synthetic commits in < 400 ms', () => {
    const commits: GraphInputCommit[] = [];
    // Mainline with a merge every 20 commits (branch length 5).
    const n = 100_000;
    let i = 0;
    while (commits.length < n) {
      const sha = `c${i}`;
      if (i % 20 === 0 && i > 0) {
        commits.push(c(sha, `c${i + 1}`, `s${i}-0`));
        for (let k = 0; k < 5 && commits.length < n; k++) {
          commits.push(c(`s${i}-${k}`, k === 4 ? `c${i + 5}` : `s${i}-${k + 1}`));
        }
      } else {
        commits.push(c(sha, `c${i + 1}`));
      }
      i++;
    }
    const layout = new GraphLayout();
    const t0 = Date.now();
    const rows = layout.appendPage(commits);
    const elapsed = Date.now() - t0;
    expect(rows).toHaveLength(commits.length);
    expect(elapsed).toBeLessThan(400);
  });
});
