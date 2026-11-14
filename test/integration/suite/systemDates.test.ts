import * as assert from 'node:assert';
import { readSystemDates } from '../../../src/ui/systemDates';
import { compileDatePattern } from '../../../webview-ui/src/log/datePattern';

/**
 * POST-P14cg: the system's short date and time, read inside VS Code from the
 * machine running the tests — on Windows the real Region settings, through the
 * real `reg.exe`; elsewhere nothing, so the pages write the display language's.
 *
 * Read-only: it reads the registry and writes nothing.
 */
suite('System date formats (IntelliJ and System dates)', () => {
  test("reads Windows' Region settings as patterns a page can write by, and nothing elsewhere", async function () {
    this.timeout(20_000);
    const dates = await readSystemDates();
    if (process.platform !== 'win32') {
      assert.strictEqual(dates, undefined, 'only Windows keeps its formats where Node can read them');
      return;
    }
    // A Region format with a literal past ASCII is refused on purpose (D47);
    // every other machine has the two patterns.
    if (dates === undefined) return;
    assert.ok(dates.date.trim().length > 0 && dates.time.trim().length > 0, JSON.stringify(dates));
    // Windows' AM/PM letters arrive as Java's, as IntelliJ's fixWindowsFormat turns them.
    assert.ok(!/t/u.test(dates.time.replace(/'[^']*'/gu, '')), `Windows' t left in ${dates.time}`);
    const at = new Date(Date.UTC(2026, 9, 27, 17, 19));
    const date = compileDatePattern(dates.date, dates.locale, 'UTC');
    const time = compileDatePattern(dates.time, dates.locale, 'UTC');
    assert.ok(date !== undefined && time !== undefined, `a page could not write by ${JSON.stringify(dates)}`);
    // The day and the minutes are in what a page writes.
    assert.match(date(at), /27/u);
    assert.match(time(at), /19/u);
  });
});
