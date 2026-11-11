/**
 * POST-P14bf: the Commit window's right-click menus, as package.json declares
 * them: Unversioned Files offers IntelliJ's Add to VCS and Move to Another
 * Changelist… instead of a list's actions; folder rows have a menu at all.
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
  contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, MenuEntry[]> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const IN_COMMIT = "webviewId == 'gittree.commit'";

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

const base = { webviewId: 'gittree.commit', 'gittree.paradigm': 'changelists' };

describe('the Commit window menus (POST-P14bf)', () => {
  it("names Move as IntelliJ does", () => {
    expect(titleOf('gittree.changelist.moveTo')).toBe('Move to Another Changelist…');
    expect(titleOf('gittree.addToVcs')).toBe('Add to VCS');
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
      'Add to VCS',
      'Move to Another Changelist…',
      'New Changelist…',
      'Shelve Changes…',
      'Rollback…',
    ]);
    expect(shown('commitRepository', { ...repository, repoHasUnversioned: false })).not.toContain('Add to VCS');
  });

  it('offers no Move in the staging paradigm, where there are no changelists', () => {
    const staging = { ...base, 'gittree.paradigm': 'staging' };
    expect(shown('commitFolder', { ...staging, webviewSection: 'commitFolder', folderHasUnversioned: true })).not.toContain(
      'Move to Another Changelist…',
    );
    expect(
      shown('commitGroup', { ...staging, webviewSection: 'commitGroup', listIsUnversioned: true }),
    ).toEqual(['Add to VCS']);
  });

  it('offers Stage on what is not staged and Unstage on what is, with staging only (POST-QA F5)', () => {
    const staging = { ...base, 'gittree.paradigm': 'staging' };
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
      const row = { ...base, 'gittree.paradigm': paradigm, webviewSection: 'commitConflicts' };
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
 * POST-P14bq: a row shown in the OS file manager, named as VS Code names it on
 * each system — in its Explorer, its editor tabs and its Git view alike.
 */
describe('Reveal in File Explorer / Finder / Open Containing Folder (POST-P14bq)', () => {
  const SYSTEMS = [
    { os: 'isWindows', label: 'Reveal in File Explorer', key: 'shift+alt+r', command: 'gittree.revealFileInOS.windows' },
    { os: 'isMac', label: 'Reveal in Finder', key: 'alt+cmd+r', command: 'gittree.revealFileInOS.mac' },
    { os: 'isLinux', label: 'Open Containing Folder', key: 'ctrl+alt+r', command: 'gittree.revealFileInOS.linux' },
  ] as const;
  const LABELS: readonly string[] = SYSTEMS.map((s) => s.label);
  const reveals = (titles: string[]): string[] => titles.filter((t) => LABELS.includes(t));
  /** A window whose files are on this computer, on one system. */
  const on = (os: string): Record<string, string | boolean> => ({ ...base, [os]: true, 'gittree.canRevealInOS': true });

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
      expect(shown('commitFile', { ...file, 'gittree.paradigm': 'staging', stagingSide: 'staged' })).toContain(label);
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

  it('is not on a changelist, repository or Merge Conflicts row', () => {
    for (const section of ['commitGroup', 'commitRepo', 'commitRepository', 'commitConflicts']) {
      const row = { ...on('isWindows'), webviewSection: section, listCheckable: true, repoHasTracked: true };
      expect(reveals(shown(section, row))).toEqual([]);
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
      expect(terms).toEqual(expect.arrayContaining([os, 'gittree.canRevealInOS', 'gittree.commitTreeFocus']));
      // Not `focusedView`: VS Code clears it once focus is inside a webview, so
      // VS Code's own reveal took the key in the real window (POST-P14bq).
      expect(binding[0]!.when).not.toContain('focusedView');
    }
  });
});
