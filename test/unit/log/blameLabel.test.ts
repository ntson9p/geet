import { describe, expect, it } from 'vitest';
import {
  BUCKETS,
  NBSP,
  formatBlameLabel,
  heatBucket,
  relativeDate,
  runBands,
  toDecorationText,
} from '../../../src/log/blame/blameLabel';
import type { LineBlame } from '../../../src/log/blame/blameService';

const NOW = Date.UTC(2026, 0, 20); // fixed clock — relative dates must be stable
const DAY = 86_400;

function committed(over: Partial<LineBlame> = {}): LineBlame {
  return {
    sha: 'bfbf2e7a1b2c3d4e5f60718293a4b5c6d7e8f900',
    author: 'example-user1',
    authorTime: NOW / 1000 - 8 * DAY,
    summary: 'abcx',
    isUncommitted: false,
    ...over,
  };
}

const UNCOMMITTED: LineBlame = {
  sha: '0'.repeat(40),
  author: 'Uncommitted',
  authorTime: 0,
  summary: 'Uncommitted changes',
  isUncommitted: true,
};

const DEFAULT_FORMAT = '${author|12} ${date|relative} ${sha|7}';
/** author(12) + ' ' + date(10) + ' ' + sha(7) */
const DEFAULT_WIDTH = 12 + 1 + 10 + 1 + 7;

describe('formatBlameLabel', () => {
  it('pads every field to a fixed width so the gutter forms one column', () => {
    expect(formatBlameLabel(DEFAULT_FORMAT, committed(), NOW)).toHaveLength(DEFAULT_WIDTH);
  });

  it('gives uncommitted lines the same width as committed ones', () => {
    // The regression: an uncommitted line has an empty date and a one-char
    // sha, so it is *only* padding that keeps it aligned with its neighbours.
    expect(formatBlameLabel(DEFAULT_FORMAT, UNCOMMITTED, NOW)).toHaveLength(DEFAULT_WIDTH);
  });

  it('keeps the width for short authors, long authors and old commits', () => {
    const cases: LineBlame[] = [
      committed({ author: 'ab' }),
      committed({ author: 'a-very-long-author-name-indeed' }),
      committed({ authorTime: NOW / 1000 - 3 * 365 * DAY }),
      committed({ authorTime: NOW / 1000 - 45 * DAY }),
      committed({ authorTime: NOW / 1000 - 10 }),
    ];
    for (const lb of cases) {
      expect(formatBlameLabel(DEFAULT_FORMAT, lb, NOW)).toHaveLength(DEFAULT_WIDTH);
    }
  });

  it('honours custom field widths', () => {
    const format = '${sha|12} ${author|20}';
    expect(formatBlameLabel(format, committed(), NOW)).toHaveLength(12 + 1 + 20);
    expect(formatBlameLabel(format, UNCOMMITTED, NOW)).toHaveLength(12 + 1 + 20);
  });

  it('truncates over-long fields with an ellipsis rather than overflowing', () => {
    const label = formatBlameLabel('${author|12}', committed(), NOW);
    expect(label).toBe('example-use…');
  });

  it('renders the expected fields', () => {
    const label = formatBlameLabel(DEFAULT_FORMAT, committed(), NOW);
    expect(label.trimEnd()).toBe('example-use… 8d ago     bfbf2e7');
    expect(formatBlameLabel(DEFAULT_FORMAT, UNCOMMITTED, NOW).trimEnd()).toBe(
      'Uncommitted             *',
    );
  });
});

describe('toDecorationText', () => {
  // VS Code puts `before.contentText` into a CSS `content:'…'` on a ::before
  // pseudo-element; `.view-lines` sets `white-space: nowrap`, so U+0020 runs
  // collapse and the fixed-width column falls apart. Only U+00A0 survives.
  it('leaves no collapsible space in the rendered text', () => {
    const text = toDecorationText(formatBlameLabel(DEFAULT_FORMAT, UNCOMMITTED, NOW));
    expect(text).not.toContain(' ');
    expect(text).toHaveLength(DEFAULT_WIDTH);
  });

  it('converts every padding space, wherever it falls in the label', () => {
    // Leading, interior and trailing runs all collapse in CSS; each of the
    // three is present in a real label (short author, empty date, short sha).
    const label = formatBlameLabel(DEFAULT_FORMAT, UNCOMMITTED, NOW);
    expect(label).toContain('  '); // the plain label really does pad with U+0020
    const text = toDecorationText(label);
    expect(text).not.toContain(' ');
    expect(text.replace(new RegExp(NBSP, 'g'), ' ')).toBe(label);
  });

  it('is width-preserving', () => {
    expect(NBSP).toBe('\u00a0');
    expect(toDecorationText('a b  c')).toHaveLength(6);
  });
});

describe('relativeDate', () => {
  it('fits the 10-column date field for every bucket', () => {
    const secs = NOW / 1000;
    for (const ago of [0, DAY, 29 * DAY, 45 * DAY, 400 * DAY, 4000 * DAY]) {
      expect(relativeDate(secs - ago, NOW).length).toBeLessThanOrEqual(10);
    }
  });
});

describe('heatBucket', () => {
  it('puts the newest commit in bucket 0 and the oldest in the last bucket', () => {
    const times = [100, 200, 300, 400, 500];
    expect(heatBucket(500, times)).toBe(0);
    expect(heatBucket(100, times)).toBe(BUCKETS - 1);
  });

  it('stays in range for an empty span and for unknown times', () => {
    expect(heatBucket(123, [])).toBe(BUCKETS - 1);
    const times = [100, 200];
    for (const t of [50, 100, 150, 200, 250]) {
      const b = heatBucket(t, times);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BUCKETS);
    }
  });
});

describe('runBands', () => {
  const withSha = (sha: string): LineBlame => committed({ sha });

  it('gives one commit one band', () => {
    expect(runBands([withSha('a'), withSha('a'), withSha('a')])).toEqual([0, 0, 0]);
  });

  it('flips on every commit change so adjacent groups never match', () => {
    const lines = [withSha('a'), withSha('a'), withSha('b'), withSha('c'), withSha('c')];
    const bands = runBands(lines);
    expect(bands).toEqual([0, 0, 1, 0, 0]);
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.sha !== lines[i - 1]!.sha) {
        expect(bands[i]).not.toBe(bands[i - 1]);
      } else {
        expect(bands[i]).toBe(bands[i - 1]);
      }
    }
  });

  it('treats a commit that reappears later as its own group', () => {
    // Two non-adjacent runs of 'a' need not share a band — what matters is
    // that each boundary is visible.
    const bands = runBands([withSha('a'), withSha('b'), withSha('a')]);
    expect(bands).toEqual([0, 1, 0]);
  });

  it('alternates on every line when no two neighbours share a commit', () => {
    expect(runBands(['a', 'b', 'c', 'd'].map(withSha))).toEqual([0, 1, 0, 1]);
  });

  it('returns one band per line, always 0 or 1', () => {
    const lines = ['a', 'a', 'b', 'b', 'b', 'c'].map(withSha);
    const bands = runBands(lines);
    expect(bands).toHaveLength(lines.length);
    for (const b of bands) expect([0, 1]).toContain(b);
  });

  it('handles an empty file', () => {
    expect(runBands([])).toEqual([]);
  });
});
