/**
 * The merge editor's toolbar (the Result pane's editor title), as package.json
 * declares it. IntelliJ's merge window: `Apply non-conflicting changes:` Left ·
 * All · Right, then the one magic wand, Resolve Simple Conflicts; Accept Left
 * and Accept Right are buttons of their own, not toolbar icons.
 *
 * POST-QA: "Apply Non-Conflicting Changes: All" wore the wand too, so two wands
 * stood side by side; and Accept All Yours/Theirs (File) wore the same arrows
 * as Apply Non-Conflicting Right/Left, pointing the other way.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    menus: Record<string, MenuEntry[]>;
  };
};

const ON_RESULT = 'resourceScheme == geet-merge';
const iconOf = (command: string): string | undefined =>
  manifest.contributes.commands.find((c) => c.command === command)?.icon;

/** The Result pane's title entries: `navigation` is the toolbar, anything else the `…` menu. */
const entries = manifest.contributes.menus['editor/title']!.filter((m) => m.when === ON_RESULT);
const order = (m: MenuEntry): number => Number((m.group ?? '').split('@')[1] ?? 0);
const toolbar = entries
  .filter((m) => (m.group ?? '').startsWith('navigation'))
  .sort((a, b) => order(a) - order(b));

describe('the merge editor toolbar', () => {
  it('reads as IntelliJ’s: Apply, the three non-conflicting applies, the wand, Abort', () => {
    expect(toolbar.map((m) => m.command)).toEqual([
      'geet.merge.apply',
      'geet.merge.applyNonConflicting.left',
      'geet.merge.applyNonConflicting.all',
      'geet.merge.applyNonConflicting.right',
      'geet.merge.magicWand',
      'geet.merge.abortFile',
    ]);
  });

  it('draws every action with an icon of its own — one wand, one of each arrow', () => {
    const icons = toolbar.map((m) => iconOf(m.command));
    expect(icons.every((i) => i !== undefined)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
    expect(toolbar.filter((m) => iconOf(m.command) === '$(wand)').map((m) => m.command)).toEqual([
      'geet.merge.magicWand',
    ]);
  });

  it('points the non-conflicting applies from their side toward the result', () => {
    expect(iconOf('geet.merge.applyNonConflicting.left')).toBe('$(arrow-right)');
    expect(iconOf('geet.merge.applyNonConflicting.all')).toBe('$(arrow-both)');
    expect(iconOf('geet.merge.applyNonConflicting.right')).toBe('$(arrow-left)');
  });

  it('keeps the whole-file and all-files accepts in the … menu, the file ones first', () => {
    const more = entries
      .filter((m) => (m.group ?? '').startsWith('2_accept'))
      .sort((a, b) => order(a) - order(b))
      .map((m) => m.command);
    expect(more).toEqual([
      'geet.merge.acceptFileYours',
      'geet.merge.acceptFileTheirs',
      'geet.merge.acceptAllYours',
      'geet.merge.acceptAllTheirs',
    ]);
  });
});
