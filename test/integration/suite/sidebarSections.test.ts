import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

/**
 * The two sidebar sections POST-P14u added: Repositories, and the Branches
 * view that follows it.
 *
 * What is worth testing here, rather than in the unit suites that already
 * cover the ordering and the folder nesting, is the wiring between them —
 * that focusing a row actually re-scopes the Branches view, that the Branches
 * view shows the *focused* repository and not whichever one the active editor
 * is in, and that its rows still carry the `contextValue`s the 21 shared menu
 * clauses match. A tree whose rows silently stopped matching its own menus is
 * POST-P14d, and it fails nothing.
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
  interface HubNodeShape {
    kind: string;
    id?: string;
    name?: string;
    repo?: RepoHandle;
    ref?: { name: string; type: string; isHead: boolean };
    label?: string;
    verb?: { command: string };
  }
  interface HubShape {
    repo(): RepoHandle | undefined;
    getChildren(node?: HubNodeShape): Promise<HubNodeShape[]>;
    getTreeItem(node: HubNodeShape): vscode.TreeItem;
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

  const sectionIds = async (): Promise<string[]> =>
    (await reg.hub.getChildren()).map((n) => n.id ?? n.kind);

  /** Every branch row the hub draws, whatever section or folder it sits in. */
  async function allBranchNodes(): Promise<HubNodeShape[]> {
    const out: HubNodeShape[] = [];
    const walk = async (node?: HubNodeShape): Promise<void> => {
      for (const child of await reg.hub.getChildren(node)) {
        if (child.kind === 'branch') out.push(child);
        else if (child.kind === 'section' || child.kind === 'folder') await walk(child);
      }
    };
    await walk(undefined);
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

  test('T5 the Branches view shows only the focused repository’s refs', async () => {
    const target = core.getRepo(workspaceRepoB())!;
    await vscode.commands.executeCommand('gittree.repositories.select', target.root);
    await waitFor(() => reg.scope.isFocused(target.root));
    reg.hub.refresh();

    const nodes = await allBranchNodes();
    assert.ok(nodes.length > 0, 'the focused repository has branches');
    const mine = new Set(target.model.snapshot.refs.map((r) => r.name));
    for (const node of nodes) {
      assert.ok(mine.has(node.ref!.name), `${node.ref!.name} belongs to the focused repository`);
      assert.strictEqual(
        canonicalKey(node.repo!.root),
        canonicalKey(target.root),
        'every row carries the repository its menu will act on',
      );
    }
  });

  test('T6 the first section is Actions, and each verb carries the focused root', async () => {
    const ids = await sectionIds();
    assert.strictEqual(ids[0], 'actions', `first section was ${String(ids[0])}`);
    const verbs = await reg.hub.getChildren({ kind: 'actions' });
    assert.ok(verbs.length >= 5, `the popup's verbs are all here (${verbs.length})`);
    const root = reg.scope.current;
    for (const verb of verbs) {
      const item = reg.hub.getTreeItem(verb);
      assert.strictEqual(item.command?.command, verb.verb!.command);
      assert.deepStrictEqual(
        item.command?.arguments,
        [root],
        'a verb in a view that names a repository must act on that repository',
      );
    }
  });

  test('T7 branch rows carry the contextValues the shared menus match', async () => {
    const nodes = await allBranchNodes();
    const values = new Set(nodes.map((n) => String(reg.hub.getTreeItem(n).contextValue)));
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
      const current = nodes.find((n) => n.ref!.isHead);
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
     */
    await vscode.commands.executeCommand('gittree.repositories.focus');
    await waitFor(() => reg.reposView.visible, 20_000);

    const root = reg.scope.current!;
    await reg.reposView.reveal(root, { select: true, focus: false });
    assert.deepStrictEqual(
      reg.reposView.selection,
      [root],
      'VS Code resolved the string element back to the row it stands for',
    );
  });

  test('T9 a nested branch name is a real folder, which the popup cannot do (D5)', async () => {
    const repo = reg.hub.repo()!;
    const leaf = `p14u-${Date.now().toString(36)}`;
    const name = `p14u/nested/${leaf}`;
    gitWithRetry(repo.root, ['branch', name]);
    try {
      await waitFor(() => repo.model.snapshot.refs.some((r) => r.name === name), 10_000);
      reg.hub.refresh();

      const local = (await reg.hub.getChildren()).find((s) => s.id === '@local')!;
      const top = await reg.hub.getChildren(local);
      const p14u = top.find((n) => n.kind === 'folder' && n.name === 'p14u');
      assert.ok(p14u, `a 'p14u' folder row, not a row called '${name}'`);

      const nested = (await reg.hub.getChildren(p14u)).find(
        (n) => n.kind === 'folder' && n.name === 'nested',
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
