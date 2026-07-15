import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../../../src/core/core';
import type { ConflictSession } from '../../../src/merge/conflictSession';
import type { StashService } from '../../../src/stash/stashService';
import type { StashNode, StashViewProvider } from '../../../src/stash/stashView';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

interface Phase07RegistryShape {
  getStashService(repoRoot: string): StashService | undefined;
  stashViewProvider: StashViewProvider;
}
interface Phase06RegistryShape {
  getSession(repoRoot: string): ConflictSession | undefined;
}

/** P7-T1 acceptance on workspace repoB. */
suite('P7 stash & shelve — StashService', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let stash: StashService;
  let reg06: Phase06RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string | Buffer): void => fs.writeFileSync(abs(rel), content);

  let reg07: Phase07RegistryShape;

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoB())!;
    assert.ok(repo, 'repoB not discovered');
    repoRoot = repo.root;
    reg07 = core.debugRegistry.get('phase07') as Phase07RegistryShape;
    assert.ok(reg07, 'phase07 registry missing');
    stash = reg07.getStashService(repoRoot)!;
    assert.ok(stash, 'stash service missing');
    reg06 = core.debugRegistry.get('phase06') as Phase06RegistryShape;
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    try {
      git('stash', 'clear');
    } catch {
      // no stash ref yet
    }
    try {
      git('checkout', '-f', 'main');
    } catch {
      // already there
    }
    try {
      git('clean', '-fd');
    } catch {
      // nothing to clean
    }
    const branches = git('branch', '--list', 'p7/*', '--format=%(refname:short)')
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    for (const b of branches) {
      try {
        git('branch', '-D', b);
      } catch {
        // best effort
      }
    }
    await repo.refresher.refreshNow();
    await new Promise((r) => setTimeout(r, 300));
  });

  const commitAll = (subject: string): void => {
    git('add', '-A');
    git('commit', '-m', subject);
  };

  test('T1: push/pop with untracked + index round-trips the worktree byte-identical', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/roundtrip');
    write('p7a.txt', 'base\n');
    write('p7b.bin', Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0d, 0x0a]));
    commitAll('p7 base');

    // Dirty state: staged tracked edit, unstaged binary edit, untracked CRLF file.
    write('p7a.txt', 'staged change\n');
    git('add', '--', 'p7a.txt');
    const binBytes = Buffer.from([0xff, 0x00, 0x42, 0x0d, 0x0a, 0x00]);
    write('p7b.bin', binBytes);
    write('p7u.txt', 'untracked\r\nline two\r\n');

    await stash.push({ message: 'p7 roundtrip' });
    await waitFor(() => stash.list().length === 1, 10_000);
    assert.match(stash.list()[0]!.message, /p7 roundtrip/);
    assert.strictEqual(git('status', '--porcelain').trim(), '', 'worktree clean after push');
    assert.ok(!fs.existsSync(abs('p7u.txt')), 'untracked file stashed away');

    const outcome = await stash.pop(0, { restoreIndex: true });
    assert.strictEqual(outcome.status, 'clean');
    await waitFor(() => stash.list().length === 0, 10_000);
    assert.strictEqual(fs.readFileSync(abs('p7a.txt'), 'utf8'), 'staged change\n');
    assert.deepStrictEqual([...fs.readFileSync(abs('p7b.bin'))], [...binBytes], 'binary byte-identical');
    assert.strictEqual(fs.readFileSync(abs('p7u.txt'), 'utf8'), 'untracked\r\nline two\r\n');
    // --index restored the staged state of p7a.txt.
    const staged = git('diff', '--cached', '--name-only').trim().split('\n');
    assert.ok(staged.includes('p7a.txt'), `staged state restored: ${staged.join(',')}`);
    git('checkout', '-f', 'main');
  });

  test('T1: --staged flag stashes only the index (or guards on old git)', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/staged');
    write('p7s.txt', 'base\n');
    write('p7w.txt', 'base\n');
    commitAll('p7 staged base');
    write('p7s.txt', 'staged\n');
    git('add', '--', 'p7s.txt');
    write('p7w.txt', 'worktree only\n');

    try {
      await stash.push({ message: 'p7 staged only', staged: true });
    } catch (err) {
      // Old git: the capability guard must fire BEFORE any stash is created.
      assert.match(String(err), /2\.35/);
      assert.strictEqual(stash.list().length, 0, 'no stash entry on guard failure');
      return;
    }
    await waitFor(() => stash.list().length === 1, 10_000);
    assert.strictEqual(fs.readFileSync(abs('p7s.txt'), 'utf8'), 'base\n', 'staged edit stashed');
    assert.strictEqual(
      fs.readFileSync(abs('p7w.txt'), 'utf8'),
      'worktree only\n',
      'unstaged edit untouched by --staged',
    );
    const outcome = await stash.pop(0);
    assert.strictEqual(outcome.status, 'clean');
    assert.strictEqual(fs.readFileSync(abs('p7s.txt'), 'utf8'), 'staged\n');
  });

  test('T1: pop conflict keeps the entry and opens a stash-pop session', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/conflict');
    write('p7c.txt', 'base\n');
    commitAll('p7 conflict base');
    write('p7c.txt', 'stashed change\n');
    await stash.push({ message: 'p7 conflicting' });
    await waitFor(() => stash.list().length === 1, 10_000);
    write('p7c.txt', 'committed rival\n');
    commitAll('p7 rival');

    const outcome = await stash.pop(0);
    assert.strictEqual(outcome.status, 'conflicts');
    assert.strictEqual(stash.list().length, 1, 'failed pop must keep the stash entry');

    await waitFor(() => reg06.getSession(repoRoot) !== undefined, 15_000);
    const session = reg06.getSession(repoRoot)!;
    assert.strictEqual(session.source, 'stash-pop', 'producer hint classifies the session');
    assert.ok(
      session.files().some((f) => f.path === 'p7c.txt'),
      'conflicts view lists the file',
    );

    await session.acceptSide(['p7c.txt'], 'theirs');
    await waitFor(() => reg06.getSession(repoRoot) === undefined, 15_000);
    assert.strictEqual(fs.readFileSync(abs('p7c.txt'), 'utf8'), 'stashed change\n');
    await stash.drop(0);
    await waitFor(() => stash.list().length === 0, 10_000);
  });

  test('T1: getStashFiles enumerates tracked pairs and third-parent untracked files', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/files');
    write('p7m.txt', 'before\n');
    write('p7d.txt', 'doomed\n');
    commitAll('p7 files base');
    write('p7m.txt', 'after\n');
    fs.rmSync(abs('p7d.txt'));
    write('p7n.txt', 'brand new untracked\n');

    await stash.push({ message: 'p7 files' });
    await waitFor(() => stash.list().length === 1, 10_000);

    const files = await stash.getStashFiles(0);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const modified = byPath.get('p7m.txt')!;
    assert.strictEqual(modified.status, 'modified');
    assert.strictEqual(modified.left?.ref, 'stash@{0}^');
    assert.strictEqual(modified.right.ref, 'stash@{0}');
    assert.strictEqual(byPath.get('p7d.txt')?.status, 'deleted');
    const untracked = byPath.get('p7n.txt')!;
    assert.strictEqual(untracked.status, 'untracked');
    assert.strictEqual(untracked.left, undefined);
    assert.strictEqual(untracked.right.ref, 'stash@{0}^3');
    // The rev pair really resolves: third-parent content is byte-exact.
    assert.strictEqual(git('show', 'stash@{0}^3:p7n.txt'), 'brand new untracked\n');
    assert.strictEqual(git('show', 'stash@{0}:p7m.txt'), 'after\n');

    await stash.drop(0);
  });

  test('T2: view reflects external CLI stashes within 500 ms; rows expand to diffable files', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/view');
    write('p7v.txt', 'base\n');
    commitAll('p7 view base');
    write('p7v.txt', 'changed\n');
    write('p7vu.txt', 'untracked view file\n');

    // External CLI stash → tree row within the 500 ms acceptance bound.
    git('stash', 'push', '--include-untracked', '-m', 'p7 external');
    const start = Date.now();
    await waitFor(() => stash.list().some((s) => s.message.includes('p7 external')), 5_000);
    const elapsed = Date.now() - start;
    assert.ok(elapsed <= 500, `view model refreshed in ${elapsed}ms (bound 500ms)`);

    const roots = await reg07.stashViewProvider.getChildren();
    const row = roots.find(
      (n) => n.kind === 'stash' && n.info.message.includes('p7 external'),
    ) as StashNode & { kind: 'stash' };
    assert.ok(row, 'stash row rendered');
    const rowItem = reg07.stashViewProvider.getTreeItem(row);
    assert.strictEqual(rowItem.contextValue, 'stash:entry');

    // File children: tracked + untracked both carry a vscode.diff command.
    const children = await reg07.stashViewProvider.getChildren(row);
    assert.strictEqual(children.length, 2, 'tracked + untracked children');
    for (const child of children) {
      const item = reg07.stashViewProvider.getTreeItem(child);
      assert.strictEqual(item.command?.command, 'vscode.diff');
      // The diff actually opens (both sides resolvable, headless-safe).
      await vscode.commands.executeCommand(
        'vscode.diff',
        ...(item.command.arguments as [vscode.Uri, vscode.Uri, string]),
      );
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab?.input instanceof vscode.TabInputTextDiff, `diff tab for ${child.kind}`);
      await vscode.window.tabGroups.close(tab);
    }

    // Palette mirrors every verb.
    const all = await vscode.commands.getCommands(true);
    for (const verb of ['push', 'apply', 'pop', 'drop', 'branch', 'clear', 'copyMessage', 'diffAll']) {
      assert.ok(all.includes(`gittree.stash.${verb}`), `gittree.stash.${verb} registered`);
    }

    // Drop via the command path (auto-confirmed modal), node-targeted.
    process.env['GITTREE_TEST_AUTOCONFIRM'] = '1';
    try {
      await vscode.commands.executeCommand('gittree.stash.drop', row);
    } finally {
      delete process.env['GITTREE_TEST_AUTOCONFIRM'];
    }
    await waitFor(() => stash.list().length === 0, 10_000);
  });
});
