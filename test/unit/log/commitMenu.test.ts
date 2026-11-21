import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface MenuEntry {
  command: string;
  when?: string;
  group?: string;
}
interface Command {
  command: string;
  title: string;
  enablement?: string;
}

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: Command[]; menus: Record<string, MenuEntry[]> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const ON_COMMIT = "webviewId == 'geet.log' && webviewSection == 'commit'";

/** The commit row's menu, in the order VS Code draws it. */
const menu = manifest.contributes.menus['webview/context']!
  .filter((m) => m.when?.startsWith(ON_COMMIT) === true)
  .sort((a, b) => {
    const [ga, oa] = (a.group ?? '').split('@');
    const [gb, ob] = (b.group ?? '').split('@');
    return (ga ?? '').localeCompare(gb ?? '') || Number(oa) - Number(ob);
  });

function titleOf(command: string): string {
  const raw = manifest.contributes.commands.find((c) => c.command === command)?.title ?? '';
  const key = /^%(.+)%$/u.exec(raw)?.[1];
  return key !== undefined ? (nls[key] ?? raw) : raw;
}
const enablementOf = (command: string): string | undefined =>
  manifest.contributes.commands.find((c) => c.command === command)?.enablement;

/**
 * Evaluates the few `when`/`enablement` forms this menu uses against a
 * selection's context keys — enough to read the menu as a user sees it.
 */
function holds(expr: string | undefined, keys: Record<string, unknown>): boolean {
  if (expr === undefined) return true;
  return expr.split('&&').every((part) => {
    const term = part.trim();
    if (term.startsWith("webviewId") || term.startsWith('webviewSection')) return true;
    const eq = /^([\w.]+) == (\d+)$/u.exec(term);
    if (eq) return keys[eq[1]!] === Number(eq[2]);
    if (term.startsWith('!')) return keys[term.slice(1)] !== true;
    return keys[term] === true;
  });
}

/** The menu for a selection: each visible row's title, `(off)` when greyed. */
function menuFor(keys: Record<string, unknown>): string[] {
  const rows: string[] = [];
  let lastGroup: string | undefined;
  for (const entry of menu) {
    if (!holds(entry.when, keys)) continue;
    const group = (entry.group ?? '').split('@')[0];
    if (lastGroup !== undefined && group !== lastGroup) rows.push('—');
    lastGroup = group;
    rows.push(`${titleOf(entry.command)}${holds(enablementOf(entry.command), keys) ? '' : ' (off)'}`);
  }
  return rows;
}

describe('the log commit menu (IntelliJ’s Vcs.Log.ContextMenu)', () => {
  it('for several commits reads as IntelliJ’s does: the actions that apply, the rest greyed', () => {
    expect(menuFor({ 'geet.commitCount': 4, 'geet.multiCommit': true })).toEqual([
      'Copy Revision Number',
      'Create Patch…',
      'Cherry-Pick',
      '—',
      'Show Repository at Revision (off)',
      '—',
      'Reset Current Branch to Here… (off)',
      'Revert Commits',
      '—',
      'Drop Commits',
      'Squash Commits…',
      'Push All up to Here… (off)',
      '—',
      'New Branch… (off)',
      'New Tag… (off)',
      '—',
      'Go to Child Commit (off)',
      'Go to Parent Commit (off)',
    ]);
  });

  it('offers Compare Versions for exactly two commits', () => {
    const two = menuFor({ 'geet.commitCount': 2, 'geet.multiCommit': true });
    expect(two).toContain('Compare Versions');
    expect(menuFor({ 'geet.commitCount': 3, 'geet.multiCommit': true })).not.toContain('Compare Versions');
    expect(menuFor({ 'geet.commitCount': 1 })).not.toContain('Compare Versions');
  });

  it('greys Undo Commit on a commit that is not HEAD, as IntelliJ does (POST-QA)', () => {
    expect(menuFor({ 'geet.commitCount': 1, 'geet.notHead': true })).toContain('Undo Commit (off)');
    expect(menuFor({ 'geet.commitCount': 1 })).toContain('Undo Commit');
    // The palette, where no row says anything, keeps it.
    expect(holds(enablementOf('geet.commit.undo'), {})).toBe(true);
  });

  it('greys Revert, Drop and Squash Commits when a merge is selected, as IntelliJ does', () => {
    const rows = menuFor({ 'geet.commitCount': 2, 'geet.multiCommit': true, 'geet.mergeSelected': true });
    expect(rows).toContain('Revert Commits (off)');
    expect(rows).toContain('Drop Commits (off)');
    expect(rows).toContain('Squash Commits… (off)');
  });

  it('for one commit keeps every action, in IntelliJ’s order, with the singular names', () => {
    expect(menuFor({ 'geet.commitCount': 1 })).toEqual([
      'Copy Revision Number',
      'Create Patch…',
      'Cherry-Pick',
      '—',
      'Checkout Revision (Detached)…',
      'Show Repository at Revision',
      '—',
      'Compare with Local',
      '—',
      'Reset Current Branch to Here…',
      'Revert Commit',
      'Undo Commit',
      '—',
      'Edit Commit Message…',
      'Fixup…',
      'Squash Into…',
      'Drop Commit',
      'Interactively Rebase from Here…',
      'Push All up to Here…',
      '—',
      'Branches…',
      'New Branch…',
      'New Tag…',
      '—',
      'Go to Child Commit',
      'Go to Parent Commit',
      '—',
      'Open on Remote',
    ]);
  });

  it('greys nothing for one commit: no command is disabled without a selection', () => {
    expect(menuFor({}).some((r) => r.endsWith('(off)'))).toBe(false);
  });

  it('keeps the selection-only commands out of the Command Palette', () => {
    const palette = manifest.contributes.menus.commandPalette ?? [];
    for (const command of [
      'geet.commit.revertCommits',
      'geet.commit.dropCommits',
      'geet.log.squashCommits',
      'geet.log.compareVersions',
    ]) {
      expect(palette.find((m) => m.command === command)?.when).toBe('false');
    }
  });
});
