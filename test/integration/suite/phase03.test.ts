import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { NotificationsRegistry } from '../../../src/ui/notify';
import type { Phase03Registry } from '../../../src/commit/register';
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
  let messageBox: { value: string };

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
    // P14-T2: the SCM input box is retired; the commit window's message box is
    // the only place a message lives, and the commit flow reads it.
    messageBox = reg.messageBoxFor(repo);
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

    // P14-T2: the changelists tree view is gone, so its node shape is no longer
    // the contract — the commit window's state DTO is, and phase11 asserts it.
    // What still belongs here is the service-level truth the DTO is built from.
    const lists = service.getLists();
    assert.ok(
      lists.some((l) => l.id === feature.id),
      'feature list missing from the service',
    );
    assert.deepStrictEqual(service.getList(feature.id)?.checked, ['src/code.ts']);
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

    messageBox.value = 'feature x commit';
    const notes = (await activateGitTree()).debugRegistry.get('notifications') as NotificationsRegistry;
    notes.clear();
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      // P14-T2: the commit window's context shape replaces the tree node.
      await vscode.commands.executeCommand('gittree.changelist.commitList', {
        repoRoot: repo.root,
        listId: feature.id,
      });
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await refresh();
    await waitFor(() => git('log', '-1', '--format=%s').trim() === 'feature x commit', 15_000);

    const committed = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort();
    assert.deepStrictEqual(committed, ['brand-new.txt', 'src/code.ts']);
    // POST-P14ap: IntelliJ's commit result — the files counted, the subject quoted.
    await waitFor(() => notes.recent().some((n) => n.message === '2 files committed: feature x commit'), 15_000);
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
    // P11-T5 made deferred advanced checks the default (IntelliJ parity), so
    // the gating behaviour this test exists to prove is now behind the flag.
    await vscode.workspace
      .getConfiguration('gittree.commit.checks')
      .update('deferAdvanced', false, vscode.ConfigurationTarget.Workspace);
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
    messageBox.value = 'analyze gate commit';
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
    await vscode.workspace
      .getConfiguration('gittree.commit.checks')
      .update('deferAdvanced', undefined, vscode.ConfigurationTarget.Workspace);
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

    // Template prefill. The config edit is written in place with fs — `git
    // config` rewrites via rename-over, which needs delete-share on
    // .git/config and loses to AV/indexer readers under suite load (EPERM
    // even across a 20s retry budget); append/truncate-in-place does not.
    write('.gittemplate', 'PROJ-000: \n# comment line\n');
    const cfgPath = path.join(repo.dirs.gitDir, 'config');
    const originalCfg = fs.readFileSync(cfgPath, 'utf8');
    fs.appendFileSync(cfgPath, '\n[commit]\n\ttemplate = .gittemplate\n');
    try {
      messageBox.value = '';
      await reg.history.applyTemplate(repo, messageBox);
      assert.strictEqual(messageBox.value, 'PROJ-000: ');
    } finally {
      fs.writeFileSync(cfgPath, originalCfg);
      messageBox.value = '';
    }
  });

  test('POST-P14v: Add to VCS versions a selection into the default changelist', async function () {
    this.timeout(60_000);
    const service = reg.changelistsFor(repo);
    // A list that is ACTIVE but not default: adoption sends new tracked files
    // here, and IntelliJ's rule sends added files to the default list instead.
    // Without that distinction this test cannot tell the two apart.
    const side = service.create('P14v side list', undefined, true);
    write('v-one.txt', 'one\n');
    write('nested/v-two.txt', 'two\n');
    await refresh();
    await waitFor(
      () => service.unversioned().includes('v-one.txt') && service.unversioned().includes('nested/v-two.txt'),
      15_000,
    );

    try {
      await vscode.commands.executeCommand('gittree.addToVcs', {
        repoRoot: fsRoot,
        relPath: 'v-one.txt',
        relPaths: ['v-one.txt', 'nested/v-two.txt'],
      });
      await refresh();

      // Versioned: git tracks them now, so they leave Unversioned Files. Only
      // these two — earlier tests in this suite leave unversioned files of
      // their own in repoC, and asserting the bucket is empty would fail on
      // work this command never touched.
      await waitFor(
        () =>
          !service.unversioned().includes('v-one.txt') &&
          !service.unversioned().includes('nested/v-two.txt'),
        15_000,
      );
      // `ls-files`, not `diff --cached`: git deliberately hides intent-to-add
      // entries from `diff --cached` (they need `--ita-visible-in-index`), so
      // the diff is empty for a file that IS in the index. Asking the index
      // directly is the only honest question here.
      const tracked = git('ls-files', '--', 'v-one.txt', 'nested/v-two.txt')
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .sort();
      assert.deepStrictEqual(
        tracked,
        ['nested/v-two.txt', 'v-one.txt'],
        'add -N must record both paths in the index',
      );
      // Intent-to-add, not a content stage: the changelists paradigm keeps the
      // index free of content nobody asked to stage, and commitChangelistPartial
      // builds its own tree on the assumption that it is.
      assert.strictEqual(
        git('cat-file', '-p', ':v-one.txt'),
        '',
        'add -N must not put file content in the index',
      );

      // In the DEFAULT list, not the active one.
      const def = service.getLists().find((l) => l.isDefault)!;
      assert.ok(def.files.includes('v-one.txt'), 'v-one.txt not in the default list');
      assert.ok(def.files.includes('nested/v-two.txt'), 'nested/v-two.txt not in the default list');
      assert.deepStrictEqual(service.getList(side.id)?.files, [], 'active list must not claim them');
      // Ticked, the way a changelist file is.
      assert.ok(service.isChecked('v-one.txt'));
    } finally {
      git('reset', '-q', '--', 'v-one.txt', 'nested/v-two.txt');
      fs.rmSync(path.join(repoRoot, 'v-one.txt'), { force: true });
      fs.rmSync(path.join(repoRoot, 'nested'), { recursive: true, force: true });
      service.setActive(service.getLists().find((l) => l.isDefault)!.id);
      service.remove(side.id);
      await refresh();
    }
  });

  test('T5: amend toggle loads previous message and rewrites HEAD', async function () {
    this.timeout(60_000);
    const before = git('rev-parse', 'HEAD').trim();
    const subject = git('log', '-1', '--format=%s').trim();
    messageBox.value = '';
    await vscode.commands.executeCommand('gittree.commit.toggleAmend', repoRoot);
    assert.strictEqual(messageBox.value, subject, 'amend should load the previous message');

    messageBox.value = 'amended subject line';
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
