import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay } from '../../../src/localHistory/grouping';
import type { SnapshotManifest } from '../../../src/localHistory/snapshotStore';

function manifest(id: string, ts: number): SnapshotManifest {
  return { id, ts, label: id, trigger: 'operation', files: [] };
}

// Fixed "now": a mid-afternoon moment so day arithmetic is unambiguous.
const NOW = new Date(2026, 6, 12, 15, 0, 0).getTime();
const DAY = 86_400_000;

describe('dayLabel', () => {
  it('labels the current day Today', () => {
    expect(dayLabel(NOW - 3_600_000, NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 6, 12, 0, 0, 1).getTime(), NOW)).toBe('Today');
  });

  it('labels the previous calendar day Yesterday (not a 24h window)', () => {
    expect(dayLabel(new Date(2026, 6, 11, 23, 59, 0).getTime(), NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 6, 11, 0, 0, 1).getTime(), NOW)).toBe('Yesterday');
  });

  it('falls back to a locale date for anything older', () => {
    const old = new Date(2026, 6, 9, 12, 0, 0).getTime();
    expect(dayLabel(old, NOW)).toBe(new Date(old).toLocaleDateString());
  });

  it('crosses month boundaries correctly', () => {
    const firstOfMonth = new Date(2026, 7, 1, 8, 0, 0).getTime();
    expect(dayLabel(new Date(2026, 6, 31, 22, 0, 0).getTime(), firstOfMonth)).toBe('Yesterday');
  });
});

describe('groupByDay', () => {
  it('buckets contiguous manifests per calendar day, newest first', () => {
    const list = [
      manifest('a', NOW - 1_000),
      manifest('b', NOW - 2_000),
      manifest('c', NOW - DAY),
      manifest('d', NOW - 3 * DAY),
      manifest('e', NOW - 3 * DAY - 1_000),
    ];
    const groups = groupByDay(list, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      new Date(NOW - 3 * DAY).toLocaleDateString(),
    ]);
    expect(groups.map((g) => g.manifests.map((m) => m.id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['d', 'e'],
    ]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});
