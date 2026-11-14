import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSystemDates,
  parseInternational,
  readSystemDates,
  resetSystemDatesForTest,
  systemDatesNow,
  whenSystemDatesKnown,
  windowsPattern,
} from '../../../src/ui/systemDates';

/** What `reg query "HKCU\Control Panel\International"` prints on a US machine. */
const US_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\Control Panel\\International',
  '    Locale    REG_SZ    00000409',
  '    LocaleName    REG_SZ    en-US',
  '    s1159    REG_SZ    AM',
  '    s2359    REG_SZ    PM',
  '    sDate    REG_SZ    /',
  '    sLongDate    REG_SZ    dddd, MMMM d, yyyy',
  '    sShortDate    REG_SZ    M/d/yyyy',
  '    sShortTime    REG_SZ    h:mm tt',
  '    sTimeFormat    REG_SZ    h:mm:ss tt',
  '    iFirstDayOfWeek    REG_SZ    6',
  '',
  'HKEY_CURRENT_USER\\Control Panel\\International\\Geo',
  '',
].join('\r\n');

describe("windowsPattern — IntelliJ's fixWindowsFormat (POST-P14cg)", () => {
  it("turns Windows' letters into Java's, replacement for replacement", () => {
    expect(windowsPattern('M/d/yyyy')).toBe('M/d/yyyy');
    expect(windowsPattern('h:mm tt')).toBe('h:mm a');
    expect(windowsPattern('h:mm t')).toBe('h:mm a');
    expect(windowsPattern('tt h:mm')).toBe('a h:mm');
    expect(windowsPattern('dddd, MMMM d, yyyy')).toBe('EEEE, MMMM d, yyyy');
    expect(windowsPattern('ddd dd/MM')).toBe('E dd/MM');
    expect(windowsPattern('gg yyyy')).toBe('GG yyyy');
    expect(windowsPattern('HH:mm')).toBe('HH:mm');
  });
});

describe('parseInternational', () => {
  it("reads the short date, the short time and the locale, in Java's letters", () => {
    expect(parseInternational(US_OUTPUT)).toEqual({ date: 'M/d/yyyy', time: 'h:mm a', locale: 'en-US' });
  });

  it('reads other regions as they are set', () => {
    const gb = US_OUTPUT.replace('M/d/yyyy', 'dd/MM/yyyy').replace('h:mm tt', 'HH:mm').replace('en-US', 'en-GB');
    expect(parseInternational(gb)).toEqual({ date: 'dd/MM/yyyy', time: 'HH:mm', locale: 'en-GB' });
    const ko = US_OUTPUT.replace('M/d/yyyy', 'yyyy-MM-dd').replace('h:mm tt', 'tt h:mm').replace('en-US', 'ko-KR');
    expect(parseInternational(ko)).toEqual({ date: 'yyyy-MM-dd', time: 'a h:mm', locale: 'ko-KR' });
  });

  it('takes Unix line ends and names in any case', () => {
    const lower = US_OUTPUT.replace(/\r\n/gu, '\n').replace('sShortDate', 'SSHORTDATE');
    expect(parseInternational(lower)?.date).toBe('M/d/yyyy');
  });

  it('is nothing without both the short date and the short time', () => {
    expect(parseInternational(US_OUTPUT.replace(/^.*sShortTime.*$/mu, ''))).toBeUndefined();
    expect(parseInternational(US_OUTPUT.replace(/^.*sShortDate.*$/mu, ''))).toBeUndefined();
    expect(parseInternational('')).toBeUndefined();
    expect(parseInternational('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined();
  });

  it("refuses a value past ASCII rather than guessing at reg's code page", () => {
    const bg = US_OUTPUT.replace('M/d/yyyy', "d.M.yyyy 'ã.'");
    expect(parseInternational(bg)).toBeUndefined();
  });

  it('leaves out a locale name that is no BCP 47 tag', () => {
    expect(parseInternational(US_OUTPUT.replace('en-US', 'en US!'))).toEqual({ date: 'M/d/yyyy', time: 'h:mm a' });
  });
});

describe('readSystemDates', () => {
  it('reads nothing off Windows: no process is started', async () => {
    const query = vi.fn(() => Promise.resolve(US_OUTPUT));
    await expect(readSystemDates('darwin', query)).resolves.toBeUndefined();
    await expect(readSystemDates('linux', query)).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("reads the Region settings on Windows", async () => {
    await expect(readSystemDates('win32', () => Promise.resolve(US_OUTPUT))).resolves.toEqual({
      date: 'M/d/yyyy',
      time: 'h:mm a',
      locale: 'en-US',
    });
  });

  it('is nothing when reg fails, so the pages write the display language\'s dates', async () => {
    await expect(
      readSystemDates('win32', () => Promise.reject(new Error('spawn reg.exe ENOENT'))),
    ).resolves.toBeUndefined();
  });
});

describe('the one read a session', () => {
  const DE = { date: 'dd.MM.yyyy', time: 'HH:mm', locale: 'de-DE' };
  /** A read that finishes when the test says. */
  function heldRead(): { read: () => Promise<typeof DE | undefined>; finish: (v: typeof DE | undefined) => void } {
    let finish: (v: typeof DE | undefined) => void = () => undefined;
    const pending = new Promise<typeof DE | undefined>((resolve) => {
      finish = resolve;
    });
    return { read: () => pending, finish: (v) => finish(v) };
  }

  afterEach(() => {
    resetSystemDatesForTest();
    vi.useRealTimers();
  });

  it('is nothing until it has finished, then what it read', async () => {
    const held = heldRead();
    const loading = loadSystemDates(held.read);
    expect(systemDatesNow()).toBeUndefined();
    held.finish(DE);
    await expect(loading).resolves.toEqual(DE);
    expect(systemDatesNow()).toEqual(DE);
  });

  it('reads once: every later call shares the first read', async () => {
    const first = vi.fn(() => Promise.resolve(DE));
    const second = vi.fn(() => Promise.resolve(undefined));
    await loadSystemDates(first);
    await expect(loadSystemDates(second)).resolves.toEqual(DE);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('is nothing, not a failure, when the read throws', async () => {
    await expect(loadSystemDates(() => Promise.reject(new Error('boom')))).resolves.toBeUndefined();
    expect(systemDatesNow()).toBeUndefined();
  });

  it('runs a page at once when the formats are known', () => {
    resetSystemDatesForTest(DE);
    const then = vi.fn();
    whenSystemDatesKnown(then);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('runs a page once the read finishes, and only once, even past the timeout', async () => {
    vi.useFakeTimers();
    const held = heldRead();
    const loading = loadSystemDates(held.read);
    const then = vi.fn();
    whenSystemDatesKnown(then, 1500);
    expect(then).not.toHaveBeenCalled();
    held.finish(DE);
    await loading;
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(then).toHaveBeenCalledTimes(1);
  });

  it('does not wait past the timeout for a slow read, and runs once when it ends', async () => {
    vi.useFakeTimers();
    const held = heldRead();
    const loading = loadSystemDates(held.read);
    const then = vi.fn();
    whenSystemDatesKnown(then, 1500);
    vi.advanceTimersByTime(1499);
    expect(then).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(then).toHaveBeenCalledTimes(1);
    held.finish(DE);
    await loading;
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
  });
});
