import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { Phase01Registry } from '../../../src/scm/register';
import { canonicalKey } from '../../../src/core/repoDiscovery';
import type { RepoHandle } from '../../../src/core/core';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

/** Phase 3 acceptance on workspace repoC (dedicated to this suite). */
suite('P3 commit lifecycle', () => {
  let repoRoot: string;
  /** Canonical (long-form) root — ALL vscode.Uri constructions must use this
   *  so uris match what the extension builds from repo.root (8.3 short-path
   *  workspaces would otherwise produce two spellings of one file). */
  let fsRoot: string;
  let repo: RepoHandle;
  let reg: Phase03Registry;
  let scmInput: vscode.SourceControlInputBox;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const write = (rel: string, content: string): void => {
    const p = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const refresh = async (): Promise<void> => repo.refresher.refreshNow();

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGitTree();
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoC not discovered');
    fsRoot = repo.root;
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    const phase01 = core.debugRegistry.get('phase01') as Phase01Registry;
    scmInput = phase01.sourceControls.get(canonicalKey(repoRoot))!.sc.inputBox;
  });

  test('T2/T3: changelists adopt, move, check and persist', async function () {
    this.timeout(60_000);
    assert.strictEqual(reg.paradigm.paradigm, 'changelists');
    write('src/code.ts', 'export const one = 1; // edited\n');
    write('brand-new.txt', 'untracked\n');
    await refresh();

    const service = reg.changelistsFor(repo);
    await waitFor(() => service.getLists()[0]!.files.includes('src/code.ts'), 15_000);
    assert.deepStrictEqual(service.unversioned(), ['brand-new.txt']);

    // Move file to a new list; checkbox state flows through the service.
    // NOT active: later seeded files must keep landing in the default list.
    const feature = service.create('Feature X', 'comment here', false);
    service.moveFiles(['src/code.ts'], feature.id);
    assert.deepStrictEqual(service.getList(feature.id)?.files, ['src/code.ts']);
    service.setChecked(['src/code.ts'], false);
    assert.deepStrictEqual(service.getList(feature.id)?.checked, []);
    service.setChecked(['src/code.ts'], true);

    // View shape: list nodes + unversioned bucket.
    const nodes = reg.viewProvider.getChildren(
      reg.viewProvider
        .getChildren()
        .find((n) => n.kind === 'repo' && canonicalKey(n.repo.root) === canonicalKey(repoRoot)),
    );
    const listNode = nodes.find((n) => n.kind === 'list' && n.list.id === feature.id);
    assert.ok(listNode, 'feature list node missing');
    const unversionedNode = nodes.find((n) => n.kind === 'unversioned');
    assert.ok(unversionedNode, 'unversioned node missing');
    const item = reg.viewProvider.getTreeItem(listNode);
    assert.strictEqual(item.checkboxState, vscode.TreeItemCheckboxState.Checked);
  });

  test('T5: changelist commit bypasses the index and leaves other lists untouched', async function () {
    this.timeout(60_000);
    const service = reg.changelistsFor(repo);
    // Second dirty file stays in the default list.
    write('other.txt', 'other work\n');
    git('add', '-N', 'other.txt'); // make it tracked-dirty (intent to add)
    // Also stage something unrelated to prove --only ignores the index.
    write('staged-decoy.txt', 'decoy\n');
    git('add', 'staged-decoy.txt');
    await refresh();
    await waitFor(() => service.getLists().some((l) => l.files.includes('other.txt')), 15_000);

    // Move the untracked brand-new.txt into the feature list too (add -N path).
    const feature = service.getLists().find((l) => l.name === 'Feature X')!;
    service.moveFiles(['brand-new.txt'], feature.id);

    scmInput.value = 'feature x commit';
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.changelist.commitList', {
        kind: 'list',
        repo,
        list: service.getList(feature.id)!,
      });
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await refresh();
    await waitFor(() => git('log', '-1', '--format=%s').trim() === 'feature x commit', 15_000);

    const committed = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepStrictEqual(committed, ['brand-new.txt', 'src/code.ts']);
    // Decoy is still staged, other.txt still dirty — untouched.
    const status = git('status', '--porcelain');
    assert.ok(status.includes('A  staged-decoy.txt'), `status:\n${status}`);
    assert.ok(status.includes('other.txt'), `status:\n${status}`);
  });

  test('T1: paradigm switch to staging unstages nothing; back to changelists resets index', async function () {
    this.timeout(60_000);
    await reg.paradigm.switch(); // changelists → staging (keeps index)
    await waitFor(() => reg.paradigm.paradigm === 'staging', 10_000);
    assert.ok(git('status', '--porcelain').includes('A  staged-decoy.txt'), 'index must be kept');

    await reg.paradigm.switch(); // staging → changelists (unstages, auto-confirmed)
    await waitFor(() => reg.paradigm.paradigm === 'changelists', 10_000);
    await refresh();
    const status = git('status', '--porcelain');
    assert.ok(!status.includes('A  staged-decoy.txt'), `index should be reset:\n${status}`);
    assert.ok(status.includes('?? staged-decoy.txt') || status.includes('A staged-decoy'), status);
    // Back to staging for the hunk tests.
    await reg.paradigm.switch();
    await waitFor(() => reg.paradigm.paradigm === 'staging', 10_000);
  });

  test('T4: stage exactly 2 of 3 hunks via selected ranges', async function () {
    this.timeout(60_000);
    // Reset to a clean tracked file with known content.
    git('add', '-A');
    git('commit', '--allow-empty', '-m', 'baseline for hunks');
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    write('hunks.txt', original);
    git('add', 'hunks.txt');
    git('commit', '-m', 'add hunks.txt');

    const lines = original.split('\n');
    lines[2] = 'line 3 CHANGED';   // hunk 1 (line 3)
    lines[14] = 'line 15 CHANGED'; // hunk 2 (line 15)
    lines[27] = 'line 28 CHANGED'; // hunk 3 (line 28)
    write('hunks.txt', lines.join('\n'));
    await refresh();

    const uri = vscode.Uri.file(path.join(fsRoot, 'hunks.txt'));
    const editor = await vscode.window.showTextDocument(uri);
    editor.selections = [
      new vscode.Selection(2, 0, 2, 5),
      new vscode.Selection(14, 0, 14, 5),
    ];
    await vscode.commands.executeCommand('gittree.stage.selectedRanges');
    await refresh();

    const cached = git('diff', '--cached', '--', 'hunks.txt');
    assert.ok(cached.includes('line 3 CHANGED'), `cached:\n${cached}`);
    assert.ok(cached.includes('line 15 CHANGED'), 'second hunk missing');
    assert.ok(!cached.includes('line 28 CHANGED'), 'third hunk must stay unstaged');

    // Unstage round-trip.
    editor.selections = [new vscode.Selection(14, 0, 14, 5)];
    await vscode.commands.executeCommand('gittree.unstage.selectedRanges');
    const cached2 = git('diff', '--cached', '--', 'hunks.txt');
    assert.ok(cached2.includes('line 3 CHANGED'));
    assert.ok(!cached2.includes('line 15 CHANGED'), 'hunk 2 should be unstaged again');
    git('reset', '-q');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('T4: CRLF hunk staging keeps bytes identical', async function () {
    this.timeout(60_000);
    const crlf = 'alpha\r\nbeta\r\ngamma\r\n';
    write('crlf.txt', crlf);
    git('add', 'crlf.txt');
    git('commit', '-m', 'crlf base');
    const edited = 'alpha\r\nBETA!\r\ngamma\r\n';
    write('crlf.txt', edited);
    await refresh();

    const uri = vscode.Uri.file(path.join(fsRoot, 'crlf.txt'));
    const editor = await vscode.window.showTextDocument(uri);
    editor.selections = [new vscode.Selection(1, 0, 1, 3)];
    await vscode.commands.executeCommand('gittree.stage.selectedRanges');

    const stagedBytes = execFileSync('git', ['show', ':0:crlf.txt'], { cwd: repoRoot });
    assert.strictEqual(stagedBytes.toString('latin1'), edited, 'staged bytes differ');
    const worktreeBytes = fs.readFileSync(path.join(repoRoot, 'crlf.txt'));
    assert.strictEqual(worktreeBytes.toString('latin1'), edited, 'worktree corrupted');
    git('reset', '-q');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('T7: analyze check blocks on seeded diagnostics; Commit Anyway proceeds', async function () {
    this.timeout(90_000);
    // Seed a diagnostic OURSELVES — deterministic, no language server needed.
    const uri = vscode.Uri.file(path.join(fsRoot, 'src', 'code.ts'));
    write('src/code.ts', 'export const one = 1; // diagnostic target\n');
    git('add', 'src/code.ts');
    const collection = vscode.languages.createDiagnosticCollection('gittree-test');
    collection.set(uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 5),
        'seeded error for the analyze check',
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
    await refresh();

    // The commit flow resolves its target from the MODEL — wait until the
    // externally staged file is visible there, or the flow may fall into the
    // commit-all path and race the assertions.
    await waitFor(
      () =>
        repo.model.snapshot.statusEntries.some((e) => e.path === 'src/code.ts' && e.x !== '.'),
      15_000,
    );
    assert.strictEqual(vscode.languages.getDiagnostics(uri).length, 1, 'seeded diagnostic missing');

    const before = git('rev-parse', 'HEAD').trim();
    scmInput.value = 'analyze gate commit';
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'cancel';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), before, 'cancel must not commit');

    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('rev-parse', 'HEAD').trim() !== before, 20_000);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'analyze gate commit');
    collection.dispose();
  });

  test('T7: TODO check flags only newly added markers', async function () {
    this.timeout(60_000);
    write('todo-file.ts', '// TODO existing\nconst a = 1;\n');
    git('add', 'todo-file.ts');
    git('commit', '-m', 'todo base');
    write('todo-file.ts', '// TODO existing\nconst a = 1;\n// TODO fresh marker\n');
    git('add', 'todo-file.ts');
    await refresh();

    const { todoCheck } = await import('../../../src/commit/checks/todo');
    const { CancellationSource } = await import('../../../src/core/util/cancellation');
    const src = new CancellationSource();
    const result = await todoCheck.run({
      repo,
      files: [vscode.Uri.file(path.join(fsRoot, 'todo-file.ts'))],
      token: src.token,
      progress: () => undefined,
    });
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.message.includes('1 new TODO'), result.message);
      assert.ok(result.message.includes('fresh marker'), result.message);
    }
    git('reset', '-q');
  });

  test('T7: reformat check touches only modified ranges', async function () {
    this.timeout(60_000);
    // A deterministic range formatter for plaintext, registered by the test.
    const formatter = vscode.languages.registerDocumentRangeFormattingEditProvider(
      { pattern: '**/fmt-target.fmttest' },
      {
        provideDocumentRangeFormattingEdits(doc, range) {
          return [vscode.TextEdit.replace(range, doc.getText(range).toUpperCase())];
        },
      },
    );
    try {
      write('fmt-target.fmttest', 'aaa\nbbb\nccc\nddd\n');
      git('add', 'fmt-target.fmttest');
      git('commit', '-m', 'fmt base');
      write('fmt-target.fmttest', 'aaa\nbbb edited\nccc\nddd\n');
      await refresh();

      await vscode.workspace
        .getConfiguration('gittree.commit.checks')
        .update('reformat', true, vscode.ConfigurationTarget.Workspace);
      const { reformatCheck } = await import('../../../src/commit/checks/reformat');
      const { CancellationSource } = await import('../../../src/core/util/cancellation');
      const src = new CancellationSource();
      const result = await reformatCheck.run({
        repo,
        files: [vscode.Uri.file(path.join(fsRoot, 'fmt-target.fmttest'))],
        token: src.token,
        progress: () => undefined,
      });
      assert.strictEqual(result.ok, true);
      const content = fs.readFileSync(path.join(repoRoot, 'fmt-target.fmttest'), 'utf8');
      assert.strictEqual(content, 'aaa\nBBB EDITED\nccc\nddd\n', `content:\n${content}`);
    } finally {
      formatter.dispose();
      await vscode.workspace
        .getConfiguration('gittree.commit.checks')
        .update('reformat', undefined, vscode.ConfigurationTarget.Workspace);
      git('checkout', '--', 'fmt-target.fmttest');
    }
  });

  test('T6: message history stores commits and template prefills', async function () {
    this.timeout(60_000);
    const entries = await reg.history.entries(repo);
    assert.ok(
      entries.some((e) => e.message === 'feature x commit'),
      `history: ${entries.map((e) => e.message).join(' | ')}`,
    );
    assert.ok(
      entries.some((e) => e.message === 'analyze gate commit'),
      'second commit missing from history',
    );

    // Template prefill.
    write('.gittemplate', 'PROJ-000: \n# comment line\n');
    git('config', 'commit.template', '.gittemplate');
    scmInput.value = '';
    await reg.history.applyTemplate(repo, scmInput);
    assert.strictEqual(scmInput.value, 'PROJ-000: ');
    git('config', '--unset', 'commit.template');
    scmInput.value = '';
  });

  test('T5: amend toggle loads previous message and rewrites HEAD', async function () {
    this.timeout(60_000);
    const before = git('rev-parse', 'HEAD').trim();
    const subject = git('log', '-1', '--format=%s').trim();
    scmInput.value = '';
    await vscode.commands.executeCommand('gittree.commit.toggleAmend', repoRoot);
    assert.strictEqual(scmInput.value, subject, 'amend should load the previous message');

    scmInput.value = 'amended subject line';
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.commit', repoRoot);
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('log', '-1', '--format=%s').trim() === 'amended subject line', 20_000);
    assert.notStrictEqual(git('rev-parse', 'HEAD').trim(), before);
    assert.strictEqual(
      git('rev-list', '--count', 'HEAD').trim(),
      git('rev-list', '--count', before).trim(),
      'amend must not add a commit',
    );
  });
});
