/**
 * POST-QA: IntelliJ's keys are bound only with `gittree.keymap.intellij` on,
 * so a menu names them only then.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTELLIJ_KEYMAP_SETTING, shownAccelerator } from '../../../src/ui/accelerators';

describe('shownAccelerator', () => {
  it('names the key when the IntelliJ keymap binds it', () => {
    expect(shownAccelerator('Ctrl+T', true)).toBe('Ctrl+T');
  });

  it('names nothing when it does not — the default', () => {
    expect(shownAccelerator('Ctrl+Shift+K', false)).toBeUndefined();
  });

  it('names nothing for an item without a key', () => {
    expect(shownAccelerator(undefined, true)).toBeUndefined();
  });

  it('reads the setting package.json binds the keys with', () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as {
      contributes: { keybindings: { key: string; when?: string }[] };
    };
    const ctrlT = manifest.contributes.keybindings.find((k) => k.key === 'ctrl+t');
    expect(ctrlT?.when).toContain(`config.gittree.${INTELLIJ_KEYMAP_SETTING}`);
  });
});
