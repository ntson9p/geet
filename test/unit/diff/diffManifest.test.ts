import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}
interface Keybinding {
  command: string;
  key: string;
  mac?: string;
  when?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  engines: { vscode: string };
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string; enablement?: string }>;
    menus: Record<string, MenuEntry[]>;
    submenus?: Array<{ id: string }>;
    keybindings: Keybinding[];
    configuration: Array<{ properties: Record<string, { type?: string; default?: unknown; description?: string }> }>;
  };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

/**
 * The menus VS Code has, from `menusExtensionPoint.ts` at 1.96.0, the oldest we
 * support. It drops any other key from a manifest without a word, which is how
 * Geet's diff arrows sat under `editor/title/navigation`, passing their tests
 * and never once on screen.
 */
const VSCODE_MENUS = new Set([
  'commandPalette',
  'touchBar',
  'editor/title',
  'editor/title/run',
  'editor/context',
  'editor/context/copy',
  'editor/context/share',
  'explorer/context',
  'explorer/context/share',
  'editor/title/context',
  'editor/title/context/share',
  'debug/callstack/context',
  'debug/variables/context',
  'debug/toolBar',
  'debug/createConfiguration',
  'notebook/variables/context',
  'menuBar/home',
  'menuBar/edit/copy',
  'scm/title',
  'scm/sourceControl',
  'scm/sourceControl/title',
  'scm/resourceState/context',
  'scm/resourceFolder/context',
  'scm/resourceGroup/context',
  'scm/change/title',
  'scm/inputBox',
  'scm/history/title',
  'scm/historyItem/context',
  'scm/historyItemRef/context',
  'statusBar/remoteIndicator',
  'terminal/context',
  'terminal/title/context',
  'view/title',
  'viewContainer/title',
  'view/item/context',
  'comments/comment/editorActions',
  'comments/commentThread/title',
  'comments/commentThread/context',
  'comments/commentThread/additionalActions',
  'comments/commentThread/title/context',
  'comments/comment/title',
  'comments/comment/context',
  'comments/commentThread/comment/context',
  'commentsView/commentThread/context',
  'notebook/toolbar',
  'notebook/kernelSource',
  'notebook/cell/title',
  'notebook/cell/execute',
  'interactive/toolbar',
  'interactive/cell/title',
  'issue/reporter',
  'testing/item/context',
  'testing/item/gutter',
  'testing/profiles/context',
  'testing/item/result',
  'testing/message/context',
  'testing/message/content',
  'extension/context',
  'timeline/title',
  'timeline/item/context',
  'ports/item/context',
  'ports/item/origin/inline',
  'ports/item/port/inline',
  'file/newFile',
  'webview/context',
  'file/share',
  'editor/inlineCompletions/actions',
  'editor/content',
  'editor/lineNumber/context',
  'mergeEditor/result/title',
  'multiDiffEditor/resource/title',
  'diffEditor/gutter/hunk',
  'diffEditor/gutter/selection',
]);

const editorTitle = manifest.contributes.menus['editor/title'] ?? [];
const fileArrows = editorTitle.filter((e) => /^gittree\.diff\.(next|prev)File$/u.test(e.command ?? ''));

describe('the manifest', () => {
  it('names only menus VS Code has', () => {
    const own = new Set((manifest.contributes.submenus ?? []).map((s) => s.id));
    const unknown = Object.keys(manifest.contributes.menus).filter((k) => !VSCODE_MENUS.has(k) && !own.has(k));
    expect(unknown).toEqual([]);
  });

  it('supports the version the menu list was taken from', () => {
    expect(manifest.engines.vscode).toBe('^1.96.0');
  });
});

describe("the diff toolbar's file arrows", () => {
  it('are on the toolbar itself, not in its overflow menu', () => {
    expect(fileArrows.map((e) => e.command)).toEqual(['gittree.diff.prevFile', 'gittree.diff.nextFile']);
    for (const e of fileArrows) expect(e.group).toMatch(/^navigation@/u);
  });

  it("sit right after VS Code's own ↑ ↓, which are 10 and 11 of the same group", () => {
    expect(fileArrows.map((e) => e.group)).toEqual(['navigation@12', 'navigation@13']);
  });

  it('show on Geet diffs only', () => {
    for (const e of fileArrows) expect(e.when).toBe('isInDiffEditor && gittree.diff.active');
  });

  it('are greyed out at either end of the list', () => {
    const command = (id: string) => manifest.contributes.commands.find((c) => c.command === id);
    expect(command('gittree.diff.prevFile')?.enablement).toBe('gittree.diff.hasPrevFile');
    expect(command('gittree.diff.nextFile')?.enablement).toBe('gittree.diff.hasNextFile');
  });

  it('use the wording IntelliJ does', () => {
    expect(nls['gittree.command.diff.prevFile.title']).toBe('Compare Previous File');
    expect(nls['gittree.command.diff.nextFile.title']).toBe('Compare Next File');
  });

  it('have keys whatever the keymap: their tooltip shows the key either way', () => {
    // VS Code's tooltip ignores a binding's `when`, so a key behind
    // `gittree.keymap.intellij` would be shown to people for whom it does nothing.
    for (const id of ['gittree.diff.prevFile', 'gittree.diff.nextFile']) {
      const binding = manifest.contributes.keybindings.find((k) => k.command === id);
      expect(binding?.when).toBe('gittree.diff.active && editorTextFocus');
    }
  });
});

describe("the Commit window row's Open Changes", () => {
  const menu = manifest.contributes.menus['webview/context'] ?? [];
  const rowItems = menu.filter((e) => e.when?.includes("webviewSection == 'commitFile'"));

  it('goes through the window, which knows the order and the selection', () => {
    const open = rowItems.find((e) => e.group === '1_open@1');
    expect(open?.command).toBe('gittree.commit.openChanges');
    expect(rowItems.map((e) => e.command)).not.toContain('gittree.openDiff');
  });

  it('keeps its name, and stays out of the palette: it means nothing without a row', () => {
    const command = manifest.contributes.commands.find((c) => c.command === 'gittree.commit.openChanges');
    expect(command?.title).toBe('%gittree.command.openDiff.title%');
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    expect(palette.find((e) => e.command === 'gittree.commit.openChanges')?.when).toBe('false');
  });
});

describe("taking over VS Code's own next and previous change", () => {
  it('adds no arrows of its own beside them', () => {
    // The button is theirs, and it now does this; a second pair would only differ
    // by doing the same thing.
    const changeArrows = Object.values(manifest.contributes.menus)
      .flat()
      .filter((e) => /^gittree\.diff\.(next|prev)Change$/u.test(e.command ?? ''));
    expect(changeArrows).toEqual([]);
  });

  it('can be turned off, and is on by default as in IntelliJ', () => {
    const setting = manifest.contributes.configuration
      .map((c) => c.properties['gittree.diff.goToNextFileAfterLastChange'])
      .find((p) => p !== undefined);
    expect(setting?.type).toBe('boolean');
    expect(setting?.default).toBe(true);
    expect(nls[(setting?.description ?? '').slice(1, -1)]).toMatch(/next file/u);
  });
});

describe('the Compare pane in the manifest', () => {
  const title = (command: string): string => {
    const entry = manifest.contributes.commands.find((c) => c.command === command);
    expect(entry, `${command} is not contributed`).toBeDefined();
    return nls[entry!.title.replace(/%/gu, '')] ?? '';
  };

  it("takes IntelliJ's words for what it does", () => {
    expect(title('gittree.compare.showFilesDiff')).toBe('Show Files Diff');
    expect(title('gittree.compare.openChanges')).toBe('Show Diff');
  });

  it('puts refresh, the multi-diff and close on its title bar', () => {
    const onTitle = (manifest.contributes.menus['view/title'] ?? []).filter((e) => e.when === 'view == gittree.compare');
    expect(onTitle.map((e) => e.command)).toEqual([
      'gittree.compare.refresh',
      'gittree.compare.openAll',
      'gittree.compare.close',
    ]);
    for (const entry of onTitle) expect(entry.group).toMatch(/^navigation@/u);
  });

  it('offers Show Diff on its rows, for several selected or a folder', () => {
    const onRow = (manifest.contributes.menus['view/item/context'] ?? []).filter((e) => e.when?.includes('gittree.compare'));
    expect(onRow.map((e) => e.command)).toEqual(['gittree.compare.openChanges']);
  });

  it('keeps what needs a row or a branch out of the palette', () => {
    const hidden = new Set(
      (manifest.contributes.menus['commandPalette'] ?? []).filter((e) => e.when === 'false').map((e) => e.command),
    );
    for (const command of [
      'gittree.branches.compareWithCurrent',
      'gittree.branches.diffWithWorkingTree',
      'gittree.branches.compareInLog',
      'gittree.compare.showFilesDiff',
      'gittree.compare.openFile',
      'gittree.compare.openChanges',
      'gittree.compare.refresh',
      'gittree.compare.openAll',
      'gittree.compare.close',
    ]) {
      expect(hidden.has(command), command).toBe(true);
    }
  });
});
