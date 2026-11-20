import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { RepoHandle } from '../../../src/core/core';
import { activateGeet, gitWithRetry, waitFor, workspaceRepoC } from '../setup';

/**
 * POST-P14ck in the real extension: a ticked `[id].tsx` is committed alone,
 * and rolled back alone, beside a changed `i.tsx` and `d.tsx` — the names git
 * also matched `[id].tsx` to when it read the path as a pattern. Through the
 * commands a user runs, on repoC in the changelists paradigm it starts in.
 *
 * The suite leaves repoC as it found it: HEAD goes back (soft, so whatever
 * was staged before stays staged), its files leave the index and the disk,
 * and its changelist is removed.
 */
suite('POST-P14ck a path that looks like a pattern', () => {
  const DIR = 'p14ck';
  const ID = `${DIR}/[id].tsx`;
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase03Registry;
  let before: string;
  let listId: string | undefined;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), content);
  };
  const changedIn = (dir: string): string[] =>
    git('diff', '--name-only', '--', dir)
      .split('\n')
      .filter((l) => l.length > 0)
      .sort();

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGeet();
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoC not discovered');
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg, 'phase03 registry missing');
    before = git('rev-parse', 'HEAD').trim();
    // The base is the suite's own commit, of its own folder alone.
    write(ID, 'one\n');
    write(`${DIR}/i.tsx`, 'one\n');
    write(`${DIR}/d.tsx`, 'one\n');
    git('add', '--', DIR);
    git('commit', '-q', '-m', 'p14ck base', '--', DIR);
    await repo.refresher.refreshNow();
  });

  suiteTeardown(async function () {
    this.timeout(60_000);
    // Every step runs, whatever an earlier one did: a step skipped here leaves
    // repoC dirty for every suite after this one.
    const errors: unknown[] = [];
    const step = (run: () => void): void => {
      try {
        run();
      } catch (err) {
        errors.push(err);
      }
    };
    step(() => {
      if (listId !== undefined && reg.changelistsFor(repo).getList(listId) !== undefined) {
        reg.changelistsFor(repo).remove(listId);
      }
    });
    step(() => git('reset', '-q', '--soft', before));
    // Out of the index again. Not `git rm --cached`: it refuses a file whose
    // staged content differs from both HEAD and the disk, which is what is
    // left here (`i.tsx` changed after the commit that is now undone).
    step(() => git('reset', '-q', '--', DIR));
    step(() => fs.rmSync(abs(DIR), { recursive: true, force: true }));
    await repo.refresher.refreshNow();
    if (errors.length > 0) throw errors[0];
  });

  test('a changelist commit of a ticked [id].tsx commits that file alone', async function () {
    this.timeout(60_000);
    write(ID, 'one\ntwo\n');
    write(`${DIR}/i.tsx`, 'one\ntwo\n');
    write(`${DIR}/d.tsx`, 'one\ntwo\n');
    await repo.refresher.refreshNow();
    const service = reg.changelistsFor(repo);
    await waitFor(() => service.getLists().some((l) => l.files.includes(ID)), 15_000);

    // A list of its own, so nothing else repoC holds can join the commit.
    const list = service.create('P14ck', '', false);
    listId = list.id;
    service.moveFiles([ID], list.id);
    service.setChecked([ID], true);
    reg.messageBoxFor(repo).value = 'p14ck ticked';
    process.env['GITTREE_TEST_CHECKS_CHOICE'] = 'anyway';
    try {
      await vscode.commands.executeCommand('gittree.changelist.commitList', { repoRoot: repo.root, listId: list.id });
    } finally {
      delete process.env['GITTREE_TEST_CHECKS_CHOICE'];
    }
    await waitFor(() => git('log', '-1', '--format=%s').trim() === 'p14ck ticked', 15_000);

    assert.deepStrictEqual(git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), [ID]);
    assert.deepStrictEqual(changedIn(DIR), [`${DIR}/d.tsx`, `${DIR}/i.tsx`]);
  });

  test("Rollback of [id].tsx keeps i.tsx's and d.tsx's changes", async function () {
    this.timeout(60_000);
    write(ID, 'one\ntwo\nthree\n');
    await repo.refresher.refreshNow();
    await waitFor(() => repo.model.snapshot.statusEntries.some((e) => e.path === ID), 15_000);

    // The modal confirms itself in the test host (GITTREE_TEST_AUTOCONFIRM).
    await vscode.commands.executeCommand('gittree.rollbackFile', { repoRoot: repo.root, relPath: ID });
    await waitFor(() => fs.readFileSync(abs(ID), 'utf8') === 'one\ntwo\n', 15_000);

    assert.strictEqual(fs.readFileSync(abs(`${DIR}/i.tsx`), 'utf8'), 'one\ntwo\n');
    assert.strictEqual(fs.readFileSync(abs(`${DIR}/d.tsx`), 'utf8'), 'one\ntwo\n');
    assert.deepStrictEqual(changedIn(DIR), [`${DIR}/d.tsx`, `${DIR}/i.tsx`]);
  });
});
