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
 */

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
    month: '2-digit',
    day: '2-digit',
    ...zone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...zone,
  });
  return (unixSeconds: number): string => {
    const at = new Date(unixSeconds * 1000);
    return `${date.format(at)} ${time.format(at)}`;
  };
}

/** The log's own formatter, in the host's locale and time zone. */
export const commitDate = createCommitDateFormat();
