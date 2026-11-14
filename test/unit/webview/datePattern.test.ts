import { describe, expect, it } from 'vitest';
import { compileDatePattern, parseDatePattern } from '../../../webview-ui/src/log/datePattern';

/** Tuesday 2026-10-27, 05:19:07 UTC: a one-digit hour and a one-digit... nothing else. */
const AT = new Date(Date.parse('2026-10-27T05:19:07Z'));
/** Monday 2026-01-05, 17:04:09 UTC: one-digit month and day, an afternoon. */
const PM = new Date(Date.parse('2026-01-05T17:04:09Z'));

const write = (pattern: string, at: Date, locale = 'en-US'): string | undefined =>
  compileDatePattern(pattern, locale, 'UTC')?.(at);

describe('compileDatePattern — a Java pattern, as IntelliJ keeps the system formats (POST-P14cg)', () => {
  it("writes Windows' US short date and time as IntelliJ does: 10/27/2026 5:19 AM", () => {
    expect(write('M/d/yyyy', AT)).toBe('10/27/2026');
    expect(write('h:mm a', AT)).toBe('5:19 AM');
    expect(write('M/d/yyyy h:mm a', PM)).toBe('1/5/2026 5:04 PM');
  });

  it('pads a letter written twice to two digits, and leaves a single one as it is', () => {
    expect(write('dd/MM/yyyy', PM)).toBe('05/01/2026');
    expect(write('d/M/yyyy', PM)).toBe('5/1/2026');
    expect(write('HH:mm:ss', AT)).toBe('05:19:07');
    expect(write('H:m:s', AT)).toBe('5:19:7');
  });

  it("writes the year as Java does: `yy` its last two digits, `y` and `yyyy` all of it", () => {
    expect(write('yy', AT)).toBe('26');
    expect(write('y', AT)).toBe('2026');
    expect(write('yyyy', AT)).toBe('2026');
    expect(write('yyyyy', AT)).toBe('02026');
    expect(write('uuuu', AT)).toBe('2026');
    expect(write('yy', new Date(Date.parse('2005-03-01T00:00:00Z')))).toBe('05');
  });

  it('writes the four kinds of hour', () => {
    const midnight = new Date(Date.parse('2026-10-27T00:30:00Z'));
    const noon = new Date(Date.parse('2026-10-27T12:30:00Z'));
    expect([write('H', midnight), write('h', midnight), write('K', midnight), write('k', midnight)]).toEqual([
      '0',
      '12',
      '0',
      '24',
    ]);
    expect([write('H', noon), write('h', noon), write('K', noon), write('k', noon)]).toEqual(['12', '12', '0', '12']);
    expect([write('HH', PM), write('hh', PM), write('KK', PM), write('kk', PM)]).toEqual(['17', '05', '05', '17']);
  });

  it('names months, weekdays, eras and the half of the day in the locale', () => {
    expect(write('MMM', AT)).toBe('Oct');
    expect(write('MMMM', AT)).toBe('October');
    expect(write('EEE', AT)).toBe('Tue');
    expect(write('E', AT)).toBe('Tue');
    expect(write('EEEE', AT)).toBe('Tuesday');
    expect(write('G', AT)).toBe('AD');
    expect(write('a', PM)).toBe('PM');
    expect(write('dd MMM yyyy', AT, 'de-DE')).toBe('27 Okt. 2026');
    expect(write('a h:mm', AT, 'ko-KR')).toBe('오전 5:19');
    expect(write('h:mm a', AT, 'vi-VN')).toBe('5:19 SA');
  });

  it('names a month as a date says it with `M`, and as it stands alone with `L`', () => {
    expect(write('d MMMM yyyy', AT, 'ru-RU')).toBe('27 октября 2026');
    expect(write('LLLL', AT, 'ru-RU')).toBe('октябрь');
  });

  it('writes Western digits and the Gregorian year whatever the locale, as a Java pattern does', () => {
    expect(write('yyyy/MM/dd', AT, 'ar-EG')).toBe('2026/10/27');
    expect(write('d/M/yyyy', AT, 'th-TH')).toBe('27/10/2026');
    expect(write('yyyy/MM/dd', AT, 'ja-JP-u-ca-japanese')).toBe('2026/10/27');
  });

  it('writes quoted text as it stands, and two quotes as one', () => {
    expect(write("yyyy'年'M'月'd'日'", AT)).toBe('2026年10月27日');
    expect(write("d.M.yyyy 'г.'", AT)).toBe('27.10.2026 г.');
    expect(write("h 'o''clock' a", AT)).toBe("5 o'clock AM");
    expect(write("''yy", AT)).toBe("'26");
  });

  it('writes the hour where VS Code runs, or in the zone it is given', () => {
    expect(compileDatePattern('d/M HH:mm', 'en-US', 'Asia/Ho_Chi_Minh')?.(AT)).toBe('27/10 12:19');
    expect(compileDatePattern('d/M HH:mm', 'en-US', 'Pacific/Kiritimati')?.(AT)).toBe('27/10 19:19');
    expect(compileDatePattern('d/M HH:mm', 'en-US', 'America/Los_Angeles')?.(AT)).toBe('26/10 22:19');
  });

  it('names in the display language when the locale it is given is no locale', () => {
    expect(compileDatePattern('M/d/yyyy', 'not a locale!', 'UTC')?.(AT)).toBe('10/27/2026');
  });

  it("refuses what Java's DateTimeFormatter refuses", () => {
    // A letter Java has no field for, or one the system formats never use.
    expect(compileDatePattern('yyyy-MM-dd Q', 'en-US')).toBeUndefined();
    expect(compileDatePattern('yyyy-MM-dd x', 'en-US')).toBeUndefined();
    // Too many of a letter: `ddd` is Windows' weekday, which IntelliJ turns into `E` first.
    expect(compileDatePattern('ddd', 'en-US')).toBeUndefined();
    expect(compileDatePattern('aa', 'en-US')).toBeUndefined();
    expect(compileDatePattern('HHH', 'en-US')).toBeUndefined();
    expect(compileDatePattern('MMMMMM', 'en-US')).toBeUndefined();
    // A quote left open, and the optional-section brackets.
    expect(compileDatePattern("yyyy 'open", 'en-US')).toBeUndefined();
    expect(compileDatePattern('[yyyy]', 'en-US')).toBeUndefined();
    expect(compileDatePattern('#', 'en-US')).toBeUndefined();
    // Nothing at all.
    expect(compileDatePattern('   ', 'en-US')).toBeUndefined();
  });

  it('trims the pattern, as IntelliJ does', () => {
    expect(compileDatePattern('  M/d/yyyy  ', 'en-US', 'UTC')?.(AT)).toBe('10/27/2026');
  });
});

describe('parseDatePattern', () => {
  it('splits a pattern into letters and text', () => {
    expect(parseDatePattern("d MMM, yyyy 'at' h:mm a")).toEqual([
      { kind: 'field', letter: 'd', count: 1 },
      { kind: 'text', text: ' ' },
      { kind: 'field', letter: 'M', count: 3 },
      { kind: 'text', text: ',' },
      { kind: 'text', text: ' ' },
      { kind: 'field', letter: 'y', count: 4 },
      { kind: 'text', text: ' ' },
      { kind: 'text', text: 'at' },
      { kind: 'text', text: ' ' },
      { kind: 'field', letter: 'h', count: 1 },
      { kind: 'text', text: ':' },
      { kind: 'field', letter: 'm', count: 2 },
      { kind: 'text', text: ' ' },
      { kind: 'field', letter: 'a', count: 1 },
    ]);
  });
});
