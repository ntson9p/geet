import { afterEach, describe, expect, it } from 'vitest';
import type { SystemDatesDto } from '../../../src/shared/protocol';
import {
  asSystemDates,
  createCommitDateFormat,
  createDetailsDate,
  createLogDateFormat,
  dateFormatSample,
  formatFilterDay,
  minutesAgo,
  plainDateFormat,
  rint,
  systemDateWriters,
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

describe('createDetailsDate — Commit Details agrees with the Date column (POST-QA)', () => {
  it('splits the column’s YYYY/MM/DD HH:mm into “on <date> at <time>”', () => {
    expect(createDetailsDate('YYYY/MM/DD HH:mm', undefined, 'UTC')(T)).toEqual({ date: '2026/09/21', time: '13:45' });
    expect(createLogDateFormat('YYYY/MM/DD HH:mm', undefined, 'UTC')(T)).toBe('2026/09/21 13:45');
  });

  it('keeps the 24-hour clock past midnight, as the column does', () => {
    const late = Math.floor(Date.parse('2026-01-02T00:05:00Z') / 1000);
    expect(createDetailsDate('YYYY/MM/DD HH:mm', undefined, 'UTC')(late)).toEqual({ date: '2026/01/02', time: '00:05' });
  });

  it('follows the locale’s parts with `locale`, the same parts as the column', () => {
    const early = Math.floor(Date.parse('2026-09-05T15:07:00Z') / 1000);
    const parts = createDetailsDate('locale', 'en-US', 'UTC')(early);
    expect(parts.date).toBe('9/5/2026');
    expect(parts.time).toMatch(/^3:07\sPM$/u);
    expect(createLogDateFormat('locale', 'en-US', 'UTC')(early)).toBe(`${parts.date} ${parts.time}`);
  });
});

/** Windows' US Region settings, as the host reads them (`systemDates.ts`). */
const US: SystemDatesDto = { date: 'M/d/yyyy', time: 'h:mm a', locale: 'en-US' };
const DE: SystemDatesDto = { date: 'dd.MM.yyyy', time: 'HH:mm', locale: 'de-DE' };
const iso = (s: string): number => Math.floor(Date.parse(s) / 1000);

describe('the system short date and time (POST-P14cg)', () => {
  it("writes by the patterns the host read, as IntelliJ writes Windows' own", () => {
    const at = iso('2026-10-27T05:19:00Z');
    expect(createCommitDateFormat(undefined, 'UTC', { system: US })(at)).toBe('10/27/2026 5:19 AM');
    expect(createCommitDateFormat(undefined, 'UTC', { system: DE })(at)).toBe('27.10.2026 05:19');
    expect(createLogDateFormat('locale', undefined, 'UTC', { system: DE })(at)).toBe('27.10.2026 05:19');
  });

  it("joins the two with a plain space, as IntelliJ joins Windows' (no narrow space before PM)", () => {
    expect(createCommitDateFormat(undefined, 'UTC', { system: US })(iso('2026-10-27T17:19:00Z'))).toBe(
      '10/27/2026 5:19 PM',
    );
  });

  it('follows the Region settings, not the language: a British calendar under English menus', () => {
    const gb: SystemDatesDto = { date: 'dd/MM/yyyy', time: 'HH:mm', locale: 'en-GB' };
    expect(createLogDateFormat('locale', 'en-US', 'UTC', { system: gb })(iso('2026-09-05T15:07:00Z'))).toBe(
      '05/09/2026 15:07',
    );
  });

  it("writes the display language's date and time without patterns, as before", () => {
    const at = iso('2026-09-05T15:07:00Z');
    expect(createLogDateFormat('locale', 'en-US', 'UTC', { system: null })(at)).toMatch(/^9\/5\/2026 3:07\sPM$/u);
    expect(createLogDateFormat('locale', 'de-DE', 'UTC', { system: null })(at)).toBe('5.9.2026 15:07');
  });

  it("falls back to the language's when a pattern is one Java would refuse, as IntelliJ falls back to its locale's", () => {
    const broken: SystemDatesDto = { date: 'dddd', time: 'h:mm a' };
    expect(createCommitDateFormat('en-US', 'UTC', { system: broken })(iso('2026-09-05T15:07:00Z'))).toMatch(
      /^9\/5\/2026 3:07\sPM$/u,
    );
  });

  it('gives the date and the time apart, for the details and the chips', () => {
    const sys = systemDateWriters(undefined, 'UTC', US);
    const at = new Date(Date.parse('2026-10-27T05:19:00Z'));
    expect(sys.date(at)).toBe('10/27/2026');
    expect(sys.time(at)).toBe('5:19 AM');
  });

  describe('asSystemDates (what a page carries)', () => {
    it('takes two patterns and a locale', () => {
      expect(asSystemDates({ date: 'M/d/yyyy', time: 'h:mm a', locale: 'en-US' })).toEqual(US);
      expect(asSystemDates({ date: 'M/d/yyyy', time: 'h:mm a' })).toEqual({ date: 'M/d/yyyy', time: 'h:mm a' });
    });

    it('refuses anything else', () => {
      expect(asSystemDates(undefined)).toBeUndefined();
      expect(asSystemDates(null)).toBeUndefined();
      expect(asSystemDates('M/d/yyyy')).toBeUndefined();
      expect(asSystemDates({ date: 'M/d/yyyy' })).toBeUndefined();
      expect(asSystemDates({ date: ' ', time: 'h:mm a' })).toBeUndefined();
      expect(asSystemDates({ date: 'M/d/yyyy', time: 'h:mm a', locale: 3 })).toEqual({
        date: 'M/d/yyyy',
        time: 'h:mm a',
      });
    });
  });

  describe("the page's own patterns", () => {
    const page = globalThis as { __gittreeSystemDates?: unknown };
    afterEach(() => {
      delete page.__gittreeSystemDates;
    });

    it('are read from `window.__gittreeSystemDates` when the caller names none', () => {
      page.__gittreeSystemDates = DE;
      // A zone named makes these the caller's own writers, not the page's cached ones.
      expect(createCommitDateFormat(undefined, 'UTC')(iso('2026-10-27T05:19:00Z'))).toBe('27.10.2026 05:19');
    });

    it('are left alone when the caller says `null`', () => {
      page.__gittreeSystemDates = DE;
      expect(createCommitDateFormat('en-US', 'UTC', { system: null })(iso('2026-10-27T05:19:00Z'))).toMatch(
        /^10\/27\/2026 5:19\sAM$/u,
      );
    });
  });
});

describe("pretty: IntelliJ's log as it ships (`formatPrettyDateTime`, POST-P14cg)", () => {
  /** Saturday 2026-11-14, 15:00 UTC. */
  const NOW = Date.parse('2026-11-14T15:00:00Z');
  const pretty = createLogDateFormat('pretty', undefined, 'UTC', { system: US, now: () => NOW });
  const ago = (ms: number): string => pretty(Math.floor((NOW - ms) / 1000));
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;

  it("writes the minutes within the hour, in IntelliJ's words", () => {
    expect(ago(0)).toBe('Moments ago');
    expect(ago(29 * SECOND)).toBe('Moments ago');
    expect(ago(31 * SECOND)).toBe('A minute ago');
    expect(ago(MINUTE)).toBe('A minute ago');
    expect(ago(5 * MINUTE)).toBe('5 minutes ago');
    expect(ago(59 * MINUTE)).toBe('59 minutes ago');
    expect(ago(60 * MINUTE)).toBe('1 hour ago');
  });

  it("rounds as Java's Math.rint does: a half goes to the even number", () => {
    expect(ago(30 * SECOND)).toBe('Moments ago');
    expect(ago(90 * SECOND)).toBe('2 minutes ago');
    expect(ago(150 * SECOND)).toBe('2 minutes ago');
    expect(ago(59.5 * MINUTE)).toBe('1 hour ago');
  });

  it('keeps to the minutes for an hour and a minute, then gives the time of day', () => {
    expect(ago(61 * MINUTE)).toBe('1 hour ago');
    expect(ago(61 * MINUTE + SECOND)).toBe('Today 1:58 PM');
    expect(ago(3 * 60 * MINUTE)).toBe('Today 12:00 PM');
    expect(pretty(iso('2026-11-14T00:00:00Z'))).toBe('Today 12:00 AM');
  });

  it("writes yesterday's commits as Yesterday and the time", () => {
    expect(pretty(iso('2026-11-13T23:59:00Z'))).toBe('Yesterday 11:59 PM');
    expect(pretty(iso('2026-11-13T00:00:00Z'))).toBe('Yesterday 12:00 AM');
  });

  it('writes anything older as the system writes a date and time', () => {
    expect(pretty(iso('2026-11-12T23:59:00Z'))).toBe('11/12/2026 11:59 PM');
    expect(pretty(iso('2025-11-14T15:00:00Z'))).toBe('11/14/2025 3:00 PM');
  });

  it('writes a commit dated later today (a clock running ahead) as Today, and a later day in full', () => {
    expect(pretty(iso('2026-11-14T20:00:00Z'))).toBe('Today 8:00 PM');
    expect(pretty(iso('2026-11-14T15:00:01Z'))).toBe('Today 3:00 PM');
    expect(pretty(iso('2026-11-15T01:00:00Z'))).toBe('11/15/2026 1:00 AM');
  });

  it('counts minutes before days, as IntelliJ does: past midnight, a late commit is minutes ago', () => {
    const newYear = Date.parse('2027-01-01T00:20:00Z');
    const f = createLogDateFormat('pretty', undefined, 'UTC', { system: US, now: () => newYear });
    expect(f(iso('2026-12-31T23:50:00Z'))).toBe('30 minutes ago');
    // Yesterday across the turn of the year.
    expect(f(iso('2026-12-31T22:00:00Z'))).toBe('Yesterday 10:00 PM');
    expect(f(iso('2026-12-30T22:00:00Z'))).toBe('12/30/2026 10:00 PM');
  });

  it('decides today and yesterday by the calendar where VS Code runs', () => {
    // 15:00 UTC is 22:00 in Ho Chi Minh City: 16:30 UTC the day before is 23:30 there, yesterday.
    const f = createLogDateFormat('pretty', undefined, 'Asia/Ho_Chi_Minh', { system: US, now: () => NOW });
    expect(f(iso('2026-11-13T16:30:00Z'))).toBe('Yesterday 11:30 PM');
    expect(f(iso('2026-11-13T17:30:00Z'))).toBe('Today 12:30 AM');
  });

  it('reads the clock each time it writes, so the same commit ages', () => {
    let now = NOW;
    const f = createLogDateFormat('pretty', undefined, 'UTC', { system: US, now: () => now });
    const at = Math.floor(NOW / 1000);
    expect(f(at)).toBe('Moments ago');
    now += 5 * MINUTE;
    expect(f(at)).toBe('5 minutes ago');
    now += 2 * 60 * MINUTE;
    expect(f(at)).toBe('Today 3:00 PM');
  });

  it("writes the display language's time without patterns", () => {
    const f = createLogDateFormat('pretty', 'en-US', 'UTC', { system: null, now: () => NOW });
    expect(f(iso('2026-11-14T10:00:00Z'))).toMatch(/^Today 10:00\sAM$/u);
    expect(f(iso('2026-11-12T10:00:00Z'))).toMatch(/^11\/12\/2026 10:00\sAM$/u);
  });

  it('rint and the words, on their own', () => {
    expect([0.5, 1.5, 2.5, 3.5, 0.49, 0.51].map(rint)).toEqual([0, 2, 2, 4, 0, 1]);
    expect([0, 1, 2, 59, 60, 61].map(minutesAgo)).toEqual([
      'Moments ago',
      'A minute ago',
      '2 minutes ago',
      '59 minutes ago',
      '1 hour ago',
      '1 hour ago',
    ]);
  });
});

describe('pretty everywhere else a date is written (POST-P14cg)', () => {
  const at = iso('2026-10-27T05:19:00Z');

  it("gives Commit Details the system's date and time, never Today: IntelliJ's details call formatDate and formatTime", () => {
    expect(createDetailsDate('pretty', undefined, 'UTC', { system: US })(at)).toEqual({
      date: '10/27/2026',
      time: '5:19 AM',
    });
    expect(createDetailsDate('pretty', undefined, 'UTC', { system: US })(at)).toEqual(
      createDetailsDate('locale', undefined, 'UTC', { system: US })(at),
    );
  });

  it('writes the committer line in full: pretty is plain there', () => {
    expect(plainDateFormat('pretty')).toBe('locale');
    expect(plainDateFormat('locale')).toBe('locale');
    expect(plainDateFormat('YYYY/MM/DD HH:mm')).toBe('YYYY/MM/DD HH:mm');
  });

  it("writes a Date ▾ chip's day in the system's short date", () => {
    expect(formatFilterDay('2026-10-31', 'pretty', undefined, { system: US })).toBe('10/31/2026');
    expect(formatFilterDay('2026-10-31', 'locale', undefined, { system: DE })).toBe('31.10.2026');
    expect(formatFilterDay('2026-10-31', 'pretty', 'en-US', { system: null })).toBe('10/31/2026');
  });
});

describe('dateFormatSample (Presentation Settings ▸ Date Format, POST-P14cg)', () => {
  const now = new Date(2026, 10, 14, 9, 5).getTime();

  it('shows each format writing today at 14:19', () => {
    expect(dateFormatSample('YYYY/MM/DD HH:mm', now)).toBe('2026/11/14 14:19');
    expect(dateFormatSample('pretty', now, { system: US })).toBe('Today 2:19 PM');
    expect(dateFormatSample('locale', now, { system: US })).toBe('11/14/2026 2:19 PM');
  });

  it("shows IntelliJ's Today even within the hour of 14:19, where the column would say minutes", () => {
    const soon = new Date(2026, 10, 14, 14, 30).getTime();
    expect(dateFormatSample('pretty', soon, { system: US })).toBe('Today 2:19 PM');
  });
});
