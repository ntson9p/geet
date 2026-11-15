import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

/**
 * The two sidebar sections POST-P14u added: Repositories, and the Branches
 * tree that follows it.
 *
 * What is worth testing here, rather than in the unit suites that already
 * cover the ordering and the folder nesting, is the wiring between them, and
 * that the tree's rows still carry the `contextValue`s the 21 shared menu
 * clauses match. A tree whose rows silently stopped matching its own menus is
 * POST-P14d, and it fails nothing.
 *
 * Since new-way-2 the tree is the branches popup standing open
 * (`branchHubView`): project-level — the project's verbs, every repository,
 * then the refs they share — and the Repositories pick no longer filters it;
 * it decides which repository opens first. Since 87798ad both trees sit behind
 * `gittree.sidebar.extraViews` (the Branches section itself is a webview), so
 * a test of the view, rather than of its provider, turns that on. Rewritten to
 * that design at the integration suite's first run in a long while (POST-P14cm).
 */
suite('POST-P14u sidebar sections', () => {
  /** The `phase02` registry, structurally — never `instanceof` across the bundle. */
  interface ScopeShape {
    readonly all: readonly string[];
    current: string | undefined;
    label(root: string): string;
    isFocused(root: string): boolean;
    focus(root: string): void;
  }
  interface RepositoriesShape {
    getChildren(element?: string): string[];
    getTreeItem(root: string): vscode.TreeItem;
  }
  /** `popupTree.TreeRow`, structurally. */
  interface HubRowShape {
    readonly id: string;
    /** 'verb' | 'group' | 'repo' | 'ref' | 'common' | 'info' */
    readonly kind: string;
    readonly label: string;
    readonly repoRoot?: string;
    readonly ref?: { name: string; type: string; isHead: boolean };
    readonly verb?: { command: string };
    /** Set on a group row: 'local' | 'remote' | 'tag'. */
    readonly section?: string;
    /** Set on a folder row: the branch-name prefix it gathers. */
    readonly prefix?: string;
  }
  interface HubShape {
    /** The repository that opens first — the Repositories section's pick. */
    repo(): RepoHandle | undefined;
    getChildren(row?: HubRowShape): Promise<HubRowShape[]>;
    getTreeItem(row: HubRowShape): vscode.TreeItem;
    refresh(): void;
  }
  interface Phase02Shape {
    scope: ScopeShape;
    repositories: RepositoriesShape;
    reposView: vscode.TreeView<string>;
    hub: HubShape;
  }

  let core: Core;
  let reg: Phase02Shape;
  let restore: string | undefined;

  suiteSetup(async () => {
    core = await activateGitTree();
    reg = core.debugRegistry.get('phase02') as Phase02Shape;
    assert.ok(reg?.scope, 'phase02 registry exposes the sidebar scope');
    restore = reg.scope.current;
  });

  suiteTeardown(() => {
    // Every later suite resolves its repository the way it always did, but the
    // sidebar's own choice is sticky and shared — put it back.
    if (restore !== undefined) reg.scope.focus(restore);
  });

  /** A repository's own row at the top level (the workspace has several). */
  async function repoRow(root: string): Promise<HubRowShape> {
    const row = (await reg.hub.getChildren()).find(
      (r) => r.kind === 'repo' && r.repoRoot !== undefined && canonicalKey(r.repoRoot) === canonicalKey(root),
    );
    assert.ok(row, `the tree has a row for ${root}`);
    return row;
  }

  /** Every branch and tag row under a repository's row, whatever group or folder it sits in. */
  async function refRowsOf(root: string): Promise<HubRowShape[]> {
    const out: HubRowShape[] = [];
    const walk = async (row: HubRowShape): Promise<void> => {
      for (const child of await reg.hub.getChildren(row)) {
        if (child.kind === 'ref') out.push(child);
        else if (child.kind === 'group') await walk(child);
      }
    };
    await walk(await repoRow(root));
    return out;
  }

  test('T1 every repository gets a row, named and ordered the way the user reads it', () => {
    const rows = reg.repositories.getChildren();
    assert.strictEqual(
      rows.length,
      core.repos.length,
      `one row per repository (${rows.length} vs ${core.repos.length})`,
    );
    const labels = rows.map((r) => reg.scope.label(r));
    assert.deepStrictEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)), 'sorted by name');
    // Rows never expand: the commit list belongs to the Commit view, and
    // VS Code's own Repositories view does not expand either.
    for (const row of rows) {
      assert.strictEqual(reg.repositories.getChildren(row).length, 0);
      const item = reg.repositories.getTreeItem(row);
      assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
      assert.strictEqual(item.contextValue, 'repository', 'the menu clauses match on this');
    }
  });

  test('T2 a row names its branch, and its command carries its own root', () => {
    const row = reg.repositories.getChildren()[0]!;
    const repo = core.getRepo(row)!;
    const item = reg.repositories.getTreeItem(row);
    const head = repo.model.snapshot.headRef;
    if (head !== undefined) {
      assert.ok(
        String(item.description ?? '').includes(head),
        `row description "${String(item.description)}" names the branch`,
      );
    }
    assert.strictEqual(item.command?.command, 'gittree.repositories.select');
    assert.deepStrictEqual(item.command?.arguments, [row], 'the row acts on itself, not on a guess');
  });

  test('T3 exactly one repository is focused, and it cannot be none', () => {
    const rows = reg.repositories.getChildren();
    const focused = rows.filter((r) => reg.scope.isFocused(r));
    assert.strictEqual(focused.length, 1, 'exactly one');
    assert.ok(reg.scope.current !== undefined);
  });

  test('T4 focusing a row moves the Branches view to that repository', async () => {
    const rows = reg.repositories.getChildren();
    assert.ok(rows.length > 1, 'this workspace has several repositories');
    const other = rows.find((r) => !reg.scope.isFocused(r))!;

    await vscode.commands.executeCommand('gittree.repositories.select', other);
    await waitFor(() => reg.scope.isFocused(other));

    assert.strictEqual(canonicalKey(reg.hub.repo()!.root), canonicalKey(other));
    // And the row that was focused before is not any more — focus is single.
    assert.strictEqual(reg.repositories.getChildren().filter((r) => reg.scope.isFocused(r)).length, 1);
  });

  test('T5 the Branches tree lists every repository, and opens the one focused first', async () => {
    const target = core.getRepo(workspaceRepoB())!;
    await vscode.commands.executeCommand('gittree.repositories.select', target.root);
    await waitFor(() => reg.scope.isFocused(target.root));
    reg.hub.refresh();

    // Project-level, as the popup is: a row for every repository.
    const repoRows = (await reg.hub.getChildren()).filter((r) => r.kind === 'repo');
    assert.strictEqual(repoRows.length, core.repos.length, 'one row per repository, every one');
    // The pick decides which one opens, and only that one.
    for (const row of repoRows) {
      const open = reg.hub.getTreeItem(row).collapsibleState === vscode.TreeItemCollapsibleState.Expanded;
      assert.strictEqual(
        open,
        canonicalKey(row.repoRoot!) === canonicalKey(target.root),
        `${row.label} opens only when it is the repository picked`,
      );
    }

    // Under its row, the repository's own refs, each carrying the repository
    // its menu will act on.
    const rows = await refRowsOf(target.root);
    assert.ok(rows.length > 0, 'the focused repository has branches');
    const mine = new Set(target.model.snapshot.refs.map((r) => r.name));
    for (const row of rows) {
      assert.ok(mine.has(row.ref!.name), `${row.ref!.name} belongs to the focused repository`);
      assert.strictEqual(
        canonicalKey(row.repoRoot!),
        canonicalKey(target.root),
        'every row carries the repository its menu will act on',
      );
    }
  });

  test('T6 the tree starts with the popup’s verbs, which act on the project; a repository’s own act on it', async () => {
    const top = await reg.hub.getChildren();
    assert.strictEqual(top[0]?.kind, 'verb', `the first row was ${String(top[0]?.id)}`);
    const verbs = top.filter((r) => r.kind === 'verb');
    assert.ok(verbs.length >= 3, `the popup's verbs are all here (${verbs.length})`);
    for (const verb of verbs) {
      const item = reg.hub.getTreeItem(verb);
      assert.strictEqual(item.command?.command, verb.verb!.command);
      assert.strictEqual(
        item.command?.arguments,
        undefined,
        'a project verb takes no argument, as the popup runs it: it spans every repository',
      );
    }
    // A repository's own copy of a verb (New Branch… under its row) runs there.
    const root = reg.scope.current!;
    const scoped = (await reg.hub.getChildren(await repoRow(root))).filter((r) => r.kind === 'verb');
    assert.ok(scoped.length > 0, 'a repository has its own copies of the branch verbs');
    for (const verb of scoped) {
      const item = reg.hub.getTreeItem(verb);
      assert.strictEqual(item.command?.command, verb.verb!.command);
      assert.deepStrictEqual(
        item.command?.arguments,
        [verb.repoRoot],
        'a verb under a repository must act on that repository',
      );
      assert.strictEqual(canonicalKey(verb.repoRoot!), canonicalKey(root));
    }
  });

  test('T7 branch rows carry the contextValues the shared menus match', async () => {
    const rows = await refRowsOf(reg.scope.current!);
    const values = new Set(rows.map((r) => String(reg.hub.getTreeItem(r).contextValue)));
    assert.ok(values.size > 0);
    for (const value of values) {
      assert.match(
        value,
        /^branch:(current|local|remote|tag)(:tracked)?$/u,
        'every row is one of the four kinds the 21 when-clauses know',
      );
    }
    // The checked-out branch is `branch:current`, which is the exact
    // distinction POST-P14d found nine clauses silently excluding.
    const head = reg.hub.repo()!.model.snapshot.headRef;
    if (head !== undefined) {
      const current = rows.find((r) => r.ref!.isHead);
      assert.ok(current, `the checked-out branch ${head} has a row`);
      assert.match(String(reg.hub.getTreeItem(current).contextValue), /^branch:current(:|$)/u);
    }
  });

  test('T8 VS Code itself can drive the view, whose element is a bare string', async function () {
    this.timeout(30_000);
    /**
     * The other tests call the provider directly, which proves the shaping and
     * nothing about the plumbing. This view's element is the repository root
     * *string* rather than a wrapper object — deliberately, so VS Code hands
     * every `gittree.*` command in the row's context menu exactly the argument
     * it already takes. `reveal` is what proves that choice works: it round
     * trips the element through VS Code's own element↔handle map, which is the
     * part a provider-level test cannot reach.
     *
     * Since 87798ad the tree is shown only with gittree.sidebar.extraViews (and
     * several repositories): turned on here, and back as it was after.
     */
    const sidebar = vscode.workspace.getConfiguration('gittree.sidebar');
    const saved = sidebar.inspect('extraViews');
    await sidebar.update('extraViews', true, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('gittree.repositories.focus');
      await waitFor(() => reg.reposView.visible, 20_000);

      const root = reg.scope.current!;
      await reg.reposView.reveal(root, { select: true, focus: false });
      assert.deepStrictEqual(
        reg.reposView.selection,
        [root],
        'VS Code resolved the string element back to the row it stands for',
      );
    } finally {
      await sidebar.update('extraViews', saved?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });

  test('T9 a nested branch name is a real folder, which the popup cannot do (D5)', async () => {
    const repo = reg.hub.repo()!;
    const leaf = `p14u-${Date.now().toString(36)}`;
    const name = `p14u/nested/${leaf}`;
    gitWithRetry(repo.root, ['branch', name]);
    try {
      await waitFor(() => repo.model.snapshot.refs.some((r) => r.name === name), 10_000);
      reg.hub.refresh();

      // The repository's row, then its Local group, then folders: a folder row
      // is a group with the prefix it gathers.
      const local = (await reg.hub.getChildren(await repoRow(repo.root))).find(
        (r) => r.kind === 'group' && r.section === 'local' && (r.prefix ?? '') === '',
      );
      assert.ok(local, 'the repository has a Local group');
      const top = await reg.hub.getChildren(local);
      const p14u = top.find((r) => r.kind === 'group' && r.label === 'p14u');
      assert.ok(p14u, `a 'p14u' folder row, not a row called '${name}'`);

      const nested = (await reg.hub.getChildren(p14u)).find(
        (r) => r.kind === 'group' && r.label === 'nested',
      );
      assert.ok(nested, "'p14u' contains a 'nested' folder — the tree keeps nesting");

      const rows = await reg.hub.getChildren(nested);
      assert.deepStrictEqual(
        rows.map((n) => n.label),
        [leaf],
        'the leaf shows its own segment, not the whole path it is already under',
      );
      assert.strictEqual(rows[0]!.ref!.name, name, 'while acting on the full ref name');
    } finally {
      gitWithRetry(repo.root, ['branch', '-D', name]);
    }
  });
});
