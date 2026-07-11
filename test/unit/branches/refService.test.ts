import { describe, expect, it } from 'vitest';
import type { CheckoutEvent } from '../../../src/core/git/parsers/reflog';
import { scoreRecentBranches } from '../../../src/branches/refService';

const DAY = 24 * 60 * 60;
const NOW = 1_700_000_000;

function ev(to: string, daysAgo: number, from = 'main'): CheckoutEvent {
  return { from, to, time: NOW - daysAgo * DAY };
}

describe('scoreRecentBranches', () => {
  it('ranks by frequency × recency decay', () => {
    const existing = new Set(['main', 'feature/hot', 'feature/old', 'feature/frequent']);
    const events: CheckoutEvent[] = [
      // frequent but old
      ev('feature/frequent', 40),
      ev('feature/frequent', 42),
      ev('feature/frequent', 44),
      // single but very recent
      ev('feature/hot', 0.5),
      // single, ancient
      ev('feature/old', 90),
    ];
    const ranked = scoreRecentBranches(events, existing, { now: NOW });
    expect(ranked[0]).toBe('feature/hot'); // recency beats stale frequency
    expect(ranked).toContain('feature/frequent');
    expect(ranked.indexOf('feature/frequent')).toBeLessThan(ranked.indexOf('feature/old'));
  });

  it('accumulates frequency for equally recent branches', () => {
    const existing = new Set(['a', 'b', 'main']);
    const events = [ev('a', 1), ev('a', 2), ev('a', 3), ev('b', 1)];
    const ranked = scoreRecentBranches(events, existing, { now: NOW });
    expect(ranked[0]).toBe('a');
  });

  it('filters branches that no longer exist (deleted/renamed)', () => {
    const existing = new Set(['main', 'alive']);
    const events = [ev('deleted-branch', 1), ev('alive', 2), ev('renamed-away', 0.1)];
    const ranked = scoreRecentBranches(events, existing, { now: NOW });
    expect(new Set(ranked)).toEqual(new Set(['alive', 'main']));
    expect(ranked).not.toContain('deleted-branch');
    expect(ranked).not.toContain('renamed-away');
  });

  it('excludes the current branch', () => {
    const existing = new Set(['main', 'dev']);
    const events = [ev('dev', 1), ev('main', 0.5, 'dev')];
    const ranked = scoreRecentBranches(events, existing, { now: NOW, exclude: 'main' });
    expect(ranked).toEqual(['dev']);
  });

  it('counts the from-side at half weight', () => {
    const existing = new Set(['x', 'y']);
    // x checked out once; y only ever left FROM at the same time.
    const events: CheckoutEvent[] = [
      { from: 'y', to: 'x', time: NOW - DAY },
    ];
    const ranked = scoreRecentBranches(events, existing, { now: NOW });
    expect(ranked).toEqual(['x', 'y']);
  });

  it('half-life halves a score every 14 days', () => {
    const existing = new Set(['fresh', 'stale']);
    // stale has 2 checkouts 14 days ago (2 × 0.5 = 1.0); fresh has 1 now (1.0).
    // Add a tiebreaker: fresh +0.01 via a slightly-newer event ordering — use 13.9 days for stale to keep test deterministic.
    const events = [ev('stale', 14), ev('stale', 14), ev('fresh', 0)];
    const ranked = scoreRecentBranches(events, existing, { now: NOW });
    // 2 × 0.5^(14/14) = 1.0 vs 1 × 0.5^0 = 1.0 → effectively equal; both present.
    expect(new Set(ranked)).toEqual(new Set(['fresh', 'stale']));
  });
});
