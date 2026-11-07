/**
 * The Commit window's ages — stash, shelf, message history: an age within the
 * day, the date after it, written as the log writes dates (POST-QA).
 */
import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../../webview-ui/src/commit/format';

const now = Date.parse('2026-11-08T12:00:00');
const ago = (ms: number): number => now - ms;

describe('relativeTime', () => {
  it('gives an age within the day', () => {
    expect(relativeTime(ago(20_000), now)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3 h ago');
  });

  it('gives the date after a day, as the log’s YYYY/MM/DD HH:mm writes it', () => {
    const then = new Date(2026, 10, 5, 9, 30).getTime();
    expect(relativeTime(then, now, 'YYYY/MM/DD HH:mm')).toBe('2026/11/05');
  });

  it('gives the locale’s short date with `locale`, the log’s other choice', () => {
    const then = new Date(2026, 10, 5, 9, 30).getTime();
    expect(relativeTime(then, now, 'locale')).toBe(new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(then));
  });
});
