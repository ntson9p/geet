import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGE_STEPS,
  NBSP,
  ageStep,
  formatBlameLabel,
  relativeDate,
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

describe('ageStep', () => {
  it('puts the newest commit at step 0 and the oldest at the last step', () => {
    const times = [100, 200, 300, 400, 500];
    expect(ageStep(500, times)).toBe(0);
    expect(ageStep(100, times)).toBe(AGE_STEPS - 1);
  });

  it('never decreases as a commit gets older', () => {
    const times = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const steps = [...times].reverse().map((t) => ageStep(t, times));
    for (let k = 1; k < steps.length; k++) {
      expect(steps[k]!).toBeGreaterThanOrEqual(steps[k - 1]!);
    }
    expect(steps[0]).toBe(0);
    expect(steps.at(-1)).toBe(AGE_STEPS - 1);
  });

  it('spreads a long history across every step', () => {
    const times = Array.from({ length: 200 }, (_, k) => 1_000 + k);
    const seen = new Set(times.map((t) => ageStep(t, times)));
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('calls a file with a single revision newest, not oldest', () => {
    // Rank has no meaning with one revision, and the far end of the ramp
    // would paint a brand-new file as stale.
    expect(ageStep(500, [500])).toBe(0);
    expect(ageStep(500, [])).toBe(0);
  });

  it('stays in range for times outside the span', () => {
    const times = [100, 200];
    for (const t of [50, 100, 150, 200, 250]) {
      const step = ageStep(t, times);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(AGE_STEPS);
    }
  });

  it('has a contributed colour for every step it can return', () => {
    // The ramp is only as long as package.json says it is; a step with no
    // colour resolves to "transparent" and silently loses the gradient.
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      contributes: { colors: Array<{ id: string }> };
    };
    const ids = new Set(pkg.contributes.colors.map((c) => c.id));
    for (let step = 0; step < AGE_STEPS; step++) {
      expect(ids.has(`geet.blame.age${step + 1}Background`)).toBe(true);
    }
  });
});
