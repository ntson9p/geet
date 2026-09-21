import { describe, expect, it } from 'vitest';
import { createCommitDateFormat } from '../../../webview-ui/src/log/dateFormat';

/** 2026-09-21T13:45:07Z — a time that is a different *day* in some zones. */
const T = Math.floor(Date.parse('2026-09-21T13:45:07Z') / 1000);

describe('createCommitDateFormat (POST-P14z)', () => {
  it('gives the exact date and the time, not an age', () => {
    expect(createCommitDateFormat('en-GB', 'UTC')(T)).toBe('21/09/2026 13:45');
  });

  it('follows the locale it is given', () => {
    // The point of leaving `locale` undefined in production: a date order is
    // a regional convention, and 09/21 vs 21/09 is not a detail.
    expect(createCommitDateFormat('en-US', 'UTC')(T)).toMatch(/^09\/21\/2026 /u);
    expect(createCommitDateFormat('de-DE', 'UTC')(T)).toBe('21.09.2026 13:45');
  });

  it('renders in the time zone it is given, including across the date line', () => {
    expect(createCommitDateFormat('en-GB', 'Asia/Ho_Chi_Minh')(T)).toBe('21/09/2026 20:45');
    // +14 puts this commit on the following day — the kind of thing a relative
    // age hides entirely.
    expect(createCommitDateFormat('en-GB', 'Pacific/Kiritimati')(T)).toBe('22/09/2026 03:45');
  });

  it('joins date and time with a plain space, with no locale comma', () => {
    // A combined Intl format writes `21/09/2026, 13:45`; the separator buys
    // nothing in a dense commit row.
    expect(createCommitDateFormat('en-GB', 'UTC')(T)).not.toContain(',');
  });

  it('is stable for the same instant however often it is asked', () => {
    const fmt = createCommitDateFormat('en-GB', 'UTC');
    expect(fmt(T)).toBe(fmt(T));
  });
});
