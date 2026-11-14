/**
 * The system's short date and time, read once for every webview (POST-P14cg).
 *
 * IntelliJ writes its log's dates in the OS's own formats
 * (`DateFormatUtil.getSystemFormats`). On Windows those are the user's Region
 * settings, `GetLocaleInfoEx(LOCALE_SSHORTDATE)` and `(LOCALE_SSHORTTIME)`,
 * with Windows' letters turned into Java's (`fixWindowsFormat`), joined by a
 * space. A webview cannot ask Windows, and its `Intl` speaks VS Code's display
 * language, which is often not the region: English menus over a British or a
 * Vietnamese calendar. So the host reads the same two values from where
 * Windows keeps them, `HKCU\Control Panel\International`, and every webview
 * page carries them (`buildWebviewHtml`).
 *
 * Elsewhere nothing is read: IntelliJ on macOS asks CoreFoundation, on Linux
 * `LC_TIME`, neither of which Node can reach, and the webviews keep the
 * display language's short date and time.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { SystemDatesDto } from '../shared/protocol';

/**
 * IntelliJ's `fixWindowsFormat`, replacement for replacement: Windows' era `g`,
 * weekday `ddd`/`dddd` and AM/PM `t`/`tt` in Java's letters.
 */
export function windowsPattern(picture: string): string {
  return picture
    .replaceAll('g', 'G')
    .replaceAll('dddd', 'EEEE')
    .replaceAll('ddd', 'E')
    .replaceAll('tt', 'a')
    .replaceAll('t', 'a');
}

/** One value line of `reg query`: four spaces, the name, the type, the value. */
const VALUE_LINE = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/u;

/** A BCP 47 tag Windows writes as `LocaleName` (`en-US`, `sr-Latn-RS`). */
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/**
 * The short date and time in `reg query "HKCU\Control Panel\International"`'s
 * output, or nothing when either is missing. A value with a character past
 * ASCII is refused rather than guessed at: `reg` writes the console's code
 * page, and a misread literal would be worse than the display language's date.
 */
export function parseInternational(output: string): SystemDatesDto | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = VALUE_LINE.exec(line);
    if (match) values.set(match[1]!.toLowerCase(), match[2]!);
  }
  const date = values.get('sshortdate')?.trim();
  const time = values.get('sshorttime')?.trim();
  if (date === undefined || time === undefined || date === '' || time === '') return undefined;
  if (!/^[\x20-\x7e]*$/u.test(date) || !/^[\x20-\x7e]*$/u.test(time)) return undefined;
  const locale = values.get('localename')?.trim();
  return {
    date: windowsPattern(date),
    time: windowsPattern(time),
    ...(locale !== undefined && LOCALE_TAG.test(locale) ? { locale } : {}),
  };
}

/** Runs `reg query` on the Region settings and gives its output. */
export type QueryRegion = () => Promise<string>;

const queryRegion: QueryRegion = () =>
  new Promise((resolve, reject) => {
    const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    execFile(
      reg,
      ['query', 'HKCU\\Control Panel\\International'],
      // `latin1` keeps every byte as one character, so a value past ASCII is
      // seen (and refused) rather than decoded into something else.
      { windowsHide: true, timeout: 3000, encoding: 'latin1', maxBuffer: 1 << 16 },
      (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error('reg query failed'));
        else resolve(String(stdout));
      },
    );
  });

/** The system's short date and time where they can be read, which is Windows. */
export async function readSystemDates(
  platform: NodeJS.Platform = process.platform,
  query: QueryRegion = queryRegion,
): Promise<SystemDatesDto | undefined> {
  if (platform !== 'win32') return undefined;
  try {
    return parseInternational(await query());
  } catch {
    return undefined;
  }
}

let loading: Promise<SystemDatesDto | undefined> | undefined;
let loaded: { readonly value: SystemDatesDto | undefined } | undefined;

/**
 * Starts the one read (the session's first webview page does); later calls
 * share it. `read` is for the tests.
 */
export function loadSystemDates(
  read: () => Promise<SystemDatesDto | undefined> = () => readSystemDates(),
): Promise<SystemDatesDto | undefined> {
  loading ??= read().then(
    (value) => {
      loaded = { value };
      return value;
    },
    () => {
      loaded = { value: undefined };
      return undefined;
    },
  );
  return loading;
}

/** What the read gave, once it has given it; nothing before, or where nothing is read. */
export function systemDatesNow(): SystemDatesDto | undefined {
  return loaded?.value;
}

/**
 * Runs `then` once the system's formats are known — at once when they are —
 * so a view's page is written with them. A read slower than `timeoutMs` is
 * not waited for: the page then writes the display language's dates.
 */
export function whenSystemDatesKnown(then: () => void, timeoutMs = 1500): void {
  if (loaded !== undefined) {
    then();
    return;
  }
  const wait: { done: boolean; timer?: ReturnType<typeof setTimeout> } = { done: false };
  const once = (): void => {
    if (wait.done) return;
    wait.done = true;
    clearTimeout(wait.timer);
    then();
  };
  wait.timer = setTimeout(once, timeoutMs);
  void loadSystemDates().then(once, once);
}

/** Test seam: forget the read, or stand in for it. */
export function resetSystemDatesForTest(value?: SystemDatesDto): void {
  loading = value === undefined ? undefined : Promise.resolve(value);
  loaded = value === undefined ? undefined : { value };
}
