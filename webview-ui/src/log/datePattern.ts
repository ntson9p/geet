/**
 * Writes a date by a Java `DateTimeFormatter` pattern (POST-P14cg).
 *
 * IntelliJ keeps the system's short date and time as such patterns
 * (`DateFormatUtil.formatFromString`): on Windows they are the Region settings'
 * own pictures with Windows' letters turned into Java's (`fixWindowsFormat`:
 * `M/d/yyyy`, `h:mm a`). The host reads them (`src/ui/systemDates.ts`) and this
 * writes a commit's date by them, letter for letter as Java would:
 *
 * - `y` the year (`yy` its last two digits), `M` the month (`MMM` its short
 *   name, `MMMM` its full one), `d` the day, `E` the weekday's short name
 *   (`EEEE` the full one), `G` the era;
 * - `h` the hour 1–12, `H` 0–23, `K` 0–11, `k` 1–24, `m` minutes, `s` seconds,
 *   `a` AM or PM; a letter written twice is two digits wide;
 * - text in single quotes as it stands, `''` a quote, anything else not a
 *   letter as it stands.
 *
 * The digits are always Western and the calendar Gregorian, as a Java pattern
 * writes them whatever the locale; the locale only names months, weekdays, eras
 * and the day's half. A pattern Java would refuse (a letter it does not know, a
 * letter too often, an open quote) is refused here too, and the caller writes
 * the display language's own date instead, as IntelliJ falls back to its
 * locale's when a system pattern fails.
 */

type Token =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'field'; readonly letter: string; readonly count: number };

/** The most of each letter Java accepts in a row (`DateTimeFormatterBuilder.parseField`). */
const MAX_COUNT: Readonly<Record<string, number>> = {
  G: 5,
  y: 19,
  u: 19,
  M: 5,
  L: 5,
  d: 2,
  E: 5,
  a: 1,
  h: 2,
  H: 2,
  K: 2,
  k: 2,
  m: 2,
  s: 2,
};

/** The pattern's pieces, or nothing for one Java would refuse. */
export function parseDatePattern(pattern: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        tokens.push({ kind: 'text', text: "'" });
        i += 2;
        continue;
      }
      let text = '';
      let closed = false;
      i++;
      while (i < pattern.length) {
        if (pattern[i] === "'") {
          if (pattern[i + 1] === "'") {
            text += "'";
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        text += pattern[i];
        i++;
      }
      if (!closed) return undefined;
      tokens.push({ kind: 'text', text });
      continue;
    }
    if (/[A-Za-z]/u.test(ch)) {
      const max = MAX_COUNT[ch];
      if (max === undefined) return undefined;
      let count = 1;
      while (pattern[i + count] === ch) count++;
      if (count > max) return undefined;
      tokens.push({ kind: 'field', letter: ch, count });
      i += count;
      continue;
    }
    // Java keeps these for optional sections and future use, and refuses them bare.
    if ('[]{}#'.includes(ch)) return undefined;
    tokens.push({ kind: 'text', text: ch });
    i++;
  }
  return tokens;
}

type Width = 'short' | 'long' | 'narrow';

function textWidth(count: number): Width {
  return count === 4 ? 'long' : count === 5 ? 'narrow' : 'short';
}

/** A locale `Intl` takes; anything else is left to the display language. */
function usableLocale(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : undefined;
  } catch {
    return undefined;
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/**
 * A writer for `pattern`, or nothing when Java would refuse the pattern.
 * `timeZone` is for the tests; production writes the time where VS Code runs.
 */
export function compileDatePattern(
  pattern: string,
  locale: string | undefined,
  timeZone?: string,
): ((at: Date) => string) | undefined {
  const tokens = parseDatePattern(pattern.trim());
  if (tokens === undefined || tokens.length === 0) return undefined;
  const names = usableLocale(locale);
  const zone = timeZone !== undefined ? { timeZone } : {};
  // The numbers, in one go: en-US with a 0–23 clock writes plain digits the
  // tokens below take apart, whatever the locale (D40's way).
  const numbers = new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
    ...zone,
  });
  // The names, each built on first use and only for the letters the pattern has.
  const textFormats = new Map<string, Intl.DateTimeFormat>();
  const textFormat = (key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
    let format = textFormats.get(key);
    if (format === undefined) {
      format = new Intl.DateTimeFormat(names, { calendar: 'gregory', ...options, ...zone });
      textFormats.set(key, format);
    }
    return format;
  };

  const write = (token: Token, at: Date, n: Record<string, number>): string => {
    if (token.kind === 'text') return token.text;
    const { letter, count } = token;
    const digits = (value: number, width: number): string => String(value).padStart(width, '0');
    switch (letter) {
      case 'y':
      case 'u':
        // Java: two letters are the last two digits; any other count is the
        // whole year, at least that many digits wide.
        return count === 2 ? digits(n.year! % 100, 2) : digits(n.year!, count);
      case 'M':
      case 'L': {
        if (count <= 2) return digits(n.month!, count);
        const width = textWidth(count);
        // `M` is the month as a date says it ("27 octobre"), `L` as it stands alone.
        if (letter === 'M') {
          return part(textFormat(`M${width}`, { month: width, day: 'numeric' }).formatToParts(at), 'month');
        }
        return part(textFormat(`L${width}`, { month: width }).formatToParts(at), 'month');
      }
      case 'd':
        return digits(n.day!, count);
      case 'E': {
        const width = textWidth(count);
        return part(textFormat(`E${width}`, { weekday: width }).formatToParts(at), 'weekday');
      }
      case 'G': {
        const width = textWidth(count);
        return part(textFormat(`G${width}`, { era: width, year: 'numeric' }).formatToParts(at), 'era');
      }
      case 'a':
        return part(textFormat('a', { hour: 'numeric', hourCycle: 'h12' }).formatToParts(at), 'dayPeriod');
      case 'H':
        return digits(n.hour!, count);
      case 'h':
        return digits(((n.hour! + 11) % 12) + 1, count);
      case 'K':
        return digits(n.hour! % 12, count);
      case 'k':
        return digits(n.hour! === 0 ? 24 : n.hour!, count);
      case 'm':
        return digits(n.minute!, count);
      case 's':
        return digits(n.second!, count);
      default:
        return '';
    }
  };

  return (at: Date): string => {
    const n: Record<string, number> = {};
    for (const p of numbers.formatToParts(at)) {
      if (p.type !== 'literal') n[p.type] = Number(p.value);
    }
    let out = '';
    for (const token of tokens) out += write(token, at, n);
    return out;
  };
}
