import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { RepoHandle } from '../../../src/core/core';
import { makeMergeUri } from '../../../src/core/vdocs/mergeFs';
import type { ConflictSession } from '../../../src/merge/conflictSession';
import type { ConflictsViewProvider } from '../../../src/merge/conflictsView';
import type { TriEditorManager } from '../../../src/merge/triEditor';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

interface Phase06RegistryShape {
  getSession(repoRoot: string): ConflictSession | undefined;
  viewProvider: ConflictsViewProvider;
  triEditors: TriEditorManager;
}

/** P6-T1 acceptance on workspace repoC (the P3 suite ran there long before). */
suite('P6 merge engine — conflict sessions & view', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase06RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string): void => fs.writeFileSync(abs(rel), content);
  const commitAll = (subject: string): string => {
    git('add', '-A');
    git('commit', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoC())!;
    assert.ok(repo, 'repoC not discovered');
    repoRoot = repo.root;
    reg = core.debugRegistry.get('phase06') as Phase06RegistryShape;
    assert.ok(reg, 'phase06 registry missing');
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    // A native merge tab left open (e.g. after an assertion failure) keeps
    // re-reading index stages of later tests' conflicts — close it first.
    for (const group of vscode.window.tabGroups.all) {
      for (const t of group.tabs) {
        const i = t.input;
        if (typeof i === 'object' && i !== null && 'result' in i && 'input1' in i) {
          try {
            await vscode.window.tabGroups.close(t);
          } catch {
            // stale tab handle
          }
        }
      }
    }
    try {
      git('merge', '--abort');
    } catch {
      // no merge in progress
    }
    try {
      git('cherry-pick', '--abort');
    } catch {
      // no cherry-pick in progress
    }
    try {
      git('checkout', '-f', 'main');
    } catch {
      // already there
    }
    const branches = git('branch', '--list', 'p6/*', '--format=%(refname:short)')
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

  /** base → side (their changes) → back on branch (our changes) → merge. */
  function buildConflict(name: string): void {
    git('checkout', '-f', 'main');
    git('checkout', '-b', `p6/${name}`);
    write('p6c.txt', 'base\n');
    write('p6d.txt', 'keep me\n');
    commitAll('p6 base');
    git('checkout', '-b', `p6/${name}-side`);
    write('p6c.txt', 'theirs\n');
    git('rm', '--', 'p6d.txt');
    write('p6new.txt', 'their new\n');
    commitAll('p6 theirs');
    git('checkout', `p6/${name}`);
    write('p6c.txt', 'ours\n');
    write('p6d.txt', 'modified by us\n');
    write('p6new.txt', 'our new\n');
    commitAll('p6 ours');
    try {
      git('merge', `p6/${name}-side`);
      assert.fail('merge should conflict');
    } catch {
      // expected — conflicts
    }
  }

  test('T1: conflict populates the session with correct classifications', async function () {
    this.timeout(90_000);
    buildConflict('classify');
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;
    assert.strictEqual(session.source, 'merge');
    await waitFor(() => session.files().length === 3, 10_000);

    const byPath = new Map(session.files().map((f) => [f.path, f.kind]));
    assert.strictEqual(byPath.get('p6c.txt'), 'both-modified');
    assert.strictEqual(byPath.get('p6d.txt'), 'deleted-by-them');
    assert.strictEqual(byPath.get('p6new.txt'), 'added-by-both');

    // The view renders one row per conflicted file.
    const rows = reg.viewProvider.getChildren();
    assert.strictEqual(rows.length, 3);
    // POST-P14cd: each under GitTree's own address, marked `!` by GitTree.
    for (const row of rows) {
      const item = reg.viewProvider.getTreeItem(row);
      assert.strictEqual(item.resourceUri?.scheme, 'gittree-row');
      assert.strictEqual(item.resourceUri?.authority, 'conflict');
      assert.strictEqual(item.resourceUri?.query, 'conflicted');
    }

    // Continue is blocked while conflicts remain.
    assert.strictEqual(session.canContinue, false);
    assert.strictEqual(await session.continueOp(), false);

    // Accept-side rows resolve and disappear.
    await session.acceptSide(['p6c.txt'], 'theirs');
    assert.strictEqual(fs.readFileSync(abs('p6c.txt'), 'utf8'), 'theirs\n');
    await waitFor(() => !session.files().some((f) => f.path === 'p6c.txt'), 10_000);
    assert.ok(session.resolved.has('p6c.txt'), 'resolved set must track the file');

    // Delete/mode conflicts resolve through the tailored QuickPick.
    process.env['GITTREE_TEST_SPECIAL_CHOICE'] = '0'; // keep OUR modified file
    try {
      const node = { session, path: 'p6d.txt', kind: 'deleted-by-them' as const };
      await vscode.commands.executeCommand('gittree.merge.open', node);
    } finally {
      delete process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    }
    await waitFor(() => !session.files().some((f) => f.path === 'p6d.txt'), 10_000);
    assert.strictEqual(fs.readFileSync(abs('p6d.txt'), 'utf8'), 'modified by us\n');

    await session.acceptSide(['p6new.txt'], 'ours');
    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(session.canContinue, true);

    // Continue completes the merge: MERGE_HEAD gone, two-parent commit.
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
    const parents = git('log', '--format=%P', '-1').trim().split(/\s+/);
    assert.strictEqual(parents.length, 2, 'merge commit expected');
    assert.ok(!fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')));
  });

  test('T2: binary conflicts route to the whole-file side QuickPick', async function () {
    this.timeout(90_000);
    const oursBytes = [0x6f, 0x00, 0x03, 0x6f];
    const theirsBytes = [0x74, 0x00, 0x02, 0x74];
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/bin');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from([0x62, 0x00, 0x01, 0x62]));
    commitAll('p6 bin base');
    git('checkout', '-b', 'p6/bin-side');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from(theirsBytes));
    commitAll('p6 bin theirs');
    git('checkout', 'p6/bin');
    fs.writeFileSync(abs('p6bin.dat'), Buffer.from(oursBytes));
    commitAll('p6 bin ours');
    try {
      git('merge', 'p6/bin-side');
      assert.fail('merge should conflict');
    } catch {
      // expected — binary conflict
    }
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;

    // Classified as a text-kind conflict (both-modified), but compute()
    // detects binary content and opens the side QuickPick instead of T3.
    process.env['GITTREE_TEST_SPECIAL_CHOICE'] = '1'; // keep THEIR version
    try {
      const node = { session, path: 'p6bin.dat', kind: 'both-modified' as const };
      await vscode.commands.executeCommand('gittree.merge.open', node);
    } finally {
      delete process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    }
    await waitFor(() => session.remaining === 0, 10_000);
    assert.deepStrictEqual([...fs.readFileSync(abs('p6bin.dat'))], theirsBytes);
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  /** Two-block conflict on one file; returns the session once live. */
  async function buildTwoBlockConflict(name: string, rel: string): Promise<ConflictSession> {
    git('checkout', '-f', 'main');
    git('checkout', '-b', `p6/${name}`);
    write(rel, 'a\nb\nc\nd\ne\n');
    commitAll(`p6 ${name} base`);
    git('checkout', '-b', `p6/${name}-side`);
    write(rel, 'a\nB2\nc\nD2\ne\n');
    commitAll(`p6 ${name} theirs`);
    git('checkout', `p6/${name}`);
    write(rel, 'a\nB1\nc\nD1\ne\n');
    commitAll(`p6 ${name} ours`);
    try {
      git('merge', `p6/${name}-side`);
      assert.fail('merge should conflict');
    } catch {
      // expected
    }
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    return reg.getSession(repoRoot)!;
  }

  test('T3: tri-editor — chevrons, manual-edit anchors, gated Apply, layout restore', async function () {
    this.timeout(120_000);
    interface EditorLayout {
      orientation: number;
      groups: unknown[];
    }
    const layoutBefore = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    const session = await buildTwoBlockConflict('tri', 'p6tri.txt');

    const node = { session, path: 'p6tri.txt', kind: 'both-modified' as const };
    await vscode.commands.executeCommand('gittree.merge.open', node);
    const tri = reg.triEditors.get(repoRoot, 'p6tri.txt');
    assert.ok(tri, 'tri-editor must register itself');
    assert.strictEqual(tri.blocks.length, 2, 'two conflict blocks expected');
    // Unresolved regions render BASE text.
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nd\ne\n');

    // Apply is gated while conflicts remain.
    assert.strictEqual(await tri.apply(), false);

    // Chevron: first block takes OURS.
    await tri.applyBlockResolution(tri.blocks[0]!.block.id, 'ours');
    assert.strictEqual(tri.resultText(), 'a\nB1\nc\nd\ne\n');

    // Manual edit inside the COMMON segment between the blocks…
    const centerUri = makeMergeUri(repoRoot, 'p6tri.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.insert(centerUri, new vscode.Position(2, 0), 'manual-line\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'manual edit must apply');

    // …must not disturb the second block's anchor: chevron THEIRS after it.
    await tri.applyBlockResolution(tri.blocks[1]!.block.id, 'theirs');
    assert.strictEqual(tri.resultText(), 'a\nB1\nmanual-line\nc\nD2\ne\n');
    assert.strictEqual(tri.unresolvedCount, 0);

    // Apply: exact serialized content in the worktree, staged at stage 0.
    assert.strictEqual(await tri.apply(), true);
    assert.strictEqual(fs.readFileSync(abs('p6tri.txt'), 'utf8'), 'a\nB1\nmanual-line\nc\nD2\ne\n');
    const staged = git('ls-files', '-s', '--', 'p6tri.txt').trim().split('\n');
    assert.strictEqual(staged.length, 1, `single index entry expected: ${staged.join(' | ')}`);
    assert.match(staged[0]!, /\s0\tp6tri\.txt$/, 'stage 0 (resolved) expected');

    // The tri-editor closed itself and restored the editor layout.
    assert.strictEqual(reg.triEditors.get(repoRoot, 'p6tri.txt'), undefined);
    const layoutAfter = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    assert.strictEqual(layoutAfter.orientation, layoutBefore.orientation);
    assert.strictEqual(layoutAfter.groups.length, layoutBefore.groups.length, 'layout restored');

    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  test('POST-QA: a double open makes one merge editor; closing a pane closes it, no modal', async function () {
    this.timeout(90_000);
    const session = await buildTwoBlockConflict('twice', 'p6twice.txt');
    const node = { session, path: 'p6twice.txt', kind: 'both-modified' as const };
    // A double-click in the Conflicts view: two opens before the first is done.
    await Promise.all([
      vscode.commands.executeCommand('gittree.merge.open', node),
      vscode.commands.executeCommand('gittree.merge.open', node),
    ]);
    const tri = reg.triEditors.get(repoRoot, 'p6twice.txt');
    assert.ok(tri, 'tri-editor must register itself');
    const ourTabs = (): number =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputText && /p6twice/.test(t.input.uri.toString())).length;
    assert.strictEqual(ourTabs(), 3, 'one editor: three panes, not six');

    // Closing one pane tears the whole editor down — nothing written, still conflicted.
    const left = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputText && t.input.uri.query.includes('":2"'));
    assert.ok(left, 'left pane tab missing');
    await vscode.window.tabGroups.close(left);
    await waitFor(() => reg.triEditors.get(repoRoot, 'p6twice.txt') === undefined, 10_000);
    await waitFor(() => ourTabs() === 0, 10_000);
    assert.strictEqual(session.remaining, 1, 'the file stays conflicted');
  });

  test('POST-QA: mid-rebase, Yours is the commit being replayed and Accept Yours keeps it', async function () {
    this.timeout(90_000);
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/rebase-onto');
    write('p6rebase.txt', 'one\ntwo\nthree\n');
    commitAll('p6 rebase base');
    git('checkout', '-b', 'p6/rebase-mine');
    write('p6rebase.txt', 'one\nMINE\nthree\n');
    commitAll('p6 rebase mine');
    git('checkout', 'p6/rebase-onto');
    write('p6rebase.txt', 'one\nUPSTREAM\nthree\n');
    commitAll('p6 rebase upstream');
    git('checkout', 'p6/rebase-mine');
    try {
      try {
        git('rebase', 'p6/rebase-onto');
        assert.fail('rebase should stop on the conflict');
      } catch {
        // expected
      }
      await repo.refresher.refreshNow();
      await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
      const session = reg.getSession(repoRoot)!;
      assert.strictEqual(session.reversed, true, 'a rebase swaps git\'s sides back');

      await vscode.commands.executeCommand('gittree.merge.open', {
        session,
        path: 'p6rebase.txt',
        kind: 'both-modified' as const,
      });
      const tri = reg.triEditors.get(repoRoot, 'p6rebase.txt');
      assert.ok(tri, 'tri-editor must register itself');
      const paneText = (stage: string): string | undefined =>
        vscode.workspace.textDocuments.find((d) => d.uri.query.includes(`"ref":"${stage}"`) && d.uri.query.includes('p6rebase'))?.getText();
      // Yours (left) reads stage 3 mid-rebase: the user's own commit.
      assert.match(paneText(':3') ?? '', /MINE/);
      assert.strictEqual(tri.blocks[0]?.block.ours.join(''), 'MINE\n');
      assert.strictEqual(tri.blocks[0]?.block.theirs.join(''), 'UPSTREAM\n');
      assert.match(await tri.sideDetails('left'), /p6 rebase mine/);
      await tri.close();

      // File-level Accept Yours keeps the user's change.
      await session.acceptSide(['p6rebase.txt'], 'ours');
      assert.strictEqual(fs.readFileSync(abs('p6rebase.txt'), 'utf8'), 'one\nMINE\nthree\n');
    } finally {
      try {
        git('rebase', '--abort');
      } catch {
        // already finished
      }
    }
  });

  test('T4: chevron commands, ignore/revert, undo reconciliation, blocked Apply', async function () {
    this.timeout(120_000);
    const session = await buildTwoBlockConflict('chev', 'p6chev.txt');
    const node = { session, path: 'p6chev.txt', kind: 'both-modified' as const };
    await vscode.commands.executeCommand('gittree.merge.open', node);
    const tri = reg.triEditors.get(repoRoot, 'p6chev.txt');
    assert.ok(tri, 'tri-editor must open');
    const b0 = tri.blocks[0]!.block.id;
    const b1 = tri.blocks[1]!.block.id;
    const centerUri = makeMergeUri(repoRoot, 'p6chev.txt');

    // CodeLenses: center offers Accept Both / Ignore per unresolved block,
    // the side panes offer their chevrons.
    let centerTitles: string[] = [];
    await waitFor(() => {
      void vscode.commands
        .executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', centerUri)
        .then((ls) => {
          centerTitles = ls.map((l) => l.command?.title ?? '');
        });
      return centerTitles.includes('Accept Both (Yours First)');
    }, 10_000);
    assert.ok(centerTitles.includes('Ignore (Keep Base)'), `center lenses: ${centerTitles.join(',')}`);
    const leftEd = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.scheme === 'gittree-rev' && e.document.uri.path.includes('(Yours)'),
    );
    assert.ok(leftEd, 'left pane expected');
    const leftLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      leftEd.document.uri,
    );
    assert.ok(
      leftLenses.some((l) => l.command?.command === 'gittree.merge.acceptYours'),
      'left pane must offer Accept Yours ≫',
    );

    // Accept Both on block 0 → ours then theirs.
    await vscode.commands.executeCommand('gittree.merge.acceptBoth', repoRoot, 'p6chev.txt', b0);
    assert.strictEqual(tri.resultText(), 'a\nB1\nB2\nc\nd\ne\n');
    assert.strictEqual(tri.blocks[0]!.block.resolution, 'both');

    // Undo restores base text AND the unresolved state (reconciliation).
    const centerDoc = await vscode.workspace.openTextDocument(centerUri);
    await vscode.window.showTextDocument(centerDoc, { viewColumn: vscode.ViewColumn.Two });
    await vscode.commands.executeCommand('undo');
    await waitFor(() => tri.resultText() === 'a\nb\nc\nd\ne\n', 5_000);
    assert.strictEqual(tri.blocks[0]!.block.resolution, undefined, 'undo → unresolved again');

    // Ignore keeps base but resolves the block.
    await vscode.commands.executeCommand('gittree.merge.ignoreBlock', repoRoot, 'p6chev.txt', b0);
    assert.strictEqual(tri.blocks[0]!.block.resolution, 'manual');
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nd\ne\n');

    // Apply is blocked while block 1 is unresolved — and jumps to it.
    assert.strictEqual(await tri.apply(), false);
    const centerEd = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === centerUri.toString(),
    );
    assert.ok(centerEd, 'center editor expected');
    assert.strictEqual(centerEd.selection.active.line, tri.blocks[1]!.startLine, 'jumped to first conflict');

    // Chevron theirs, revert it, then file-level Accept All Theirs.
    await vscode.commands.executeCommand('gittree.merge.acceptTheirs', repoRoot, 'p6chev.txt', b1);
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nD2\ne\n');
    await vscode.commands.executeCommand('gittree.merge.revertBlock', repoRoot, 'p6chev.txt', b1);
    assert.strictEqual(tri.blocks[1]!.block.resolution, undefined);
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nd\ne\n');
    await vscode.commands.executeCommand('gittree.merge.acceptFileTheirs');
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nD2\ne\n');
    assert.strictEqual(tri.blocks[0]!.block.resolution, 'manual', 'ignored block untouched by accept-all');

    // Apply now succeeds and the merge completes.
    assert.strictEqual(await tri.apply(), true);
    assert.strictEqual(fs.readFileSync(abs('p6chev.txt'), 'utf8'), 'a\nb\nc\nD2\ne\n');
    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  test('T5: magic wand — file cascade with undoable auto tags, session wand completes fully-auto files', async function () {
    this.timeout(120_000);
    // p6wand.txt: block 0 = adjacent-edit interleave (auto), block 1 =
    // same-line divergence (must stay manual). p6wauto.txt: fully auto.
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/wand');
    write('p6wand.txt', 'a\nb\nc\nSEP\nm\nn\no\n');
    write('p6wauto.txt', 'x\ny\nz\nw\n');
    commitAll('p6 wand base');
    git('checkout', '-b', 'p6/wand-side');
    write('p6wand.txt', 'a\nb\nC!\nSEP\nm\nN2\no\n');
    write('p6wauto.txt', 'x\ny\nZ!\nw\n');
    commitAll('p6 wand theirs');
    git('checkout', 'p6/wand');
    write('p6wand.txt', 'a\nB!\nc\nSEP\nm\nN1\no\n');
    write('p6wauto.txt', 'x\nY!\nz\nw\n');
    commitAll('p6 wand ours');
    try {
      git('merge', 'p6/wand-side');
      assert.fail('merge should conflict');
    } catch {
      // expected
    }
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;
    await waitFor(() => session.files().length === 2, 10_000);

    // File-level wand inside the tri-editor.
    const node = { session, path: 'p6wand.txt', kind: 'both-modified' as const };
    await vscode.commands.executeCommand('gittree.merge.open', node);
    const tri = reg.triEditors.get(repoRoot, 'p6wand.txt');
    assert.ok(tri, 'tri-editor must open');
    assert.strictEqual(tri.blocks.length, 2, 'two conflict blocks expected');
    await vscode.commands.executeCommand('gittree.merge.magicWand');
    assert.strictEqual(tri.blocks[0]!.block.resolution, 'auto', 'interleave block auto-resolved');
    assert.deepStrictEqual(tri.blocks[0]!.block.resolvedLines, ['B!\n', 'C!\n']);
    assert.strictEqual(tri.blocks[1]!.block.resolution, undefined, 'adversarial block stays manual');
    assert.strictEqual(tri.resultText(), 'a\nB!\nC!\nSEP\nm\nn\no\n');

    // Every auto-resolution is individually undoable until Apply.
    const b0 = tri.blocks[0]!.block.id;
    await vscode.commands.executeCommand('gittree.merge.revertBlock', repoRoot, 'p6wand.txt', b0);
    assert.strictEqual(tri.blocks[0]!.block.resolution, undefined, 'auto block reverts to unresolved');
    assert.strictEqual(tri.resultText(), 'a\nb\nc\nSEP\nm\nn\no\n');

    // Wand again, chevron the manual block, Apply.
    await vscode.commands.executeCommand('gittree.merge.magicWand');
    assert.strictEqual(tri.blocks[0]!.block.resolution, 'auto');
    await vscode.commands.executeCommand(
      'gittree.merge.acceptYours',
      repoRoot,
      'p6wand.txt',
      tri.blocks[1]!.block.id,
    );
    assert.strictEqual(await tri.apply(), true);
    assert.strictEqual(fs.readFileSync(abs('p6wand.txt'), 'utf8'), 'a\nB!\nC!\nSEP\nm\nN1\no\n');
    await waitFor(() => !session.files().some((f) => f.path === 'p6wand.txt'), 10_000);

    // Session-wide wand: writes + stages the fully-auto file.
    await vscode.commands.executeCommand('gittree.merge.magicWandSession', repoRoot);
    assert.strictEqual(fs.readFileSync(abs('p6wauto.txt'), 'utf8'), 'x\nY!\nZ!\nw\n');
    await waitFor(() => session.remaining === 0, 10_000);
    const staged = git('ls-files', '-s', '--', 'p6wauto.txt').trim().split('\n');
    assert.strictEqual(staged.length, 1, `single index entry expected: ${staged.join(' | ')}`);
    assert.match(staged[0]!, /\s0\tp6wauto\.txt$/, 'stage 0 (resolved) expected');
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  test('T3: center pane serves TypeScript completions (resultMode: markers)', async function () {
    this.timeout(120_000);
    const config = vscode.workspace.getConfiguration('gittree.merge');
    await config.update('resultMode', 'markers', vscode.ConfigurationTarget.Global);
    try {
      git('checkout', '-f', 'main');
      git('checkout', '-b', 'p6/comp');
      const common = 'const obj = { alpha: 1, beta: 2 };\nconst tail = obj.alpha;\n';
      write('p6comp.ts', `${common}const v = 1;\n`);
      commitAll('p6 comp base');
      git('checkout', '-b', 'p6/comp-side');
      write('p6comp.ts', `${common}const v = 2;\n`);
      commitAll('p6 comp theirs');
      git('checkout', 'p6/comp');
      write('p6comp.ts', `${common}const v = 3;\n`);
      commitAll('p6 comp ours');
      try {
        git('merge', 'p6/comp-side');
        assert.fail('merge should conflict');
      } catch {
        // expected
      }
      await repo.refresher.refreshNow();
      await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
      const session = reg.getSession(repoRoot)!;

      const node = { session, path: 'p6comp.ts', kind: 'both-modified' as const };
      await vscode.commands.executeCommand('gittree.merge.open', node);
      const tri = reg.triEditors.get(repoRoot, 'p6comp.ts');
      assert.ok(tri, 'tri-editor must open');

      // markers mode: the center pane is the real file (language: typescript).
      const centerUri = vscode.Uri.file(abs('p6comp.ts'));
      const doc = await vscode.workspace.openTextDocument(centerUri);
      assert.strictEqual(doc.languageId, 'typescript');
      // Completion after `obj.` on line 1 → member items from the LSP.
      const pos = new vscode.Position(1, 'const tail = obj.'.length);
      let labels: string[] = [];
      const deadline = Date.now() + 60_000;
      // Poll: the TS server needs time to boot in a cold test host.
      while (Date.now() < deadline) {
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          centerUri,
          pos,
        );
        labels = (list?.items ?? []).map((i) =>
          typeof i.label === 'string' ? i.label : i.label.label,
        );
        if (labels.includes('alpha') && labels.includes('beta')) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(labels.includes('alpha'), `completions must include 'alpha': ${labels.slice(0, 10).join(',')}`);

      await tri.close();
      await session.abortOp();
      await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
    } finally {
      await config.update('resultMode', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // P14-T5 deleted the native merge bridge with the `_open.mergeEditor`
  // internal command it rode on, so the T6 test that pinned `merge.ui:
  // native` went with it. The tri-editor it used to fall back to has been
  // the default throughout and is covered by the tests above.

  test('T7: mutation lane held during pause — queued mutation runs only after continue', async function () {
    this.timeout(120_000);
    const session = await buildTwoBlockConflict('hold', 'p6hold.txt');

    // An unrelated mutation queues behind the held lane…
    let ran = false;
    const queued = repo.queue.enqueue({
      label: 'unrelated mutation',
      kind: 'mutate',
      run: () => {
        ran = true;
        return Promise.resolve();
      },
    });
    // …while reads still flow.
    const read = await repo.queue.enqueue({
      label: 'read probe',
      kind: 'read',
      run: () => Promise.resolve('ok'),
    });
    assert.strictEqual(read, 'ok', 'reads must flow during the hold');
    assert.strictEqual(ran, false, 'held mutation must not run during the pause');

    // Resolution ops bypass the hold; the hold itself persists until continue.
    await session.acceptSide(['p6hold.txt'], 'ours');
    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(ran, false, 'held mutation still queued after resolve, before continue');

    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
    await queued;
    assert.strictEqual(ran, true, 'held mutation runs once the pause ends');
  });

  test('T7: cherry-pick conflict auto-creates a session; continue completes the pick', async function () {
    this.timeout(120_000);
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/cp');
    write('p6cp.txt', 'base\n');
    commitAll('p6 cp base');
    git('checkout', '-b', 'p6/cp-side');
    write('p6cp.txt', 'picked\n');
    commitAll('p6 cp side change');
    const pick = git('rev-parse', 'HEAD').trim();
    git('checkout', 'p6/cp');
    write('p6cp.txt', 'ours\n');
    commitAll('p6 cp ours');
    try {
      git('cherry-pick', pick);
      assert.fail('cherry-pick should conflict');
    } catch {
      // expected
    }
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;
    assert.strictEqual(session.source, 'cherry-pick', 'producer detection from sequencer marker');

    await session.acceptSide(['p6cp.txt'], 'theirs');
    await waitFor(() => session.remaining === 0, 10_000);
    assert.strictEqual(await session.continueOp(), true);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p6 cp side change');
    assert.strictEqual(fs.readFileSync(abs('p6cp.txt'), 'utf8'), 'picked\n');
  });

  test('POST-QA: a resolved merge commits from the Commit window while its session holds the lane', async function () {
    this.timeout(120_000);
    const p3 = (await activateGitTree()).debugRegistry.get('phase03') as Phase03Registry;
    if (p3.paradigm.paradigm !== 'changelists') this.skip();
    const session = await buildTwoBlockConflict('cwmerge', 'p6cw.txt');
    const ours = git('rev-parse', 'HEAD').trim();
    const theirs = git('rev-parse', 'p6/cwmerge-side').trim();
    await session.acceptSide(['p6cw.txt'], 'theirs');
    await waitFor(() => session.remaining === 0, 10_000);
    const lists = p3.changelistsFor(repo);
    await waitFor(() => lists.getLists().some((l) => l.checked.includes('p6cw.txt')), 15_000);
    p3.messageBoxFor(repo).value = 'p6 merge from the commit window';

    // Before: `commit --only` was refused mid-merge, and the commit queued
    // behind the session's hold on the lane — which only that commit lifts.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        vscode.commands.executeCommand('gittree.commit', repoRoot),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('the merge commit hung behind the hold')), 30_000);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    assert.ok(!fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')), 'the merge must be committed');
    assert.deepStrictEqual(git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1), [ours, theirs]);
    assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p6 merge from the commit window');
    assert.strictEqual(git('show', 'HEAD:p6cw.txt'), 'a\nB2\nc\nD2\ne\n');
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });

  test('POST-QA: a sequence that stops again is announced again, and continuing into it is no failure', async function () {
    this.timeout(120_000);
    const lifecycle = (reg as unknown as { lifecycle: { onDidStartSession: vscode.Event<ConflictSession> } })
      .lifecycle;
    git('checkout', '-f', 'main');
    git('checkout', '-b', 'p6/seq');
    write('p6seq1.txt', 'base one\n');
    write('p6seq2.txt', 'base two\n');
    commitAll('p6 seq base');
    git('checkout', '-b', 'p6/seq-side');
    write('p6seq1.txt', 'side one\n');
    const first = commitAll('p6 seq side one');
    write('p6seq2.txt', 'side two\n');
    const second = commitAll('p6 seq side two');
    git('checkout', 'p6/seq');
    write('p6seq1.txt', 'ours one\n');
    write('p6seq2.txt', 'ours two\n');
    commitAll('p6 seq ours');

    const starts: ConflictSession[] = [];
    const sub = lifecycle.onDidStartSession((s) => starts.push(s));
    try {
      try {
        git('cherry-pick', first, second);
        assert.fail('the first pick should conflict');
      } catch {
        // expected
      }
      await repo.refresher.refreshNow();
      await waitFor(() => reg.getSession(repoRoot) !== undefined && starts.length === 1, 15_000);
      const session = reg.getSession(repoRoot)!;
      await session.acceptSide(['p6seq1.txt'], 'theirs');
      await waitFor(() => session.remaining === 0, 10_000);

      // The second pick stops on conflicts of its own: once a GitError
      // ("could not apply"), now a new stop of the same session.
      assert.strictEqual(await session.continueOp(), true);
      await repo.refresher.refreshNow();
      await waitFor(() => session.remaining === 1 && starts.length === 2, 15_000);
      assert.strictEqual(starts[1], session, 'the same session, announced for its new stop');

      await session.acceptSide(['p6seq2.txt'], 'theirs');
      await waitFor(() => session.remaining === 0, 10_000);
      assert.strictEqual(await session.continueOp(), true);
      await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
      assert.strictEqual(git('log', '-1', '--format=%s').trim(), 'p6 seq side two');
      assert.strictEqual(starts.length, 2);
    } finally {
      sub.dispose();
    }
  });

  test('T1: abort restores the pre-merge state and closes the session', async function () {
    this.timeout(90_000);
    buildConflict('abort');
    const preHead = git('rev-parse', 'HEAD').trim();
    await repo.refresher.refreshNow();
    await waitFor(() => reg.getSession(repoRoot) !== undefined, 15_000);
    const session = reg.getSession(repoRoot)!;

    await session.abortOp();
    assert.strictEqual(git('rev-parse', 'HEAD').trim(), preHead, 'abort must restore HEAD');
    assert.ok(!fs.existsSync(path.join(repo.dirs.gitDir, 'MERGE_HEAD')));
    const status = git('status', '--porcelain');
    assert.strictEqual(status.trim(), '', `worktree must be clean after abort: ${status}`);
    await waitFor(() => reg.getSession(repoRoot) === undefined, 15_000);
  });
});
