import { describe, expect, it } from 'vitest';
import {
  createCommitDateFormat,
  createLogDateFormat,
  formatFilterDay,
} from '../../../webview-ui/src/log/dateFormat';

/** 2026-09-21T13:45:07Z — a time that is a different *day* in some zones. */
const T = Math.floor(Date.parse('2026-09-21T13:45:07Z') / 1000);

describe('createCommitDateFormat (POST-P14z)', () => {
  it('gives the exact date and the time, not an age', () => {
    expect(createCommitDateFormat('en-GB', 'UTC')(T)).toBe('21/09/2026 13:45');
  });

  it("reads as IntelliJ's Date column does in en-US: no padded month, day or hour", () => {
    // IntelliJ: `9/5/2026 3:07 PM`, `10/29/2026 2:19 AM`.
    const early = Math.floor(Date.parse('2026-09-05T15:07:00Z') / 1000);
    expect(createCommitDateFormat('en-US', 'UTC')(early)).toMatch(/^9\/5\/2026 3:07\sPM$/u);
    const late = Math.floor(Date.parse('2026-10-29T02:19:00Z') / 1000);
    expect(createCommitDateFormat('en-US', 'UTC')(late)).toMatch(/^10\/29\/2026 2:19\sAM$/u);
  });

  it('follows the locale it is given', () => {
    // The point of leaving `locale` undefined in production: a date order is
    // a regional convention, and 9/21 vs 21/9 is not a detail.
    expect(createCommitDateFormat('en-US', 'UTC')(T)).toMatch(/^9\/21\/2026 /u);
    expect(createCommitDateFormat('de-DE', 'UTC')(T)).toBe('21.9.2026 13:45');
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

describe('createLogDateFormat (POST-P14bh, gittree.log.dateFormat)', () => {
  const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

  it('writes YYYY/MM/DD HH:mm by default: year first, two digits each, a 24-hour clock', () => {
    const ymd = createLogDateFormat('YYYY/MM/DD HH:mm', undefined, 'UTC');
    expect(ymd(T)).toBe('2026/09/21 13:45');
    // The owner's own example rows: no padded field left out, no AM/PM.
    expect(ymd(at('2026-09-05T15:07:00Z'))).toBe('2026/09/05 15:07');
    expect(ymd(at('2026-10-29T02:19:00Z'))).toBe('2026/10/29 02:19');
  });

  it('writes midnight as 00, never 24', () => {
    expect(createLogDateFormat('YYYY/MM/DD HH:mm', undefined, 'UTC')(at('2026-01-02T00:05:00Z'))).toBe(
      '2026/01/02 00:05',
    );
  });

  it('is the same whatever the locale: the format, not the region, decides', () => {
    for (const locale of ['en-US', 'de-DE', 'ja-JP', 'ar-EG']) {
      expect(createLogDateFormat('YYYY/MM/DD HH:mm', locale, 'UTC')(T), locale).toBe('2026/09/21 13:45');
    }
  });

  it('renders in the time zone it is given', () => {
    expect(createLogDateFormat('YYYY/MM/DD HH:mm', undefined, 'Asia/Ho_Chi_Minh')(T)).toBe('2026/09/21 20:45');
    expect(createLogDateFormat('YYYY/MM/DD HH:mm', undefined, 'Pacific/Kiritimati')(T)).toBe('2026/09/22 03:45');
  });

  it("keeps IntelliJ's own format as `locale`", () => {
    expect(createLogDateFormat('locale', 'en-GB', 'UTC')(T)).toBe(createCommitDateFormat('en-GB', 'UTC')(T));
    expect(createLogDateFormat('locale', 'en-US', 'UTC')(at('2026-09-05T15:07:00Z'))).toMatch(
      /^9\/5\/2026 3:07\sPM$/u,
    );
  });
});

describe('formatFilterDay (the Date ▾ chip)', () => {
  it('writes a filter day the way the Date column writes days', () => {
    expect(formatFilterDay('2026-10-31', 'YYYY/MM/DD HH:mm')).toBe('2026/10/31');
    expect(formatFilterDay('2026-10-31', 'locale', 'en-US')).toBe('10/31/2026');
    expect(formatFilterDay('2026-10-31', 'locale', 'de-DE')).toBe('31.10.2026');
  });

  it('leaves a day it cannot read as it is', () => {
    expect(formatFilterDay('last week', 'YYYY/MM/DD HH:mm')).toBe('last week');
  });
});
