/**
 * Commit-row date formatting (POST-P14z).
 *
 * The log shows the **exact** date and time, as IntelliJ's Date column does.
 * A relative age (`10d`, `3mo`) is compact and answers the wrong question: two
 * commits both reading `2mo` may be six weeks apart, and "was this before or
 * after the release?" — the reason anyone looks at the column — cannot be
 * answered from it at all.
 *
 * Date and time are formatted separately and joined with a space rather than
 * asked for together: a combined `Intl` format inserts a locale separator
 * (`, ` in en-US) that buys nothing in a dense row.
 *
 * The parts are IntelliJ's `DateFormatUtil.formatDateTime`: the locale's short
 * date with a four-digit year and its short time, so en-US reads
 * `9/5/2026 3:07 PM` exactly as IntelliJ's Date column does — no padded month
 * or hour. IntelliJ's "Today"/"Yesterday" wording is not used: the column
 * always gives the full date (owner's choice, 2026-11-01).
 *
 * POST-P14bh: that is now the `locale` choice of `gittree.log.dateFormat`. The
 * default is `YYYY/MM/DD HH:mm` (owner's choice, 2026-11-07; D40).
 */

import type { LogDateFormat } from '../../../src/shared/protocol';

/**
 * Builds a formatter. The arguments exist so tests can pin a locale and zone;
 * production passes neither and follows the host's.
 */
export function createCommitDateFormat(
  locale?: string,
  timeZone?: string,
): (unixSeconds: number) => string {
  const zone = timeZone !== undefined ? { timeZone } : {};
  // Constructed once per formatter, not per row: `Intl.DateTimeFormat` is
  // expensive to build and this runs for every visible row on every repaint.
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...zone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...zone,
  });
  return (unixSeconds: number): string => {
    const at = new Date(unixSeconds * 1000);
    return `${date.format(at)} ${time.format(at)}`;
  };
}

/** IntelliJ's format in the host's locale and time zone (the Push dialog's, and `locale`'s). */
export const commitDate = createCommitDateFormat();

/**
 * The Date column's formatter for `gittree.log.dateFormat` (D40).
 *
 * `YYYY/MM/DD HH:mm` — the default — reads the same everywhere: year first,
 * every field two digits wide, a 24-hour clock, so the column lines up and
 * sorts by eye. `locale` is IntelliJ's own, `createCommitDateFormat`.
 */
export function createLogDateFormat(
  format: LogDateFormat,
  locale?: string,
  timeZone?: string,
): (unixSeconds: number) => string {
  if (format === 'locale') return createCommitDateFormat(locale, timeZone);
  // The digits only, in a fixed order: the locale decides nothing here, so
  // `en-US` stands in for any. `h23`, not `hour12: false`, which some engines
  // write as `24:05` past midnight.
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  return (unixSeconds: number): string => {
    const at: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of parts.formatToParts(new Date(unixSeconds * 1000))) at[part.type] = part.value;
    return `${at.year}/${at.month}/${at.day} ${at.hour}:${at.minute}`;
  };
}

/**
 * The Commit Details line's `on <date> at <time>`, in the Date column's format
 * (POST-QA): it read `11/7/2026 at 09:27 PM` beside a column reading
 * `2026/11/07 21:27`. IntelliJ writes both with the one date format.
 */
export function createDetailsDate(
  format: LogDateFormat,
  locale?: string,
  timeZone?: string,
): (unixSeconds: number) => { date: string; time: string } {
  const zone = timeZone !== undefined ? { timeZone } : {};
  const ymd = format !== 'locale';
  const date = new Intl.DateTimeFormat(ymd ? 'en-US' : locale, {
    year: 'numeric',
    month: ymd ? '2-digit' : 'numeric',
    day: ymd ? '2-digit' : 'numeric',
    ...zone,
  });
  const time = new Intl.DateTimeFormat(ymd ? 'en-US' : locale, {
    hour: ymd ? '2-digit' : 'numeric',
    minute: '2-digit',
    ...(ymd ? { hourCycle: 'h23' as const } : {}),
    ...zone,
  });
  return (unixSeconds: number) => {
    const at = new Date(unixSeconds * 1000);
    if (!ymd) return { date: date.format(at), time: time.format(at) };
    const d: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of date.formatToParts(at)) d[part.type] = part.value;
    const t: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of time.formatToParts(at)) t[part.type] = part.value;
    return { date: `${d.year}/${d.month}/${d.day}`, time: `${t.hour}:${t.minute}` };
  };
}

/**
 * A `Date ▾` filter bound (`2026-10-31`, a calendar day with no time or zone)
 * written the way the Date column writes dates.
 */
export function formatFilterDay(isoDay: string, format: LogDateFormat, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDay);
  if (!match) return isoDay;
  if (format !== 'locale') return `${match[1]}/${match[2]}/${match[3]}`;
  // Local midnight of that day: a day has no zone to convert from.
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(day);
}

/**
 * A date as wide as the column ever needs: IntelliJ sizes its Date column by
 * one sample date-time rather than by the rows. Two-digit month, day and hour
 * where the locale allows them, and an afternoon, so `PM` is in it.
 */
export const SAMPLE_COMMIT_TIME = Math.floor(new Date(2026, 11, 28, 22, 58).getTime() / 1000);
