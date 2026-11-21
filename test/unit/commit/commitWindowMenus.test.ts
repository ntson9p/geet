/**
 * POST-P14bf: the Commit window's right-click menus, as package.json declares
 * them: Unversioned Files offers IntelliJ's Add to VCS and Move to Another
 * Changelist… instead of a list's actions; folder rows have a menu at all.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_MENU } from '../../../src/branches/repositoryMenu';

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, MenuEntry[]> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const IN_COMMIT = "webviewId == 'geet.commit'";

/** A section's entries, in the order VS Code draws them. The closing quote keeps `commitRepo` from `commitRepository`. */
function menu(section: string): MenuEntry[] {
  return manifest.contributes.menus['webview/context']!
    .filter((m) => m.when?.startsWith(`${IN_COMMIT} && webviewSection == '${section}'`) === true)
    .sort((a, b) => {
      const [ga, oa] = (a.group ?? '').split('@');
      const [gb, ob] = (b.group ?? '').split('@');
      return (ga ?? '').localeCompare(gb ?? '') || Number(oa) - Number(ob);
    });
}

function titleOf(command: string): string {
  const raw = manifest.contributes.commands.find((c) => c.command === command)?.title ?? '';
  const key = /^%(.+)%$/u.exec(raw)?.[1];
  return key !== undefined ? (nls[key] ?? raw) : raw;
}

/** What a row with these context keys would show, by a small `when` evaluator for `&&`, `!` and `==`. */
function shown(section: string, keys: Record<string, string | boolean>): string[] {
  const holds = (term: string): boolean => {
    const t = term.trim();
    if (t.startsWith('!')) return !holds(t.slice(1));
    const re = /^(\S+)\s*=~\s*\/(.*)\/$/u.exec(t);
    if (re) return new RegExp(re[2]!, 'u').test(String(keys[re[1]!] ?? ''));
    const eq = /^(\S+)\s*==\s*'?([^']*)'?$/u.exec(t);
    if (eq) return String(keys[eq[1]!] ?? '') === eq[2];
    return keys[t] === true;
  };
  return menu(section)
    .filter((m) => (m.when ?? '').split('&&').every(holds))
    .map((m) => titleOf(m.command));
}

const base = { webviewId: 'geet.commit', 'geet.paradigm': 'changelists' };

describe('the Commit window menus (POST-P14bf)', () => {
  it("names Move as IntelliJ does", () => {
    expect(titleOf('geet.changelist.moveTo')).toBe('Move to Another Changelist…');
    expect(titleOf('geet.addToVcs')).toBe('Add to VCS');
  });

  it('gives Unversioned Files Add to VCS and Move, and none of a changelist’s own actions', () => {
    const unversioned = { ...base, listIsUnversioned: true, listCheckable: true, listIsDefault: false };
    for (const section of ['commitGroup', 'commitRepo']) {
      expect(shown(section, { ...unversioned, webviewSection: section })).toEqual([
        'Add to VCS',
        'Move to Another Changelist…',
        'New Changelist…',
      ]);
    }
  });

  it('leaves a changelist row its own menu', () => {
    const changes = { ...base, listIsUnversioned: false, listCheckable: true, listIsDefault: true };
    expect(shown('commitRepo', { ...changes, webviewSection: 'commitRepo' })).toEqual([
      'Commit Changelist…',
      'Set as Active Changelist',
      'New Changelist…',
      'Rename Changelist…',
      'Shelve Changes…',
    ]);
  });

  it("gives a folder row the file row's actions, on its files", () => {
    const folder = { ...base, webviewSection: 'commitFolder' };
    expect(shown('commitFolder', { ...folder, folderHasUnversioned: true, fileUnversioned: true })).toEqual([
      'Add to VCS',
      'Open Changes',
      'Move to Another Changelist…',
      'Roll Back…',
      'Add to .gitignore',
    ]);
    // Tracked files: nothing to add, nothing to ignore.
    expect(shown('commitFolder', { ...folder, folderHasUnversioned: false, fileUnversioned: false })).toEqual([
      'Open Changes',
      'Move to Another Changelist…',
      'Roll Back…',
    ]);
    // Some new: Add to VCS adds those, but .gitignore wants them all new.
    expect(shown('commitFolder', { ...folder, folderHasUnversioned: true, fileUnversioned: false })).toEqual([
      'Add to VCS',
      'Open Changes',
      'Move to Another Changelist…',
      'Roll Back…',
    ]);
  });

  it('gives a repository row Add to VCS only with new files, and Move for all of its changes', () => {
    const repository = { ...base, webviewSection: 'commitRepository', repoHasTracked: true };
    expect(shown('commitRepository', { ...repository, repoHasUnversioned: true })).toEqual([
      // POST-P14cb: first, the Repositories panel's pick of it; POST-P14ce: which
      // the list follows, so it is named as that panel names it.
      'Show Only This Repository',
      'Add to VCS',
      'Move to Another Changelist…',
      'New Changelist…',
      'Shelve Changes…',
      'Rollback…',
      // POST-P14cb: then the Repositories panel's own menu for a repository.
      'Show in New Log Tab',
      'Update Repository…',
      'Update Repository Without Fetching…',
      'Push…',
      'Fetch',
      'New Branch…',
      'Checkout Tag or Revision…',
      'Stash Changes…',
      'Unstash Changes…',
      'Manage Remotes…',
    ]);
    expect(shown('commitRepository', { ...repository, repoHasUnversioned: false })).not.toContain('Add to VCS');
  });

  it("ends a repository row's menu with the Repositories panel's menu for it, in its order, without its Commit (POST-P14cb)", () => {
    const repository = { ...base, webviewSection: 'commitRepository', repoHasTracked: true, repoHasUnversioned: false };
    const panel = REPOSITORY_MENU.filter((e) => e.command !== 'geet.commit');
    const commands = menu('commitRepository')
      .filter((m) => panel.some((e) => e.command === m.command))
      .map((m) => m.command);
    expect(commands).toEqual(panel.map((e) => e.command));
    // Under the titles the panel gives them.
    const titles = shown('commitRepository', repository);
    expect(titles.slice(-panel.length)).toEqual(panel.map((e) => e.label));
    // This is the Commit window: its Commit is the window's own button.
    expect(menu('commitRepository').some((m) => m.command === 'geet.commit')).toBe(false);
  });

  it('keeps Show Only This Repository out of the Command Palette: it needs a row', () => {
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    expect(palette.find((e) => e.command === 'geet.branches.selectRepository')?.when).toBe('false');
    // POST-P14ce: once Select in Repositories Panel; the list follows the pick now.
    expect(titleOf('geet.branches.selectRepository')).toBe('Show Only This Repository');
  });

  it('offers Show All Repositories in place of Show Only This Repository on the repository shown alone (POST-P14ce)', () => {
    const repository = { ...base, webviewSection: 'commitRepository', repoHasTracked: true, repoHasUnversioned: false };
    const alone = shown('commitRepository', { ...repository, repoShownAlone: true });
    expect(alone[0]).toBe('Show All Repositories');
    expect(alone).not.toContain('Show Only This Repository');
    const among = shown('commitRepository', { ...repository, repoShownAlone: false });
    expect(among[0]).toBe('Show Only This Repository');
    expect(among).not.toContain('Show All Repositories');
    // The rest of the menu is the same either way.
    expect(alone.slice(1)).toEqual(among.slice(1));
  });

  it("offers Show All Repositories in the Command Palette while a pick narrows the list, and keeps the bar's reveal out of it (POST-P14ce)", () => {
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    expect(titleOf('geet.branches.showAllRepositories')).toBe('Show All Repositories');
    expect(palette.find((e) => e.command === 'geet.branches.showAllRepositories')?.when).toBe('geet.reposNarrowed');
    // The filter bar's names: a root in, so no palette entry.
    expect(titleOf('geet.branches.revealRepository')).toBe('Show in Repositories Panel');
    expect(palette.find((e) => e.command === 'geet.branches.revealRepository')?.when).toBe('false');
  });

  it('offers no Move in the staging paradigm, where there are no changelists', () => {
    const staging = { ...base, 'geet.paradigm': 'staging' };
    expect(shown('commitFolder', { ...staging, webviewSection: 'commitFolder', folderHasUnversioned: true })).not.toContain(
      'Move to Another Changelist…',
    );
    expect(
      shown('commitGroup', { ...staging, webviewSection: 'commitGroup', listIsUnversioned: true }),
    ).toEqual(['Add to VCS']);
  });

  it('offers Stage on what is not staged and Unstage on what is, with staging only (POST-QA F5)', () => {
    const staging = { ...base, 'geet.paradigm': 'staging' };
    for (const section of ['commitFile', 'commitFolder', 'commitGroup', 'commitRepo']) {
      const row = { ...staging, webviewSection: section };
      expect(shown(section, { ...row, stagingSide: 'unstaged' })).toContain('Stage');
      expect(shown(section, { ...row, stagingSide: 'unstaged' })).not.toContain('Unstage');
      expect(shown(section, { ...row, stagingSide: 'unversioned' })).toContain('Stage');
      expect(shown(section, { ...row, stagingSide: 'staged' })).toContain('Unstage');
      expect(shown(section, { ...row, stagingSide: 'staged' })).not.toContain('Stage');
      expect(shown(section, { ...row, stagingSide: 'conflicted' })).not.toContain('Stage');
      // With changelists, rows carry no side and there is no staging menu.
      expect(shown(section, { ...base, webviewSection: section })).not.toContain('Stage');
    }
  });

  it('gives a stash row the Stash tab toolbar’s actions, as the Shelf rows have theirs (POST-QA)', () => {
    expect(menu('stashEntry').map((m) => titleOf(m.command))).toEqual([
      'Apply Stash',
      'Pop Stash',
      'Branch from Stash…',
      'Compare All vs Working Tree',
      'Copy Stash Message',
      'Drop Stash…',
    ]);
  });

  it('gives the Merge Conflicts row Resolve Conflicts… alone, in either paradigm (POST-QA)', () => {
    for (const paradigm of ['changelists', 'staging']) {
      const row = { ...base, 'geet.paradigm': paradigm, webviewSection: 'commitConflicts' };
      expect(shown('commitConflicts', row)).toEqual(['Resolve Conflicts…']);
    }
  });

  it('offers a conflicted file no Move and no Rollback — it is in no list, and its merge is unfinished', () => {
    const file = { ...base, webviewSection: 'commitFile' };
    expect(shown('commitFile', file)).toContain('Move to Another Changelist…');
    const conflicted = shown('commitFile', { ...file, fileConflicted: true });
    expect(conflicted).not.toContain('Move to Another Changelist…');
    expect(conflicted).not.toContain('Rollback…');
    expect(conflicted).toContain('Open File');
  });
});

/**
 * POST-P14cf: the list's blank space (under the rows, the "No changes."
 * message, the filter bar) has a menu acting on the whole list, in place of
 * VS Code's Cut, Copy and Paste. Its payload is `listContext` in commitTree.ts.
 */
describe("the menu of the Commit list's blank space (POST-P14cf)", () => {
  const list = { ...base, webviewSection: 'commitList', listHasUnticked: true, listHasTicked: true, listCanFold: true };

  it('offers New Changelist… first while changelist rows are drawn, then the whole list’s actions', () => {
    expect(shown('commitList', { ...list, listShowsChangelists: true })).toEqual([
      'New Changelist…',
      'Tick All Changes',
      'Untick All Changes',
      'Expand All',
      'Collapse All',
      'Refresh',
    ]);
  });

  it('has no New Changelist… without changelist rows', () => {
    expect(shown('commitList', list)).toEqual([
      'Tick All Changes',
      'Untick All Changes',
      'Expand All',
      'Collapse All',
      'Refresh',
    ]);
  });

  it('offers Tick All only with something to tick, Untick All only with something ticked', () => {
    expect(shown('commitList', { ...list, listHasTicked: false })).not.toContain('Untick All Changes');
    expect(shown('commitList', { ...list, listHasUnticked: false })).not.toContain('Tick All Changes');
  });

  it('offers Show All Repositories while the list is narrowed, before Refresh', () => {
    const titles = shown('commitList', { ...list, listNarrowed: true });
    expect(titles.slice(-2)).toEqual(['Show All Repositories', 'Refresh']);
    expect(shown('commitList', list)).not.toContain('Show All Repositories');
  });

  it('offers Stage All and Unstage All with staging, in place of the ticks', () => {
    const staging = {
      ...base,
      'geet.paradigm': 'staging',
      webviewSection: 'commitList',
      listCanStage: true,
      listCanUnstage: true,
      listCanFold: true,
    };
    expect(shown('commitList', staging)).toEqual([
      'Stage All Changes',
      'Unstage All Changes',
      'Expand All',
      'Collapse All',
      'Refresh',
    ]);
  });

  it('has no Expand All or Collapse All when nothing folds; Refresh always', () => {
    expect(shown('commitList', { ...base, webviewSection: 'commitList' })).toEqual(['Refresh']);
  });

  it("leaves a row's own menu as it was, though VS Code merges the list's payload into a row's", () => {
    // A row inside the list carries its own section; the list's keys come with it.
    const merged = { ...list, listShowsChangelists: true, listNarrowed: true, webviewSection: 'commitFile' };
    const titles = shown('commitFile', merged);
    for (const listItem of ['New Changelist…', 'Tick All Changes', 'Untick All Changes', 'Expand All', 'Refresh']) {
      expect(titles).not.toContain(listItem);
    }
  });

  it('names its commands, and offers the ticks and stages in the Command Palette by paradigm', () => {
    expect(titleOf('geet.commit.tickAll')).toBe('Tick All Changes');
    expect(titleOf('geet.commit.untickAll')).toBe('Untick All Changes');
    expect(titleOf('geet.commit.stageAll')).toBe('Stage All Changes');
    expect(titleOf('geet.commit.unstageAll')).toBe('Unstage All Changes');
    expect(titleOf('geet.commit.expandAll')).toBe('Expand All');
    expect(titleOf('geet.commit.collapseAll')).toBe('Collapse All');
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    const whenOf = (command: string): string | undefined => palette.find((e) => e.command === command)?.when;
    expect(whenOf('geet.commit.tickAll')).toBe('geet.paradigm == changelists');
    expect(whenOf('geet.commit.untickAll')).toBe('geet.paradigm == changelists');
    expect(whenOf('geet.commit.stageAll')).toBe('geet.paradigm == staging');
    expect(whenOf('geet.commit.unstageAll')).toBe('geet.paradigm == staging');
    // They need the window's list.
    expect(whenOf('geet.commit.expandAll')).toBe('false');
    expect(whenOf('geet.commit.collapseAll')).toBe('false');
  });
});

/**
 * POST-P14bq: a row shown in the OS file manager, named as VS Code names it on
 * each system — in its Explorer, its editor tabs and its Git view alike.
 */
describe('Reveal in File Explorer / Finder / Open Containing Folder (POST-P14bq)', () => {
  const SYSTEMS = [
    { os: 'isWindows', label: 'Reveal in File Explorer', key: 'shift+alt+r', command: 'geet.revealFileInOS.windows' },
    { os: 'isMac', label: 'Reveal in Finder', key: 'alt+cmd+r', command: 'geet.revealFileInOS.mac' },
    { os: 'isLinux', label: 'Open Containing Folder', key: 'ctrl+alt+r', command: 'geet.revealFileInOS.linux' },
  ] as const;
  const LABELS: readonly string[] = SYSTEMS.map((s) => s.label);
  const reveals = (titles: string[]): string[] => titles.filter((t) => LABELS.includes(t));
  /** A window whose files are on this computer, on one system. */
  const on = (os: string): Record<string, string | boolean> => ({ ...base, [os]: true, 'geet.canRevealInOS': true });

  it('names the item as VS Code does on each system, and offers that one only', () => {
    for (const { os, label } of SYSTEMS) {
      expect(reveals(shown('commitFile', { ...on(os), webviewSection: 'commitFile' }))).toEqual([label]);
      expect(reveals(shown('commitFolder', { ...on(os), webviewSection: 'commitFolder' }))).toEqual([label]);
    }
  });

  it('comes right after Open File on a file row, and after Open Changes on a folder row', () => {
    expect(shown('commitFile', { ...on('isWindows'), webviewSection: 'commitFile' })).toEqual([
      'Open Changes',
      'Open File',
      'Reveal in File Explorer',
      'Move to Another Changelist…',
      'Roll Back…',
    ]);
    expect(shown('commitFolder', { ...on('isMac'), webviewSection: 'commitFolder' })).toEqual([
      'Open Changes',
      'Reveal in Finder',
      'Move to Another Changelist…',
      'Roll Back…',
    ]);
  });

  it('is on new, conflicted and staging-mode rows too: each is a file on disk', () => {
    for (const { os, label } of SYSTEMS) {
      const file = { ...on(os), webviewSection: 'commitFile' };
      expect(shown('commitFile', { ...file, fileUnversioned: true })).toContain(label);
      expect(shown('commitFile', { ...file, fileConflicted: true })).toContain(label);
      expect(shown('commitFile', { ...file, 'geet.paradigm': 'staging', stagingSide: 'staged' })).toContain(label);
      expect(shown('commitFolder', { ...on(os), webviewSection: 'commitFolder', fileUnversioned: true })).toContain(
        label,
      );
    }
  });

  it('is left out on a deleted file, or a folder of deleted files: there is nothing on disk to select', () => {
    for (const { os } of SYSTEMS) {
      expect(reveals(shown('commitFile', { ...on(os), webviewSection: 'commitFile', fileDeleted: true }))).toEqual([]);
      expect(
        reveals(shown('commitFolder', { ...on(os), webviewSection: 'commitFolder', folderDeleted: true })),
      ).toEqual([]);
      // The rest of a deleted row's menu stays.
      expect(shown('commitFile', { ...on(os), webviewSection: 'commitFile', fileDeleted: true })).toContain('Roll Back…');
    }
  });

  it("is left out where this window's files are not on this computer", () => {
    for (const { os } of SYSTEMS) {
      const away = { ...base, [os]: true };
      expect(reveals(shown('commitFile', { ...away, webviewSection: 'commitFile' }))).toEqual([]);
      expect(reveals(shown('commitFolder', { ...away, webviewSection: 'commitFolder' }))).toEqual([]);
    }
  });

  it('is not on a changelist or Merge Conflicts row', () => {
    for (const section of ['commitGroup', 'commitRepo', 'commitConflicts']) {
      const row = { ...on('isWindows'), webviewSection: section, listCheckable: true, repoHasTracked: true };
      expect(reveals(shown(section, row))).toEqual([]);
    }
  });

  it("is on a repository row, for the repository's own folder, after its changes (POST-P14cb)", () => {
    for (const { os, label } of SYSTEMS) {
      const row = { ...on(os), webviewSection: 'commitRepository', repoHasTracked: true };
      expect(reveals(shown('commitRepository', row))).toEqual([label]);
      const titles = shown('commitRepository', row);
      expect(titles.indexOf(label)).toBe(titles.indexOf('Rollback…') + 1);
    }
  });

  it('keeps its commands out of the Command Palette: they need a row', () => {
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    for (const { command } of SYSTEMS) {
      expect(palette.find((e) => e.command === command)?.when).toBe('false');
    }
  });

  it("binds VS Code's own reveal key on each system, while the Commit window's tree has the keyboard", () => {
    const keys = (manifest.contributes as unknown as { keybindings: Array<{ command: string; key: string; when?: string }> })
      .keybindings;
    for (const { os, key, command } of SYSTEMS) {
      const binding = keys.filter((k) => k.command === command);
      expect(binding).toHaveLength(1);
      expect(binding[0]!.key).toBe(key);
      const terms = (binding[0]!.when ?? '').split('&&').map((t) => t.trim());
      expect(terms).toEqual(expect.arrayContaining([os, 'geet.canRevealInOS', 'geet.commitTreeFocus']));
      // Not `focusedView`: VS Code clears it once focus is inside a webview, so
      // VS Code's own reveal took the key in the real window (POST-P14bq).
      expect(binding[0]!.when).not.toContain('focusedView');
    }
  });
});

/**
 * POST-P14bs: Ctrl+Enter (⌘Enter) in the Commit window's message box commits.
 * Bound to `focusedView == 'geet.commit'`, it never did in the real window.
 */
describe('Ctrl+Enter in the message box (POST-P14bs)', () => {
  const contributes = manifest.contributes as unknown as {
    keybindings: Array<{ command: string; key: string; mac?: string; when?: string }>;
    views: Record<string, Array<{ id: string; type?: string }>>;
  };
  const keys = contributes.keybindings;

  it('binds Ctrl+Enter, ⌘Enter on macOS, while the message box has the keyboard', () => {
    expect(keys.filter((k) => k.command === 'geet.commit.fromMessageBox')).toEqual([
      { command: 'geet.commit.fromMessageBox', key: 'ctrl+enter', mac: 'cmd+enter', when: 'geet.commitMessageFocus' },
    ]);
  });

  it('binds nothing to the bare Commit: that reads a message the box may not have sent yet', () => {
    expect(keys.filter((k) => k.command === 'geet.commit' && (k.key === 'ctrl+enter' || k.mac === 'cmd+enter'))).toEqual(
      [],
    );
  });

  it('names its command for Keyboard Shortcuts, and keeps it out of the Command Palette: it needs the box', () => {
    expect(titleOf('geet.commit.fromMessageBox')).toBe('Commit from the Message Box');
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    expect(palette.find((e) => e.command === 'geet.commit.fromMessageBox')?.when).toBe('false');
  });

  it('binds no key to one of our webviews by focusedView, which VS Code clears once focus is inside one', () => {
    const webviews = Object.values(contributes.views)
      .flat()
      .filter((v) => v.type === 'webview')
      .map((v) => v.id);
    expect(webviews).toEqual(
      expect.arrayContaining(['geet.commit', 'geet.log', 'geet.repositoryList', 'geet.branches']),
    );
    const viewsNamed = (when: string): string[] =>
      [...when.matchAll(/focusedView\s*==\s*'?([\w.-]+)'?/gu)].map((m) => m[1]!);
    expect(keys.filter((k) => viewsNamed(k.when ?? '').some((id) => webviews.includes(id)))).toEqual([]);
  });
});
