/**
 * The Branches tree's context menu, evaluated the way VS Code evaluates it.
 *
 * This exists because the menu silently lost rows for years: the tree emits
 * four `contextValue`s (`branch:local`, `branch:current`, `branch:remote`,
 * `branch:tag`, now each optionally `:tracked`) while nine `when` clauses were
 * written as `/^branch:(local|remote)$/` — an anchored two-value regex that
 * quietly excludes the checked-out branch. Nothing failed; the rows just were
 * not there, which is invisible to every other kind of test.
 *
 * So the clauses are matched here against every contextValue the provider can
 * produce, and the resulting menus are asserted whole. A row that disappears
 * because a regex was tightened, or appears because one was loosened, changes
 * a list below.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string }[];
    submenus?: { id: string; label: string }[];
    menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
  };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<
  string,
  string
>;

const resolve = (s: string): string => s.replace(/^%(.*)%$/u, (_, k: string) => nls[k] ?? k);
const titles = new Map(pkg.contributes.commands.map((c) => [c.command, resolve(c.title)]));
const submenuLabels = new Map(
  (pkg.contributes.submenus ?? []).map((s) => [s.id, `${resolve(s.label)} ▸`]),
);

const entries = pkg.contributes.menus['view/item/context']!.filter((m) =>
  String(m.when ?? '').includes('view == gittree.branches'),
);

/** The `viewItem <op> <value>` half of a when clause, as VS Code reads it. */
function matches(when: string, viewItem: string): boolean {
  const m = /viewItem\s*(==|=~)\s*(\S+)$/u.exec(when.trim());
  if (!m) throw new Error(`unparsed when clause: ${when}`);
  const [, op, value] = m as unknown as [string, string, string];
  if (op === '==') return viewItem === value;
  const literal = /^\/(.*)\/$/u.exec(value);
  if (!literal) throw new Error(`not a regex literal: ${value}`);
  return new RegExp(literal[1] as string).test(viewItem);
}

const menuFor = (viewItem: string, inline = false): string[] =>
  entries
    .filter((e) => matches(e.when as string, viewItem))
    .filter((e) => String(e.group ?? '').startsWith('inline') === inline)
    .sort((a, b) => String(a.group).localeCompare(String(b.group)))
    .map((e) => (e.submenu ? submenuLabels.get(e.submenu)! : titles.get(e.command!)!));

describe('the Branches tree context menu', () => {
  it('gives the checked-out branch every row that applies to it', () => {
    // The bug this file exists for: this menu used to be four rows, missing
    // Show Diff with Working Tree and New Worktree because their clauses said
    // `(local|remote)`. The order is IntelliJ's own.
    expect(menuFor('branch:current:tracked')).toEqual([
      'New Branch from Selected…',
      'Show Diff with Working Tree',
      'New Worktree from Branch…',
      'Update',
      'Push',
      'Tracked Branch ▸',
      'Rename…',
      'Toggle Favorite',
    ]);
  });

  it('drops Update and the Tracked Branch submenu when nothing is tracked', () => {
    // Both are meaningless without an upstream, and IntelliJ omits rather than
    // disables them.
    const untracked = menuFor('branch:current');
    expect(untracked).not.toContain('Update');
    expect(untracked).not.toContain('Tracked Branch ▸');
    expect(untracked).toEqual([
      'New Branch from Selected…',
      'Show Diff with Working Tree',
      'New Worktree from Branch…',
      'Push',
      'Rename…',
      'Toggle Favorite',
    ]);
  });

  it('still hides from the checked-out branch what cannot apply to it', () => {
    // Checking out the branch you are on, comparing it with itself, merging it
    // into itself or deleting it are not rows IntelliJ shows either.
    const current = menuFor('branch:current:tracked');
    for (const absent of [
      'Checkout',
      'Checkout and Rebase onto Current',
      'Compare with Current',
      'Merge Branch into Current',
      'Rebase Current onto Branch',
      'Delete…',
    ]) {
      expect(current).not.toContain(absent);
    }
  });

  it('keeps the full menu on a local branch that is not checked out', () => {
    expect(menuFor('branch:local:tracked')).toEqual([
      'Checkout',
      'New Branch from Selected…',
      'Checkout and Rebase onto Current',
      'Compare with Current',
      'Show Diff with Working Tree',
      'Rebase Current onto Branch',
      'Merge Branch into Current',
      'New Worktree from Branch…',
      'Update',
      'Push',
      'Tracked Branch ▸',
      'Rename…',
      'Delete…',
      'Toggle Favorite',
    ]);
  });

  it('offers both pull strategies on a remote branch, and no local-only rows', () => {
    const remote = menuFor('branch:remote');
    expect(remote).toContain('Pull into Current Using Merge');
    expect(remote).toContain('Pull into Current Using Rebase');
    expect(remote).toContain('Delete Branch on Remote…');
    for (const absent of ['Rename…', 'Delete…', 'Push', 'Update', 'Tracked Branch ▸']) {
      expect(remote).not.toContain(absent);
    }
  });

  it('leaves a tag with only the row that means anything on a tag', () => {
    expect(menuFor('branch:tag')).toEqual(['New Branch from Selected…']);
  });

  it('survives the :tracked suffix on every clause, inline actions included', () => {
    // The regression the suffix could have caused: an anchored `$` or an `==`
    // comparison would make a tracked branch lose rows an untracked one keeps.
    // Only Update and Tracked Branch may differ between the two.
    const trackedOnly = ['Update', 'Tracked Branch ▸'];
    for (const kind of ['local', 'current'] as const) {
      const plain = menuFor(`branch:${kind}`);
      const tracked = menuFor(`branch:${kind}:tracked`).filter((l) => !trackedOnly.includes(l));
      expect(tracked).toEqual(plain);
      expect(menuFor(`branch:${kind}:tracked`, true)).toEqual(menuFor(`branch:${kind}`, true));
    }
  });

  it('resolves every title and submenu label it contributes', () => {
    for (const e of entries) {
      expect(e.when).toContain('viewItem');
      if (e.submenu) expect(submenuLabels.get(e.submenu)).toBeTypeOf('string');
      else expect(titles.get(e.command!)).toBeTypeOf('string');
    }
  });
});

describe('the Tracked Branch submenu', () => {
  const rows = pkg.contributes.menus['gittree.branches.trackedSubmenu'] ?? [];

  it('is the remote-branch action set, aimed at the upstream', () => {
    const labels = rows
      .sort((a, b) => String(a.group).localeCompare(String(b.group)))
      .map((r) => titles.get(r.command!)!);
    expect(labels).toEqual([
      'Checkout',
      'New Branch from Tracked Branch…',
      'Compare with Current',
      'Show Diff with Working Tree',
      'Pull into Current Using Merge',
      'Pull into Current Using Rebase',
      'Merge into Current',
      'Rebase Current onto Tracked Branch',
      'New Worktree from Tracked Branch…',
      'Delete on Remote…',
    ]);
  });

  it('keeps its short titles out of the command palette', () => {
    // "Checkout" and "Compare with Current" only read correctly under the
    // submenu's own heading; loose in the palette they name nothing.
    const hidden = new Set(
      (pkg.contributes.menus['commandPalette'] ?? [])
        .filter((m) => m.when === 'false')
        .map((m) => m.command),
    );
    for (const row of rows) expect(hidden.has(row.command)).toBe(true);
  });
});
