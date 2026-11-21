import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { Phase13Registry } from '../../../src/scm/dialogs/register';
import { countMerge, mergeStatusText } from '../../../src/merge/applyNonConflicting';
import type { ConflictSession } from '../../../src/merge/conflictSession';
import type { TriEditorManager } from '../../../src/merge/triEditor';
import { activateGeet, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

/**
 * P13-T8 · §3.5 + S7. `Apply non-conflicting changes` is three actions in
 * IntelliJ; Geet's wand only ever implemented "All". These drive the real
 * tri-editor over a real conflicted file, and the S7 gate over a real session.
 */
suite('P13 merge parity', () => {
  let core: Core;
  let reg: Phase13Registry;
  let repo: RepoHandle;
  let repoRoot: string;
  let branch: string;
  let triEditors: TriEditorManager;
  let lifecycle: { get(repoRoot: string): ConflictSession | undefined };

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const write = (rel: string, content: string): void => {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const commit = (subject: string): string => {
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };

  const REL = 'p13/t8-merge.txt';
  /**
   * Two conflict blocks, deliberately different in kind:
   *   - lines 2–3: we changed l2, they changed l3. Adjacent, so git groups them
   *     into ONE block that neither side alone owns — the wand's *interleave*
   *     rule resolves it, and a one-sided apply must NOT.
   *   - line 6: both sides changed the same line differently — a genuine
   *     conflict nothing may resolve automatically.
   *
   * Note what is deliberately absent: a "one side only" block. `git merge-file`
   * applies every non-overlapping change itself before we ever see the file, so
   * such a block cannot be produced from a normal merge (verified empirically —
   * see the deviation note). That is precisely why Left/Right must be safe
   * no-ops here rather than quietly taking a side.
   */
  const BASE = ['l1\n', 'l2\n', 'l3\n', 'l4\n', 'l5\n', 'l6\n', 'l7\n'].join('');
  const OURS = ['l1\n', 'OURS2\n', 'l3\n', 'l4\n', 'l5\n', 'OURS6\n', 'l7\n'].join('');
  const THEIRS = ['l1\n', 'l2\n', 'THEIRS3\n', 'l4\n', 'l5\n', 'THEIRS6\n', 'l7\n'].join('');

  let baseSha = '';

  suiteSetup(async function () {
    this.timeout(90_000);
    repoRoot = workspaceRepoC();
    core = await activateGeet();
    reg = core.debugRegistry.get('phase13') as Phase13Registry;
    const p6 = core.debugRegistry.get('phase06') as {
      triEditors: TriEditorManager;
      lifecycle: { get(repoRoot: string): ConflictSession | undefined };
    };
    triEditors = p6.triEditors;
    lifecycle = p6.lifecycle;
    repo = core.repoForPath(repoRoot)!;
    assert.ok(reg && triEditors && lifecycle && repo, 'registries missing');
    branch = repo.model.snapshot.headRef!;
  });

  suiteTeardown(async function () {
    this.timeout(90_000);
    try {
      git('merge', '--abort');
    } catch {
      /* not mid-merge */
    }
    if (baseSha.length > 0) git('reset', '--hard', baseSha);
    git('clean', '-fd');
    try {
      git('branch', '-D', 'p13/t8-side');
    } catch {
      /* already gone */
    }
    await repo.refresher.refreshNow();
  });

  /** Builds the three-region conflict and leaves the repo mid-merge. */
  const startConflict = async (): Promise<void> => {
    baseSha = git('rev-parse', 'HEAD').trim();
    write(REL, BASE);
    git('add', '--', REL);
    commit('P13-T8 base');
    const forkAt = git('rev-parse', 'HEAD').trim();

    git('checkout', '-b', 'p13/t8-side');
    write(REL, THEIRS);
    git('add', '--', REL);
    commit('P13-T8 theirs');

    git('checkout', branch);
    git('reset', '--hard', forkAt);
    write(REL, OURS);
    git('add', '--', REL);
    commit('P13-T8 ours');

    try {
      git('merge', 'p13/t8-side');
      assert.fail('the merge was expected to conflict');
    } catch {
      /* the conflict is the point */
    }
    await repo.refresher.refreshNow();
    await waitFor(() => lifecycle.get(repo.root) !== undefined, 20_000);
  };

  const cleanup = async (): Promise<void> => {
    try {
      git('merge', '--abort');
    } catch {
      /* already aborted */
    }
    git('reset', '--hard', baseSha);
    git('clean', '-fd');
    try {
      git('branch', '-D', 'p13/t8-side');
    } catch {
      /* already gone */
    }
    await repo.refresher.refreshNow();
  };

  test('T8: Left and Right never take a two-sided block, and the counter is live', async function () {
    this.timeout(180_000);
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      await vscode.commands.executeCommand('geet.merge.open', {
        session,
        path: REL,
        kind: 'both-modified',
      });
      await waitFor(() => triEditors.active() !== undefined, 30_000);
      const editor = triEditors.active()!;
      assert.strictEqual(editor.blocks.length, 2, 'the fixture should produce two blocks');

      const before = countMerge(
        editor.blocks.map((t) => t.block),
        { whitespace: true },
      );
      // One interleave-resolvable block, one genuine conflict, and — the point —
      // neither is owned by a single side.
      assert.deepStrictEqual(before, { changes: 1, conflicts: 1, left: 0, right: 0 });
      assert.strictEqual(editor.statusText(), '1 change, 1 conflict.');

      // Left must decline the interleave block rather than silently take ours.
      const leftMessage = await triEditors.applyNonConflictingForTest!('left');
      assert.match(leftMessage, /No non-conflicting changes to apply/, leftMessage);
      const afterLeft = countMerge(
        editor.blocks.map((t) => t.block),
        { whitespace: true },
      );
      assert.deepStrictEqual(afterLeft, before, 'Left must not have resolved anything');
      assert.ok(leftMessage.includes(mergeStatusText(afterLeft)), leftMessage);

      // Right likewise.
      const rightMessage = await triEditors.applyNonConflictingForTest!('right');
      assert.match(rightMessage, /No non-conflicting changes to apply/, rightMessage);
      assert.deepStrictEqual(
        countMerge(
          editor.blocks.map((t) => t.block),
          { whitespace: true },
        ),
        before,
      );

      await editor.close();
    } finally {
      await cleanup();
    }
  });

  test('T8: Apply non-conflicting All also takes the two-sided rules', async function () {
    this.timeout(180_000);
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      await vscode.commands.executeCommand('geet.merge.open', {
        session,
        path: REL,
        kind: 'both-modified',
      });
      await waitFor(() => triEditors.active() !== undefined, 30_000);
      const editor = triEditors.active()!;
      const before = countMerge(
        editor.blocks.map((t) => t.block),
        { whitespace: true },
      );

      const message = await triEditors.applyNonConflictingForTest!('all');
      const after = countMerge(
        editor.blocks.map((t) => t.block),
        { whitespace: true },
      );
      // All takes the interleave block Left and Right both declined.
      assert.match(message, /Applied 1 non-conflicting change/, message);
      assert.strictEqual(after.changes, 0, 'All must leave no applicable change behind');
      assert.strictEqual(after.conflicts, before.conflicts, 'and must not touch real conflicts');
      assert.strictEqual(after.conflicts, 1);

      // The status string tracks the live state, not a cached one.
      assert.strictEqual(editor.statusText(), mergeStatusText(after));
      assert.strictEqual(editor.statusText(), 'No changes. 1 conflict.');
      await editor.close();
    } finally {
      await cleanup();
    }
  });

  test('T8: the three apply commands and Show Details are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'geet.merge.applyNonConflicting.left',
      'geet.merge.applyNonConflicting.all',
      'geet.merge.applyNonConflicting.right',
      'geet.merge.showDetails',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  test('T8: Show Details names the revision behind each pane', async function () {
    this.timeout(180_000);
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      await vscode.commands.executeCommand('geet.merge.open', {
        session,
        path: REL,
        kind: 'both-modified',
      });
      await waitFor(() => triEditors.active() !== undefined, 30_000);
      const editor = triEditors.active()!;

      const left = await editor.sideDetails('left');
      assert.match(left, /^Yours — [0-9a-f]{7} · /, left);
      assert.match(left, /P13-T8 ours/, left);

      const right = await editor.sideDetails('right');
      assert.match(right, /^Theirs — [0-9a-f]{7} · /, right);
      assert.match(right, /P13-T8 theirs/, right);

      await editor.close();
    } finally {
      await cleanup();
    }
  });

  // ---- S7 · the Files Merged with Conflicts gate ---------------------------

  test('T8: the conflicts gate lists the session, and is suppressed under the harness', async function () {
    this.timeout(180_000);
    // The auto-open is off during integration runs — a webview panel opening by
    // itself takes editor focus and breaks every editor-based assertion in a
    // suite that creates conflict sessions. The halves below are what the gate
    // actually does, and they are exercised directly.
    assert.strictEqual(reg.conflictsDialogEnabled(), false, 'auto-open must be off in tests');
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      const params = reg.buildConflictsParams(session);
      assert.strictEqual(params.operation, 'merge');
      assert.ok(
        params.files.some((f) => f.path === REL && f.mergeable),
        `the conflicted file should be listed as mergeable: ${JSON.stringify(params.files)}`,
      );
    } finally {
      await cleanup();
    }
  });

  test('T8: the gate’s Accept Theirs matches what the tree view would do', async function () {
    this.timeout(180_000);
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      const message = await reg.applyConflictsResult(session, {
        action: 'acceptTheirs',
        paths: [REL],
      });
      assert.match(message, /Accepted their version/, message);
      await repo.refresher.refreshNow();
      // Their content is on disk and the file is no longer unmerged — exactly
      // what `geet.merge.acceptTheirsFile` does from the tree.
      assert.strictEqual(fs.readFileSync(path.join(repoRoot, REL), 'utf8'), THEIRS);
      await waitFor(
        () => !repo.model.snapshot.statusEntries.some((e) => e.kind === 'unmerged'),
        20_000,
      );
    } finally {
      await cleanup();
    }
  });

  test('T8: the gate refuses to act on files it was not given', async function () {
    this.timeout(180_000);
    await startConflict();
    try {
      const session = lifecycle.get(repo.root)!;
      const message = await reg.applyConflictsResult(session, {
        action: 'acceptYours',
        paths: ['not/a/conflicted/file.txt'],
      });
      assert.match(message, /No files selected/, message);
      // Still conflicted — nothing was resolved behind the user's back.
      assert.ok(repo.model.snapshot.statusEntries.some((e) => e.kind === 'unmerged'));
    } finally {
      await cleanup();
    }
  });
});
