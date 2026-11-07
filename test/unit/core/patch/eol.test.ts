import { describe, expect, it } from 'vitest';
import { toBlobEol, withCrlf } from '../../../../src/core/patch/eol';
import { computeLineChanges } from '../../../../src/core/patch/lineDiff';
import { applyLineChanges } from '../../../../src/core/patch/patchBuilder';

describe('toBlobEol (POST-QA F1)', () => {
  it('turns a CRLF checkout of an LF blob back into LF', () => {
    expect(toBlobEol('a\nb\n', 'a\r\nB\r\n')).toEqual({ text: 'a\nB\n', crlf: true });
  });

  it('leaves an LF working tree alone', () => {
    expect(toBlobEol('a\nb\n', 'a\nB\n')).toEqual({ text: 'a\nB\n', crlf: false });
  });

  it('compares byte for byte when the blob itself holds CRLF', () => {
    // Committed with CRLF on purpose (a .cmd, an .ini): git stores it as is.
    expect(toBlobEol('a\r\nb\r\n', 'a\r\nB\r\n')).toEqual({ text: 'a\r\nB\r\n', crlf: false });
    expect(toBlobEol('mixed\r\nlf\n', 'mixed\r\nLF\r\n')).toEqual({ text: 'mixed\r\nLF\r\n', crlf: false });
  });

  it('keeps a lone CR that is not part of a line ending', () => {
    expect(toBlobEol('a\n', 'a\r\nx\ry\r\n').text).toBe('a\nx\ry\n');
  });

  it('lets the diff see only the real changes, on the same line numbers', () => {
    const blob = 'one\ntwo\nthree\nfour\n';
    const worktree = 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n';
    const raw = computeLineChanges(blob, worktree);
    // Raw, every line differs by its `\r`: one change covering the file.
    expect(raw).toHaveLength(1);
    const changes = computeLineChanges(blob, toBlobEol(blob, worktree).text);
    expect(changes).toEqual([
      { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
      { originalStartLineNumber: 4, originalEndLineNumber: 0, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 },
    ]);
  });
});

describe('withCrlf', () => {
  it('puts CRLF back on every line ending, once', () => {
    expect(withCrlf('a\nb\r\nc')).toBe('a\r\nb\r\nc');
    expect(withCrlf('')).toBe('');
  });

  it('round-trips a residue computed on LF back to the working tree', () => {
    const blob = 'one\ntwo\nthree\n';
    const worktree = 'one\r\nTWO\r\nthree\r\nfour\r\n';
    const { text, crlf } = toBlobEol(blob, worktree);
    const changes = computeLineChanges(blob, text);
    // Keep only the second change in the working tree.
    const residue = applyLineChanges(blob, text, [changes[1]!]);
    expect(crlf).toBe(true);
    expect(withCrlf(residue)).toBe('one\r\ntwo\r\nthree\r\nfour\r\n');
  });
});
