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
 * or hour.
 *
 * POST-P14bh: that is now the `locale` choice of `geet.log.dateFormat`. The
 * default is `YYYY/MM/DD HH:mm` (owner's choice, 2026-11-07; D40).
 *
 * POST-P14cg: a third choice, `pretty`, is IntelliJ's log as it ships
 * (`DateFormatUtil.formatPrettyDateTime`): `Moments ago`, `5 minutes ago` and
 * `1 hour ago` within the hour, `Today 2:19 PM`, `Yesterday 2:19 PM`, and the
 * system's short date and time before that. `pretty` and `locale` now write the
 * *system's* short date and time, as IntelliJ does: the patterns the host read
 * from the OS (Windows' Region settings, `window.__geetSystemDates`), or,
 * without them, the display language's as before.
 */

import type { LogDateFormat, SystemDatesDto } from '../../../src/shared/protocol';
import { compileDatePattern } from './datePattern';

/** What the tests pin; production passes neither and follows the page and the clock. */
export interface DateFormatOptions {
  /**
   * The system's patterns. Left out: the page's (`window.__geetSystemDates`).
   * `null`: none, so the display language's date and time are written.
   */
  readonly system?: SystemDatesDto | null;
  /** The clock `pretty` measures against ("Today", "5 minutes ago"). */
  readonly now?: () => number;
}

/** What a page's `window.__geetSystemDates` holds, if it is usable. */
export function asSystemDates(raw: unknown): SystemDatesDto | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== 'string' || typeof r.time !== 'string') return undefined;
  if (r.date.trim() === '' || r.time.trim() === '') return undefined;
  return {
    date: r.date,
    time: r.time,
    ...(typeof r.locale === 'string' && r.locale !== '' ? { locale: r.locale } : {}),
  };
}

/**
 * The system's patterns this page was given by the host, if any
 * (`window.__geetSystemDates`; `globalThis`, so the tests' Node reads none).
 */
function pageSystemDates(): SystemDatesDto | undefined {
  return asSystemDates((globalThis as { __geetSystemDates?: unknown }).__geetSystemDates);
}

/** The system's short date and short time (IntelliJ's `formatDate` and `formatTime`). */
export interface SystemDateWriters {
  /** `10/27/2026` */
  readonly date: (at: Date) => string;
  /** `5:19 AM` */
  readonly time: (at: Date) => string;
}

/**
 * The display language's short date with a four-digit year and its short time
 * — `createCommitDateFormat`'s parts since POST-P14z, and what a page without
 * the system's patterns writes.
 */
function languageWriters(locale: string | undefined, timeZone: string | undefined): SystemDateWriters {
  const zone = timeZone !== undefined ? { timeZone } : {};
  // Constructed once per formatter, not per row: `Intl.DateTimeFormat` is
  // expensive to build and this runs for every visible row on every repaint.
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...zone,
  });
  // The language's own short time, as Java's `DateFormat.SHORT` gives IntelliJ
  // where there are no system patterns: `3:07 PM`, `03:45` in en-GB. Not
  // `hour: 'numeric'`, which ICU 78 (Node 24) writes `3:45` in en-GB.
  const time = new Intl.DateTimeFormat(locale, {
    timeStyle: 'short',
    ...zone,
  });
  return { date: (at) => date.format(at), time: (at) => time.format(at) };
}

/** The page's own writers, built once: production asks with no arguments. */
let pageWriters: SystemDateWriters | undefined;

/**
 * The system's short date and time: by the patterns the host read from the OS
 * when there are any and both are patterns Java would take, otherwise in the
 * display language (`locale`, VS Code's when undefined).
 */
export function systemDateWriters(
  locale?: string,
  timeZone?: string,
  system?: SystemDatesDto | null,
): SystemDateWriters {
  const own = locale === undefined && timeZone === undefined && system === undefined;
  if (own && pageWriters !== undefined) return pageWriters;
  const patterns = system === undefined ? pageSystemDates() : (system ?? undefined);
  let writers: SystemDateWriters | undefined;
  if (patterns !== undefined) {
    const names = patterns.locale ?? locale;
    const date = compileDatePattern(patterns.date, names, timeZone);
    const time = compileDatePattern(patterns.time, names, timeZone);
    if (date !== undefined && time !== undefined) writers = { date, time };
  }
  writers ??= languageWriters(locale, timeZone);
  if (own) pageWriters = writers;
  return writers;
}

/**
 * Builds a formatter for IntelliJ's full date and time (`formatDateTime`): the
 * system's short date and short time, joined by a space as IntelliJ joins
 * Windows' two. The arguments exist so tests can pin a locale and zone;
 * production passes neither and follows the host's.
 */
export function createCommitDateFormat(
  locale?: string,
  timeZone?: string,
  options: DateFormatOptions = {},
): (unixSeconds: number) => string {
  const sys = systemDateWriters(locale, timeZone, options.system);
  return (unixSeconds: number): string => {
    const at = new Date(unixSeconds * 1000);
    return `${sys.date(at)} ${sys.time(at)}`;
  };
}

/** IntelliJ's format in the host's locale and time zone (the Push dialog's, and `locale`'s). */
export const commitDate = createCommitDateFormat();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Java's `Math.rint`: to the nearest whole number, and from a half to the even one. */
export function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(r - x) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * IntelliJ's `date.format.minutes.ago` (`UtilBundle`):
 * `{0,choice, 0#Moments|1#A minute|2#{0,number} minutes|60#1 hour} ago`.
 */
export function minutesAgo(minutes: number): string {
  if (minutes < 1) return 'Moments ago';
  if (minutes < 2) return 'A minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  return '1 hour ago';
}

/** The calendar day an instant falls on where VS Code runs (or in `timeZone`), as a day count. */
function dayCounter(timeZone: string | undefined): (ms: number) => number {
  const parts = new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  return (ms: number): number => {
    const d: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const p of parts.formatToParts(new Date(ms))) d[p.type] = p.value;
    return Math.round(Date.UTC(Number(d.year), Number(d.month) - 1, Number(d.day)) / DAY);
  };
}

/**
 * IntelliJ's `DateFormatUtil.formatPrettyDateTime`, rule for rule:
 *
 * 1. up to an hour and a minute ago, the minutes, rounded (`Math.rint`):
 *    `Moments ago`, `A minute ago`, `5 minutes ago`, `1 hour ago` — even
 *    across midnight, since this rule comes first;
 * 2. on today's date, `Today` and the short time (a commit dated later today
 *    too, from a clock running ahead);
 * 3. on yesterday's, `Yesterday` and the short time;
 * 4. otherwise the short date and time, as `locale` writes them.
 */
export function prettyDateTime(
  atMs: number,
  nowMs: number,
  sys: SystemDateWriters,
  dayOf: (ms: number) => number,
): string {
  const delta = nowMs - atMs;
  if (delta >= 0 && delta <= HOUR + MINUTE) return minutesAgo(rint(delta / MINUTE));
  const at = new Date(atMs);
  const day = dayOf(atMs);
  const today = dayOf(nowMs);
  if (day === today) return `Today ${sys.time(at)}`;
  if (day === today - 1) return `Yesterday ${sys.time(at)}`;
  return `${sys.date(at)} ${sys.time(at)}`;
}

/**
 * The Date column's formatter for `geet.log.dateFormat` (D40).
 *
 * `YYYY/MM/DD HH:mm` — the default — reads the same everywhere: year first,
 * every field two digits wide, a 24-hour clock, so the column lines up and
 * sorts by eye. `locale` is IntelliJ's full date and time,
 * `createCommitDateFormat`; `pretty` is IntelliJ's log as it ships,
 * `prettyDateTime`, which reads the clock on every call.
 */
export function createLogDateFormat(
  format: LogDateFormat,
  locale?: string,
  timeZone?: string,
  options: DateFormatOptions = {},
): (unixSeconds: number) => string {
  if (format === 'locale') return createCommitDateFormat(locale, timeZone, options);
  if (format === 'pretty') {
    const sys = systemDateWriters(locale, timeZone, options.system);
    const dayOf = dayCounter(timeZone);
    const now = options.now ?? Date.now;
    return (unixSeconds: number): string => prettyDateTime(unixSeconds * 1000, now(), sys, dayOf);
  }
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
 * `2026/11/07 21:27`. IntelliJ writes both with the one date format. With
 * `pretty` the line is the system's date and time, never "Today": IntelliJ's
 * details call `formatDate` and `formatTime` (`CommitPresentationUtil`).
 */
export function createDetailsDate(
  format: LogDateFormat,
  locale?: string,
  timeZone?: string,
  options: DateFormatOptions = {},
): (unixSeconds: number) => { date: string; time: string } {
  if (format === 'locale' || format === 'pretty') {
    const sys = systemDateWriters(locale, timeZone, options.system);
    return (unixSeconds: number) => {
      const at = new Date(unixSeconds * 1000);
      return { date: sys.date(at), time: sys.time(at) };
    };
  }
  const zone = timeZone !== undefined ? { timeZone } : {};
  const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', ...zone });
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone });
  return (unixSeconds: number) => {
    const at = new Date(unixSeconds * 1000);
    const d: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of date.formatToParts(at)) d[part.type] = part.value;
    const t: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of time.formatToParts(at)) t[part.type] = part.value;
    return { date: `${d.year}/${d.month}/${d.day}`, time: `${t.hour}:${t.minute}` };
  };
}

/**
 * The format a commit's full date is written in where a word like "Today"
 * would not do (the details' `committed by … · <date>`): `pretty` is the
 * system's date and time there, as IntelliJ's details are.
 */
export function plainDateFormat(format: LogDateFormat): LogDateFormat {
  return format === 'pretty' ? 'locale' : format;
}

/**
 * A `Date ▾` filter bound (`2026-10-31`, a calendar day with no time or zone)
 * written the way the Date column writes dates — `pretty` and `locale` alike
 * in the system's short date, as IntelliJ's chip (`formatDate`).
 */
export function formatFilterDay(
  isoDay: string,
  format: LogDateFormat,
  locale?: string,
  options: DateFormatOptions = {},
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDay);
  if (!match) return isoDay;
  if (format !== 'locale' && format !== 'pretty') return `${match[1]}/${match[2]}/${match[3]}`;
  // Local midnight of that day: a day has no zone to convert from.
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return systemDateWriters(locale, undefined, options.system).date(day);
}

/**
 * What each choice of Presentation Settings ▸ Date Format looks like, for the
 * menu: today at 14:19, as the column would write it. `pretty` is asked late in
 * the evening, so it shows its `Today` rather than `11 minutes ago`.
 */
export function dateFormatSample(
  format: LogDateFormat,
  nowMs: number = Date.now(),
  options: DateFormatOptions = {},
): string {
  const today = new Date(nowMs);
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 14, 19);
  const evening = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59).getTime();
  return createLogDateFormat(format, undefined, undefined, { ...options, now: () => evening })(
    Math.floor(at.getTime() / 1000),
  );
}

/**
 * A date as wide as the column ever needs: IntelliJ sizes its Date column by
 * one sample date-time rather than by the rows. Two-digit month, day and hour
 * where the locale allows them, and an afternoon, so `PM` is in it. With
 * `pretty` IntelliJ sizes it by the rows instead (`autoTextWidth`), since
 * `Moments ago` and a full date are far apart.
 */
export const SAMPLE_COMMIT_TIME = Math.floor(new Date(2026, 11, 28, 22, 58).getTime() / 1000);
