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
});
