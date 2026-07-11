import { describe, expect, it } from 'vitest';
import {
  createBlameIncrementalParser,
  parseBlameIncremental,
} from '../../../../../src/core/git/parsers/blameIncremental';
import { fixture } from './fixtures';

describe('blame --incremental parser (captured fixture)', () => {
  const runs = parseBlameIncremental(fixture('blame-incremental.bin'));

  it('emits one run per group, in completion order', () => {
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => r.finalLine)).toEqual([2, 4, 1, 3]);
    expect(runs.map((r) => r.count)).toEqual([1, 1, 1, 1]);
  });

  it('carries full metadata on first sight of a commit', () => {
    const first = runs[0]!;
    expect(first.author).toBe('Åsa Ünicode');
    expect(first.authorMail).toBe('asa@example.com');
    expect(first.authorTime).toBeGreaterThan(1_700_000_000);
    expect(first.authorTz).toBe('+0000');
    expect(first.summary).toBe('change line two, add four');
    expect(first.previous?.path).toBe('code.ts');
    expect(first.filename).toBe('code.ts');
  });

  it('reuses cached metadata for later groups of the same sha', () => {
    const second = runs[1]!; // same commit as runs[0], header omitted by git
    expect(second.sha).toBe(runs[0]!.sha);
    expect(second.author).toBe('Åsa Ünicode');
    expect(second.summary).toBe('change line two, add four');

    const fourth = runs[3]!; // same commit as runs[2]
    expect(fourth.sha).toBe(runs[2]!.sha);
    expect(fourth.author).toBe('Åsa Ünicode');
    expect(fourth.summary).toBe('add code');
  });

  it('marks boundary commits', () => {
    expect(runs[2]!.isBoundary).toBe(true);
    expect(runs[3]!.isBoundary).toBe(true); // cached meta carries the flag
    expect(runs[0]!.isBoundary).toBe(false);
  });

  it('maps original vs final line numbers', () => {
    for (const r of runs) {
      expect(r.origLine).toBeGreaterThan(0);
      expect(r.finalLine).toBeGreaterThan(0);
    }
  });
});

describe('blame parser (streaming + edges)', () => {
  it('yields runs incrementally as lines are fed', () => {
    const parser = createBlameIncrementalParser();
    const lines = fixture('blame-incremental.bin').split('\n');
    let yielded = 0;
    let sawMidStream = false;
    for (const [i, line] of lines.entries()) {
      if (parser.feedLine(line)) {
        yielded++;
        if (i < lines.length - 2) sawMidStream = true;
      }
    }
    expect(yielded).toBe(4);
    expect(sawMidStream).toBe(true);
  });

  it('handles uncommitted-change groups (zero sha)', () => {
    const zero = '0'.repeat(40);
    const out = [
      `${zero} 1 1 2`,
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1767323045',
      'author-tz +0000',
      'summary Version of code.ts from code.ts',
      'filename code.ts',
      '',
    ].join('\n');
    const [run] = parseBlameIncremental(out);
    expect(run?.sha).toBe(zero);
    expect(run?.author).toBe('Not Committed Yet');
    expect(run?.count).toBe(2);
  });

  it('ignores stray lines outside a group', () => {
    const parser = createBlameIncrementalParser();
    expect(parser.feedLine('filename orphan.ts')).toBeUndefined();
    expect(parser.feedLine('')).toBeUndefined();
  });
});
