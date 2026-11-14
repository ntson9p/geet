import { describe, expect, it } from 'vitest';
import {
  CELL_PADDING,
  HASH_SAMPLES,
  MAX_AUTO_WIDTH,
  MIN_COLUMN_WIDTH,
  authorText,
  autoAuthorWidth,
  autoTextWidth,
  draggedWidth,
  fitColumns,
  readColumnWidths,
  sampleWidth,
  visibleColumns,
} from '../../../webview-ui/src/log/columns';

/** Seven pixels a character. */
const measure = (text: string): number => text.length * 7;

describe("visibleColumns (Presentation Settings ▸ Columns, IntelliJ's order)", () => {
  it('shows Author and Date by default, Hash only when switched on, always in that order', () => {
    expect(visibleColumns({ showAuthorColumn: true, showDateColumn: true, showHashColumn: false })).toEqual([
      'author',
      'date',
    ]);
    expect(visibleColumns({ showAuthorColumn: true, showDateColumn: true, showHashColumn: true })).toEqual([
      'author',
      'date',
      'hash',
    ]);
    expect(visibleColumns({ showAuthorColumn: false, showDateColumn: false, showHashColumn: true })).toEqual([
      'hash',
    ]);
    expect(visibleColumns({ showAuthorColumn: false, showDateColumn: false, showHashColumn: false })).toEqual([]);
  });
});

describe('authorText', () => {
  it("adds IntelliJ's * when someone else committed the change", () => {
    expect(authorText('Ben Okafor', true)).toBe('Ben Okafor*');
    expect(authorText('Ben Okafor', false)).toBe('Ben Okafor');
    expect(authorText('Ben Okafor', undefined)).toBe('Ben Okafor');
  });
});

describe('autoAuthorWidth (fit to the rows, as IntelliJ sizes Author)', () => {
  it('fits the widest name with room for the *, plus the cell padding', () => {
    expect(autoAuthorWidth(['Al', 'Bob*'], measure)).toBe(4 * 7 + CELL_PADDING);
    expect(autoAuthorWidth(['Alice'], measure)).toBe(6 * 7 + CELL_PADDING);
  });

  it('never goes past 300 pixels, nor under the minimum', () => {
    expect(autoAuthorWidth(['x'.repeat(80)], measure)).toBe(MAX_AUTO_WIDTH);
    expect(autoAuthorWidth([], measure)).toBe(MIN_COLUMN_WIDTH);
  });

  it('reads the first thousand rows only', () => {
    const names = [...Array.from({ length: 1000 }, () => 'Bobby'), 'Somebody With A Long Name'];
    expect(autoAuthorWidth(names, measure)).toBe(6 * 7 + CELL_PADDING);
  });
});

describe("autoTextWidth (the Date column with IntelliJ's dates, sized by its rows: POST-P14cg)", () => {
  it("fits the widest row with room for a *, as IntelliJ's FromData measures `$value*`", () => {
    expect(autoTextWidth(['Moments ago', 'Yesterday 10:58 PM', 'Today 2:19 PM'], measure)).toBe(
      19 * 7 + CELL_PADDING,
    );
  });

  it('skips empty rows, never goes past 300 pixels nor under the minimum', () => {
    expect(autoTextWidth(['', 'Today 2:19 PM'], measure)).toBe(14 * 7 + CELL_PADDING);
    expect(autoTextWidth(['x'.repeat(80)], measure)).toBe(MAX_AUTO_WIDTH);
    expect(autoTextWidth([], measure)).toBe(MIN_COLUMN_WIDTH);
  });

  it('reads the first thousand rows only', () => {
    const rows = [...Array.from({ length: 1000 }, () => 'Moments ago'), '12/28/2026 10:58 PM'];
    expect(autoTextWidth(rows, measure)).toBe(12 * 7 + CELL_PADDING);
  });
});

describe('sampleWidth (Date and Hash are sized by samples)', () => {
  it('fits the widest sample, plus the cell padding', () => {
    expect(sampleWidth('10/29/2026 10:58 PM', measure)).toBe(19 * 7 + CELL_PADDING);
    const bold = (text: string): number => (text.startsWith('0') ? 9 : 7) * text.length;
    expect(sampleWidth(HASH_SAMPLES, bold)).toBe(8 * 9 + CELL_PADDING);
  });

  it('measures eight characters for the hash, IntelliJ\'s short hash', () => {
    expect(HASH_SAMPLES.every((sample) => sample.length === 8)).toBe(true);
    expect(HASH_SAMPLES).toContain('eeeeeeee');
  });
});

describe('fitColumns', () => {
  const auto = { author: 100, date: 150, hash: 80 };

  it('gives each visible column its own width, and none to a hidden one', () => {
    expect(fitColumns(['author', 'date'], auto, {}, 1000, 200)).toEqual({ author: 100, date: 150, hash: 0 });
  });

  it('keeps a dragged width while it fits the row, as IntelliJ keeps a saved one', () => {
    expect(fitColumns(['author', 'date'], auto, { author: 180 }, 1000, 200).author).toBe(180);
    expect(fitColumns(['author', 'date'], auto, { author: 2000 }, 1000, 200).author).toBe(100);
    expect(fitColumns(['author', 'date'], auto, { author: 10 }, 1000, 200).author).toBe(MIN_COLUMN_WIDTH);
  });

  it('squeezes the columns together when the message would get too little', () => {
    const fitted = fitColumns(['author', 'date'], auto, {}, 400, 200);
    expect(fitted.author + fitted.date).toBeLessThanOrEqual(200);
    expect(fitted.author).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    expect(fitted.date).toBeGreaterThan(fitted.author);
  });

  it('stops at each column\'s minimum however narrow the row', () => {
    expect(fitColumns(['author', 'date'], auto, {}, 150, 200)).toEqual({
      author: MIN_COLUMN_WIDTH,
      date: MIN_COLUMN_WIDTH,
      hash: 0,
    });
  });
});

describe('draggedWidth (dragging a column\'s left border)', () => {
  it('widens the column as the border moves left, narrows it as it moves right', () => {
    expect(draggedWidth(100, -50, 150, 1000, 200)).toBe(150);
    expect(draggedWidth(100, 30, 150, 1000, 200)).toBe(70);
  });

  it('keeps the column above its minimum and the message above its own', () => {
    expect(draggedWidth(100, 80, 150, 1000, 200)).toBe(MIN_COLUMN_WIDTH);
    expect(draggedWidth(100, -900, 150, 1000, 200)).toBe(1000 - 200 - 150);
  });
});

describe('readColumnWidths', () => {
  it('keeps positive widths of known columns and drops the rest', () => {
    expect(readColumnWidths({ author: 120, date: 'wide', hash: -5, subject: 300 })).toEqual({ author: 120 });
    expect(readColumnWidths(null)).toEqual({});
    expect(readColumnWidths(undefined)).toEqual({});
    expect(readColumnWidths('author')).toEqual({});
  });
});
