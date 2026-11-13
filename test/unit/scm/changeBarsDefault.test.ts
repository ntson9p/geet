/**
 * POST-P14cc: GitTree's change bars are not drawn until asked for. VS Code's
 * built-in Git draws its own on the same changed lines by default, so with both
 * every changed line had two bars, and they could disagree on its kind.
 * GitTree's change actions read the computed changes, not the bars.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGE_BARS_DEFAULT, CHANGE_BARS_SETTING } from '../../../src/scm/gutter/changeBarsDefault';

const root = path.resolve(__dirname, '../../..');
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), 'utf8');
const manifest = JSON.parse(read('package.json')) as {
  contributes: { configuration: Array<{ properties: Record<string, { type?: string; default?: unknown; description?: string }> }> };
};
const nls = JSON.parse(read('package.nls.json')) as Record<string, string>;
const setting = manifest.contributes.configuration
  .map((section) => section.properties[`gittree.${CHANGE_BARS_SETTING}`])
  .find((s) => s !== undefined);

describe('GitTree change bars (POST-P14cc)', () => {
  it('are off by default, in the code as in package.json', () => {
    expect(CHANGE_BARS_SETTING).toBe('changeBars.enabled');
    expect(CHANGE_BARS_DEFAULT).toBe(false);
    expect(setting?.type).toBe('boolean');
    expect(setting?.default).toBe(CHANGE_BARS_DEFAULT);
  });

  it('say why they start off, that the change actions still work, and when to turn them on', () => {
    const key = /^%(.+)%$/u.exec(setting?.description ?? '')?.[1];
    const text = key !== undefined ? nls[key] : undefined;
    expect(text).toBeDefined();
    expect(text).toContain('with both every changed line has two');
    expect(text).toContain('Ctrl+Alt+G H');
    expect(text).toContain('Turn it on if you disable the built-in Git extension');
  });

  it('are hidden by not drawing them: the changes are still computed for the popup and the navigation', () => {
    // The controller is vscode-bound; what matters is in its source: one read
    // of the setting, and every decoration written through it.
    const source = read('src', 'scm', 'gutter', 'changeBars.ts');
    expect(source).toContain('CHANGE_BARS_SETTING, CHANGE_BARS_DEFAULT');
    expect(source).toContain('this.current.set(key, { changes, baseText: base, repo, relPath: rel });');
    for (const kind of ['added', 'modified', 'deleted']) {
      expect(source).toContain(`editor.setDecorations(this.types.${kind}, shown ? ranges.${kind} : []);`);
    }
  });
});
