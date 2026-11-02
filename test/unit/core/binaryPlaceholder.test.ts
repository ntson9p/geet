import { describe, expect, it } from 'vitest';
import { binaryPlaceholder, formatSize, looksBinary } from '../../../src/core/vdocs/binaryPlaceholder';

describe('what a binary revision reads as', () => {
  it('goes by the same test git does: a NUL near the start', () => {
    expect(looksBinary('PNG\0\0binary')).toBe(true);
    expect(looksBinary(`${'x'.repeat(7999)}\0`)).toBe(true);
  });

  it('text is text, including a NUL too far in for git to look', () => {
    expect(looksBinary('')).toBe(false);
    expect(looksBinary('plain text\nwith lines\n')).toBe(false);
    expect(looksBinary(`${'x'.repeat(8000)}\0`)).toBe(false);
  });

  it('gives a size a person can read', () => {
    expect(formatSize(0)).toBe('0 bytes');
    expect(formatSize(1023)).toBe('1,023 bytes');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('is one line, naming the object', () => {
    expect(binaryPlaceholder(79, '7d1ad7a')).toBe('Binary file, 79 bytes (7d1ad7a)\n');
  });

  it('reads differently for two versions of the same size', () => {
    // Otherwise a diff of them would say nothing had changed.
    expect(binaryPlaceholder(79, 'aaaaaaa')).not.toBe(binaryPlaceholder(79, 'bbbbbbb'));
  });

  it('leaves the size out when git could not give it', () => {
    expect(binaryPlaceholder(undefined, '7d1ad7a')).toBe('Binary file (7d1ad7a)\n');
    expect(binaryPlaceholder(Number.NaN, '7d1ad7a')).toBe('Binary file (7d1ad7a)\n');
  });
});
