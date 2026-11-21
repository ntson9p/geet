/**
 * The Branches tree's context menu, evaluated the way VS Code evaluates it.
 *
 * This exists because the menu silently lost rows for years: the tree emits
 * four `contextValue`s (`branch:local`, `branch:current`, `branch:remote`,
 * `branch:tag`, the first two now optionally `:tracked` or `:gone`) while nine `when` clauses were
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
  String(m.when ?? '').includes('view == geet.branches'),
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
      'Push…',
      'Tracked Branch ▸',
      'Stop Tracking',
      'Rename…',
      'Toggle Favorite',
    ]);
  });

  it('drops Update, the Tracked Branch submenu and Stop Tracking when nothing is tracked', () => {
    // All meaningless without an upstream, and IntelliJ omits rather than
    // disables them.
    const untracked = menuFor('branch:current');
    expect(untracked).not.toContain('Update');
    expect(untracked).not.toContain('Tracked Branch ▸');
    expect(untracked).not.toContain('Stop Tracking');
    expect(untracked).toEqual([
      'New Branch from Selected…',
      'Show Diff with Working Tree',
      'New Worktree from Branch…',
      'Push…',
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
      'Push…',
      'Tracked Branch ▸',
      'Stop Tracking',
      'Rename…',
      'Delete…',
      'Toggle Favorite',
    ]);
  });

  it('still lets go of an upstream the remote has deleted, and offers nothing that needs it', () => {
    for (const kind of ['local', 'current'] as const) {
      const gone = menuFor(`branch:${kind}:gone`);
      expect(gone).toContain('Stop Tracking');
      expect(gone).not.toContain('Update');
      expect(gone).not.toContain('Tracked Branch ▸');
      // Apart from that one row, the same menu as a branch that tracks nothing.
      expect(gone.filter((l) => l !== 'Stop Tracking')).toEqual(menuFor(`branch:${kind}`));
    }
  });

  it('offers both pull strategies on a remote branch, and no local-only rows', () => {
    const remote = menuFor('branch:remote');
    expect(remote).toContain('Pull into Current Using Merge');
    expect(remote).toContain('Pull into Current Using Rebase');
    expect(remote).toContain('Delete Branch on Remote…');
    for (const absent of ['Rename…', 'Delete…', 'Push…', 'Update', 'Tracked Branch ▸', 'Stop Tracking']) {
      expect(remote).not.toContain(absent);
    }
  });

  it('leaves a tag with only the row that means anything on a tag', () => {
    expect(menuFor('branch:tag')).toEqual(['New Branch from Selected…']);
  });

  it('survives the :tracked suffix on every clause, inline actions included', () => {
    // The regression the suffix could have caused: an anchored `$` or an `==`
    // comparison would make a tracked branch lose rows an untracked one keeps.
    // Only Update, Tracked Branch and Stop Tracking may differ between the two.
    const trackedOnly = ['Update', 'Tracked Branch ▸', 'Stop Tracking'];
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
  const rows = pkg.contributes.menus['geet.branches.trackedSubmenu'] ?? [];

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

/**
 * POST-P14u split the one branch tree into two: `geet.branches` is the
 * repository-scoped hub the sidebar shows, `geet.branchesLegacy` the
 * all-repositories tree behind `geet.sidebar.extraViews`. Both draw branch
 * rows, both label them with `branchActions.branchContextValue`, and a clause
 * that named only one of them would hand the same ref two different menus —
 * the defect at the top of this file, one level up.
 */
describe('both branch trees', () => {
  it('share every row, so neither is missing what the other offers', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.when).toContain('view == geet.branchesTree');
      expect(e.when).toContain('view == geet.branchesLegacy');
    }
  });
});

describe("the log's Branches pane menu", () => {
  const rows = pkg.contributes.menus['webview/context'] ?? [];

  it('offers Stop Tracking only on a row that says it tracks something', () => {
    const stop = rows.find((r) => r.command === 'geet.log.branch.stopTracking');
    expect(stop?.when).toContain("webviewSection == 'logBranch'");
    // The key `BranchesPane.tsx` puts in the row's `data-vscode-context`.
    expect(stop?.when).toContain('geet.branchTracked');
  });

  it('keeps the row out of the command palette, where it would name no branch', () => {
    const hidden = (pkg.contributes.menus['commandPalette'] ?? []).filter((m) => m.when === 'false');
    for (const command of ['geet.log.branch.stopTracking', 'geet.branch.stopTracking']) {
      expect(hidden.some((m) => m.command === command)).toBe(true);
    }
  });
});

describe('the Repositories row context menu', () => {
  const repoEntries = pkg.contributes.menus['view/item/context']!.filter((m) =>
    String(m.when ?? '').includes('view == geet.repositories'),
  );

  it('covers the same ground as VS Code’s own repository ⋯ menu, in Geet’s words', () => {
    // VS Code's `scm/repository` is Pull · Push · Clone · Checkout to… · Fetch,
    // then Commit/Changes/Pull-Push/Branch/Remote/Stash/Tags submenus, then
    // Show Git Output. This is the same ground named the way the rest of
    // Geet names it: an update rather than Pull. Update Repository, not
    // Update Project (POST-P14bx): it updates this repository, and Update
    // Project is every repository everywhere else.
    expect(
      repoEntries
        .sort((a, b) => String(a.group).localeCompare(String(b.group)))
        .map((e) => titles.get(e.command!)),
    ).toEqual([
      'Show in New Log Tab',
      'Update Repository…',
      'Update Repository Without Fetching…',
      'Push…',
      'Fetch',
      'Commit',
      'Checkout Branch…',
      'New Branch…',
      'Checkout Tag or Revision…',
      'Stash Changes…',
      'Unstash Changes…',
      'Manage Remotes…',
    ]);
  });

  it('only offers commands that take the repository as their first argument', () => {
    // The tree's element *is* the root string, so VS Code hands each of these
    // the repository the row stands for. A command that ignored its first
    // argument would silently act on whichever repository the editor is in.
    const repoScoped = new Set([
      'geet.repositories.showInLog',
      'geet.update.repository',
      'geet.update.repositoryWithoutFetch',
      'geet.push.dialog',
      'geet.fetch',
      'geet.commit',
      'geet.branches.open',
      'geet.branch.new',
      'geet.branches.checkoutRevision',
      'geet.stash.dialog',
      'geet.unstash.dialog',
      'geet.remotes.manage',
    ]);
    for (const e of repoEntries) expect(repoScoped.has(e.command!)).toBe(true);
  });

  it("keeps a repository's own update out of the command palette, where Update Project is the verb (POST-P14bx)", () => {
    // Contributed for their titles on a repository's menu; from the palette they
    // would name no repository, and asking which beside Update Project… is noise.
    const hidden = new Set(
      (pkg.contributes.menus['commandPalette'] ?? []).filter((m) => m.when === 'false').map((m) => m.command),
    );
    for (const command of ['geet.update.repository', 'geet.update.repositoryWithoutFetch']) {
      expect(titles.has(command), command).toBe(true);
      expect(hidden.has(command), command).toBe(true);
    }
    expect(titles.get('geet.update.repository')).toBe('Update Repository…');
    expect(titles.get('geet.update.repositoryWithoutFetch')).toBe('Update Repository Without Fetching…');
    // The project's stay in it.
    for (const command of ['geet.update.dialog', 'geet.update.withoutFetch']) {
      expect(hidden.has(command), command).toBe(false);
    }
  });
});
