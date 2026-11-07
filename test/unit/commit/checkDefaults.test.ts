/**
 * POST-P14bg: every commit check starts unticked (D38). IntelliJ ticks Analyze
 * code and Check TODO; the owner wants none on until they ask. The defaults
 * live twice, in package.json and in CHECK_DEFAULTS, and must agree.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_DEFAULTS } from '../../../src/commit/checks/checkDefaults';

interface Setting {
  type?: string;
  default?: unknown;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { configuration: Array<{ properties: Record<string, Setting> }> };
};
const settings: Record<string, Setting> = {};
for (const section of manifest.contributes.configuration) Object.assign(settings, section.properties);
const PREFIX = 'gittree.commit.checks.';

describe('commit check defaults', () => {
  it('ticks no check, Analyze code and Check TODO included', () => {
    expect(CHECK_DEFAULTS).toEqual({
      reformat: false,
      optimizeImports: false,
      cleanup: false,
      analyze: false,
      todo: false,
    });
  });

  it.each(Object.keys(CHECK_DEFAULTS))('package.json defaults %s to false', (id) => {
    const setting = settings[`${PREFIX}${id}`];
    expect(setting, `${PREFIX}${id} is contributed`).toBeDefined();
    expect(setting?.type).toBe('boolean');
    expect(setting?.default).toBe(false);
    expect(setting?.default).toBe(CHECK_DEFAULTS[id as keyof typeof CHECK_DEFAULTS]);
  });

  it('a check added to package.json is a check CHECK_DEFAULTS knows', () => {
    // Every boolean under gittree.commit.checks.* is a check box, save the
    // "Run advanced checks after a commit is done" mode.
    const booleans = Object.keys(settings)
      .filter((key) => key.startsWith(PREFIX) && settings[key]?.type === 'boolean')
      .map((key) => key.slice(PREFIX.length))
      .filter((id) => id !== 'deferAdvanced')
      .sort();
    expect(booleans).toEqual(Object.keys(CHECK_DEFAULTS).sort());
  });

  it('leaves "Run advanced checks after a commit is done" ticked', () => {
    // When the user does tick Analyze or TODO, they still run after the commit
    // and never hold it up, as in IntelliJ.
    expect(settings[`${PREFIX}deferAdvanced`]?.default).toBe(true);
  });
});
