import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase04Registry } from '../../../src/log/register';
import { activateGitTree, waitFor, workspaceRepoA } from '../setup';

/** Phase 4 host-side acceptance (webview internals covered by Playwright). */
suite('P4 log & blame host', () => {
  let repoRoot: string;
  let fsRoot: string;
  let reg: Phase04Registry;

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoA();
    const core = await activateGitTree();
    fsRoot = core.repoForPath(repoRoot)!.root;
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    assert.ok(reg, 'phase04 registry missing');
  });

  test('log view boots a session and streams rows', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => (reg.logView.currentSession?.rowCount ?? 0) > 0, 30_000).catch((err: Error) => {
      const root = reg.logView.currentSession?.repoRoot ?? repoRoot;
      let replay = '';
      try {
        const out = execFileSync(
          'git',
          [
            'log',
            '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b%x1e',
            '--parents',
            '--topo-order',
            '--skip=0',
            '--max-count=2000',
          ],
          { cwd: root, encoding: 'latin1' },
        );
        replay = `replay bytes=${out.length} frames=${out.split('\x1e').length - 1}`;
      } catch (e) {
        replay = `replay failed: ${String(e)}`;
      }
      throw new Error(
        `${err.message} — trail: ${JSON.stringify(reg.logView.debugTrail)} — ${replay}`,
      );
    });
    const session = reg.logView.currentSession!;
    assert.ok(session.repoRoot.length > 0);
    assert.strictEqual(session.filter.sort, 'topo');
  });

  test('revealCommit loads pages until the sha is present', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    await reg.logView.revealCommit(head);
    assert.ok((reg.logView.currentSession?.rowCount ?? 0) > 0);
  });

  test('file history opens the log in --follow path mode', async function () {
    this.timeout(60_000);
    const target = vscode.Uri.file(path.join(fsRoot, 'README.md'));
    await vscode.commands.executeCommand('gittree.showFileHistory', target);
    await waitFor(() => reg.logView.currentSession?.filter.follow === true, 15_000);
    const filter = reg.logView.currentSession!.filter;
    assert.deepStrictEqual(filter.paths, ['README.md']);
    assert.strictEqual(filter.refs, 'ALL');
  });

  test('compare-in-log sets a range filter (P2-T5 upgrade)', async function () {
    this.timeout(60_000);
    git('branch', '-f', 'p4-compare', 'HEAD');
    await vscode.commands.executeCommand('gittree.branches.compareInLog', repoRoot, 'p4-compare');
    await waitFor(() => reg.logView.currentSession?.filter.range !== undefined, 15_000);
    assert.strictEqual(reg.logView.currentSession!.filter.range!.a, 'p4-compare');
    git('branch', '-D', 'p4-compare');
  });

  test('commit actions: branch/tag here, reset soft round-trip', async function () {
    this.timeout(60_000);
    const head = git('rev-parse', 'HEAD').trim();
    const parent = git('rev-parse', 'HEAD~1').trim();

    process.env['GITTREE_TEST_BRANCH_NAME'] = 'p4/action-branch';
    try {
      await vscode.commands.executeCommand('gittree.log.createBranchHere', { sha: head });
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    assert.ok(git('branch', '--list', 'p4/action-branch').includes('p4/action-branch'));
    git('branch', '-D', 'p4/action-branch');

    process.env['GITTREE_TEST_BRANCH_NAME'] = 'p4-tag';
    try {
      await vscode.commands.executeCommand('gittree.log.createTagHere', { sha: head });
    } finally {
      delete process.env['GITTREE_TEST_BRANCH_NAME'];
    }
    assert.ok(git('tag', '--list', 'p4-tag').includes('p4-tag'));
    git('tag', '-d', 'p4-tag');

    process.env['GITTREE_TEST_RESET_MODE'] = 'soft';
    try {
      await vscode.commands.executeCommand('gittree.log.resetHere', { sha: parent });
    } finally {
      delete process.env['GITTREE_TEST_RESET_MODE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() === parent, 15_000);
    // Restore (the commit is still referenced by the soft-reset index).
    git('reset', '--soft', head);
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), head);
  });

  test('copy revision number writes the clipboard', async function () {
    this.timeout(30_000);
    const head = git('rev-parse', 'HEAD').trim();
    await vscode.commands.executeCommand('gittree.log.copySha', { sha: head });
    assert.strictEqual(await vscode.env.clipboard.readText(), head);
  });

  test('blame toggle annotates and cursorCommit resolves the line author', async function () {
    this.timeout(60_000);
    const file = path.join(fsRoot, 'README.md');
    assert.ok(fs.existsSync(file));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await reg.blameUi.toggle(editor);
    await waitFor(() => reg.blameUi.cursorCommit() !== undefined, 20_000);
    const lb = reg.blameUi.cursorCommit()!;
    assert.match(lb.sha, /^[0-9a-f]{40}$/);
    assert.ok(lb.author.length > 0);
    await reg.blameUi.toggle(editor); // off again
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
