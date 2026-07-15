import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { OperationQueue } from '../../../src/core/ops/operationQueue';
import type { SnapshotStore } from '../../../src/localHistory/snapshotStore';
import type { ConflictSession } from '../../../src/merge/conflictSession';
import { ShelfStore } from '../../../src/shelf/shelfStore';
import type { ShelfNode, ShelfViewProvider } from '../../../src/shelf/shelfView';
import type { StashService } from '../../../src/stash/stashService';
import type { StashNode, StashViewProvider } from '../../../src/stash/stashView';
import { activateGitTree, gitWithRetry, waitFor, workspaceRepoB } from '../setup';

interface Phase07RegistryShape {
  getStashService(repoRoot: string): StashService | undefined;
  getShelfStore(repoRoot: string): ShelfStore | undefined;
  stashViewProvider: StashViewProvider;
}
interface Phase06RegistryShape {
  getSession(repoRoot: string): ConflictSession | undefined;
}
interface Phase09RegistryShape {
  getStore(repoRoot: string): SnapshotStore | undefined;
}
interface Phase07ShelfUiShape {
  getShelfStore(repoRoot: string): ShelfStore | undefined;
  shelfViewProvider: ShelfViewProvider;
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
    // 10 ms poll: the default 25 ms step quantizes the measurement upward
    // (a 501 ms flake at full-suite load was pure poll granularity).
    git('stash', 'push', '--include-untracked', '-m', 'p7 external');
    const start = Date.now();
    await waitFor(() => stash.list().some((s) => s.message.includes('p7 external')), 5_000, 10);
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

/** Removes a directory whose files may carry the readonly bit (.git objects). */
function rmrfHard(dir: string): void {
  const clearReadonly = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) clearReadonly(full);
      else fs.chmodSync(full, 0o666);
    }
  };
  clearReadonly(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** P7-T3 acceptance on workspace repoB + an ephemeral throwaway repo. */
suite('P7 stash & shelve — ShelfStore', () => {
  let core: Core;
  let repoRoot: string;
  let repo: RepoHandle;
  let shelf: ShelfStore;
  let reg09: Phase09RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string | Buffer): void => fs.writeFileSync(abs(rel), content);
  const commitAll = (subject: string): void => {
    git('add', '-A');
    git('commit', '-m', subject);
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoB())!;
    assert.ok(repo, 'repoB not discovered');
    repoRoot = repo.root;
    const reg07 = core.debugRegistry.get('phase07') as Phase07RegistryShape;
    shelf = reg07.getShelfStore(repoRoot)!;
    assert.ok(shelf, 'shelf store missing');
    reg09 = core.debugRegistry.get('phase09') as Phase09RegistryShape;
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    for (const m of shelf.list()) shelf.delete(m.id);
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

  test('T3: shelve(remove) of modified/added/deleted/binary/CRLF-untracked cleans the worktree; the patch restores byte-identical', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/shelf');
    write('s7m.txt', 'before\n');
    write('s7d.txt', 'doomed\n');
    write('s7b.bin', Buffer.from([0x00, 0x01, 0x02]));
    commitAll('p7 shelf base');

    // Dirty in all five flavors the acceptance names.
    write('s7m.txt', 'after edit\n');
    fs.rmSync(abs('s7d.txt'));
    const binBytes = Buffer.from([0xff, 0x00, 0x42, 0x0d, 0x0a]);
    write('s7b.bin', binBytes);
    write('s7a.txt', 'staged new\n');
    git('add', '--', 's7a.txt');
    const crlf = 'untracked\r\nCRLF file\r\n';
    write('s7u.txt', crlf);
    await repo.refresher.refreshNow(); // the P9 snapshot collects dirty files from the model

    const res = await shelf.shelve({
      name: 'p7 shelve test',
      comment: 'from the T3 acceptance',
      removeFromWorktree: true,
    });
    assert.strictEqual(res.removed, true, `removal skipped: ${res.removalSkippedReason ?? ''}`);
    assert.strictEqual(git('status', '--porcelain').trim(), '', 'worktree clean after shelve(remove)');
    assert.strictEqual(fs.readFileSync(abs('s7m.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.readFileSync(abs('s7d.txt'), 'utf8'), 'doomed\n', 'deletion reverted');
    assert.deepStrictEqual([...fs.readFileSync(abs('s7b.bin'))], [0x00, 0x01, 0x02]);
    assert.ok(!fs.existsSync(abs('s7a.txt')), 'staged add removed');
    assert.ok(!fs.existsSync(abs('s7u.txt')), 'untracked file removed');

    // Metadata: file table, base, branch, embedded untracked marker.
    const meta = res.meta;
    const byPath = new Map(meta.files.map((f) => [f.relPath, f]));
    assert.strictEqual(byPath.get('s7m.txt')?.status, 'modified');
    assert.strictEqual(byPath.get('s7d.txt')?.status, 'deleted');
    assert.strictEqual(byPath.get('s7a.txt')?.status, 'added');
    assert.strictEqual(byPath.get('s7u.txt')?.status, 'untracked');
    assert.strictEqual(byPath.get('s7b.bin')?.status, 'modified');
    assert.strictEqual(byPath.get('s7b.bin')?.isBinary, true, 'binary flagged');
    assert.strictEqual(byPath.get('s7m.txt')?.isBinary, false);
    assert.strictEqual(meta.untrackedSnapshots, 'embedded');
    assert.strictEqual(meta.baseSha, git('rev-parse', 'HEAD').trim());
    assert.strictEqual(meta.branch, 'p7/shelf');

    // Storage lives entirely outside the repository (and therefore .git).
    const patchFile = shelf.patchPath(meta.id);
    assert.ok(!patchFile.startsWith(repoRoot), `patch inside the repo: ${patchFile}`);
    assert.ok(fs.existsSync(patchFile), 'changes.patch on disk');
    assert.ok(fs.existsSync(path.join(shelf.entryDir(meta.id), 'meta.json')), 'meta.json on disk');
    assert.ok(shelf.verify(meta.id), 'sha256 integrity holds');

    // The destructive leg was gated behind a P9 snapshot.
    const labels = (reg09.getStore(repoRoot)?.list() ?? []).map((m) => m.label);
    assert.ok(labels.includes('Before: shelve (remove)'), `P9 labels: ${labels.join(', ')}`);

    // The stored patch restores every byte (T5 builds its engine on this).
    git('apply', '--index', patchFile);
    assert.strictEqual(fs.readFileSync(abs('s7m.txt'), 'utf8'), 'after edit\n');
    assert.deepStrictEqual([...fs.readFileSync(abs('s7b.bin'))], [...binBytes], 'binary byte-identical');
    assert.strictEqual(fs.readFileSync(abs('s7a.txt'), 'utf8'), 'staged new\n');
    assert.strictEqual(fs.readFileSync(abs('s7u.txt'), 'utf8'), crlf, 'CRLF byte-identical');
    assert.ok(!fs.existsSync(abs('s7d.txt')), 'deletion re-applied');
    shelf.delete(meta.id);
  });

  test('T3: shelve without remove leaves worktree and index untouched; corruption is detected before use', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/shelfkeep');
    write('s7k.txt', 'base\n');
    commitAll('p7 keep base');
    write('s7k.txt', 'keep me dirty\n');
    write('s7ku.txt', 'untracked stays\r\n');
    const statusBefore = git('status', '--porcelain');

    const res = await shelf.shelve({ name: 'keep worktree' });
    assert.strictEqual(res.removed, false);
    assert.strictEqual(
      git('status', '--porcelain'),
      statusBefore,
      'worktree/index untouched — the add -N dance fully reverted',
    );
    assert.ok(shelf.verify(res.meta.id));

    // Flip one byte in the stored patch: entry still lists, use is refused.
    const patchFile = shelf.patchPath(res.meta.id);
    const bytes = fs.readFileSync(patchFile);
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] as number) ^ 0xff;
    fs.writeFileSync(patchFile, bytes);
    assert.ok(
      shelf.list().some((m) => m.id === res.meta.id),
      'corrupted entry still listed',
    );
    assert.strictEqual(shelf.verify(res.meta.id), false);
    // Name check, not instanceof: the store instance comes from the extension
    // bundle while the test compiles against out/src — two class identities.
    assert.throws(
      () => shelf.readPatch(res.meta.id),
      (err: unknown) => err instanceof Error && err.name === 'ShelfIntegrityError',
      'readPatch must refuse a tampered patch',
    );
    shelf.delete(res.meta.id);
  });

  test('T3: shelf survives rm -rf .git + re-init — still lists and unshelves', async function () {
    this.timeout(90_000);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p7t3-repo-'));
    const shelfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-p7t3-shelf-'));
    const tgit = (...args: string[]): string => gitWithRetry(tmp, args);
    const configure = (): void => {
      tgit('config', 'user.name', 'P7 T3');
      tgit('config', 'user.email', 'p7t3@gittree.test');
      tgit('config', 'commit.gpgsign', 'false');
      tgit('config', 'core.autocrlf', 'false');
    };
    try {
      tgit('init');
      configure();
      fs.writeFileSync(path.join(tmp, 'base.txt'), 'base\n');
      tgit('add', '-A');
      tgit('commit', '-m', 'base');
      fs.writeFileSync(path.join(tmp, 'base.txt'), 'shelved change\n');
      fs.writeFileSync(path.join(tmp, 'u.txt'), 'u one\r\nu two\r\n');

      const store = new ShelfStore({ storeDir: shelfDir, repoRoot: tmp, queue: new OperationQueue(tmp, core.git) });
      const res = await store.shelve({ name: 'survivor', removeFromWorktree: true });
      assert.strictEqual(res.removed, true);
      assert.strictEqual(tgit('status', '--porcelain').trim(), '', 'worktree clean');

      // Destroy the repository outright — the spec's survival scenario.
      rmrfHard(path.join(tmp, '.git'));
      assert.ok(!fs.existsSync(path.join(tmp, '.git')));

      // Listing needs no git at all: a fresh store over the same dir works.
      const reborn = new ShelfStore({ storeDir: shelfDir, repoRoot: tmp, queue: new OperationQueue(tmp, core.git) });
      const listed = reborn.list();
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]!.name, 'survivor');
      assert.strictEqual(listed[0]!.files.length, 2);

      // Re-init and unshelve into the reborn repository.
      tgit('init');
      configure();
      tgit('add', '-A');
      tgit('commit', '-m', 'reborn');
      assert.ok(reborn.readPatch(listed[0]!.id).length > 0, 'integrity-checked read');
      tgit('apply', '--index', reborn.patchPath(listed[0]!.id));
      assert.strictEqual(fs.readFileSync(path.join(tmp, 'base.txt'), 'utf8'), 'shelved change\n');
      assert.strictEqual(fs.readFileSync(path.join(tmp, 'u.txt'), 'utf8'), 'u one\r\nu two\r\n');
    } finally {
      try {
        rmrfHard(tmp);
        fs.rmSync(shelfDir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // temp dirs — the OS reclaims them eventually
      }
    }
  });
});

/** P7-T4 acceptance: shelf view, per-file diff reconstruction, patch edit. */
suite('P7 stash & shelve — Shelf UI', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let shelf: ShelfStore;
  let ui: Phase07ShelfUiShape;

  const git = (...args: string[]): string => gitWithRetry(repoRoot, args);
  const abs = (rel: string): string => path.join(repoRoot, rel);
  const write = (rel: string, content: string | Buffer): void => fs.writeFileSync(abs(rel), content);
  const commitAll = (subject: string): void => {
    git('add', '-A');
    git('commit', '-m', subject);
  };

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGitTree();
    repo = core.repoForPath(workspaceRepoB())!;
    repoRoot = repo.root;
    ui = core.debugRegistry.get('phase07') as Phase07ShelfUiShape;
    shelf = ui.getShelfStore(repoRoot)!;
    assert.ok(ui.shelfViewProvider, 'shelf view provider missing');
    git('checkout', '-f', 'main');
  });

  teardown(async function () {
    this.timeout(30_000);
    for (const m of shelf.list()) shelf.delete(m.id);
    try {
      git('checkout', '-f', 'main');
      git('clean', '-fd');
    } catch {
      // best effort
    }
    for (const b of git('branch', '--list', 'p7/*', '--format=%(refname:short)')
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)) {
      try {
        git('branch', '-D', b);
      } catch {
        // best effort
      }
    }
    await repo.refresher.refreshNow();
  });

  test('T4: entry rows render; per-file diffs reconstruct modified/added/deleted content in memory', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/shelfui');
    write('u7m.txt', 'alpha\nbeta\ngamma\n');
    write('u7d.txt', 'bye\n');
    commitAll('p7 ui base');
    write('u7m.txt', 'alpha\nBETA\ngamma\n');
    fs.rmSync(abs('u7d.txt'));
    write('u7a.txt', 'fresh\r\nuntracked\r\n');
    await repo.refresher.refreshNow();

    const res = await shelf.shelve({ name: 'ui entry', removeFromWorktree: true });
    assert.strictEqual(res.removed, true);

    const roots = ui.shelfViewProvider.getChildren();
    const entry = roots.find((n) => n.kind === 'entry' && n.meta.name === 'ui entry') as Extract<
      ShelfNode,
      { kind: 'entry' }
    >;
    assert.ok(entry, 'entry row rendered');
    const entryItem = ui.shelfViewProvider.getTreeItem(entry);
    assert.strictEqual(entryItem.contextValue, 'shelf:entry');
    assert.match(String(entryItem.description), /3 file\(s\).*from p7\/shelfui/u);

    // Every file child carries a vscode.diff whose sides resolve to the
    // exact base and reconstructed contents — worktree untouched throughout.
    const expected: Record<string, { left: string; right: string }> = {
      'u7m.txt': { left: 'alpha\nbeta\ngamma\n', right: 'alpha\nBETA\ngamma\n' },
      'u7d.txt': { left: 'bye\n', right: '' },
      'u7a.txt': { left: '', right: 'fresh\r\nuntracked\r\n' },
    };
    const children = ui.shelfViewProvider.getChildren(entry);
    assert.strictEqual(children.length, 3);
    for (const child of children) {
      assert.ok(child.kind === 'file');
      const item = ui.shelfViewProvider.getTreeItem(child);
      assert.strictEqual(item.command?.command, 'vscode.diff', child.file.relPath);
      const [left, right] = item.command.arguments as [vscode.Uri, vscode.Uri, string];
      const want = expected[child.file.relPath]!;
      const leftDoc = await vscode.workspace.openTextDocument(left);
      const rightDoc = await vscode.workspace.openTextDocument(right);
      assert.strictEqual(leftDoc.getText(), want.left, `${child.file.relPath} base side`);
      assert.strictEqual(rightDoc.getText(), want.right, `${child.file.relPath} shelved side`);
    }
    // One real diff tab opens end-to-end.
    const first = ui.shelfViewProvider.getTreeItem(children[0]!);
    await vscode.commands.executeCommand(
      'vscode.diff',
      ...(first.command!.arguments as [vscode.Uri, vscode.Uri, string]),
    );
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'diff tab opened');
    await vscode.window.tabGroups.close(tab);

    // Palette surface: every T4 verb registered.
    const all = await vscode.commands.getCommands(true);
    for (const verb of ['shelve', 'rename', 'delete', 'export', 'import', 'showPatch']) {
      assert.ok(all.includes(`gittree.shelf.${verb}`), `gittree.shelf.${verb} registered`);
    }
    shelf.delete(res.meta.id);
  });

  test('T4: a hand-edited hunk that still applies unshelves with the edit; a broken edit is blocked', async function () {
    this.timeout(90_000);
    git('checkout', '-b', 'p7/shelfedit');
    write('e7.txt', 'one\ntwo\nthree\n');
    commitAll('p7 edit base');
    write('e7.txt', 'one\nTWO\nthree\n');
    await repo.refresher.refreshNow();
    const res = await shelf.shelve({ name: 'editable', removeFromWorktree: true });
    assert.strictEqual(res.removed, true);
    const patchFile = shelf.patchPath(res.meta.id);

    // Valid edit: change only the added line's payload — context intact.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(patchFile));
    const editValid = new vscode.WorkspaceEdit();
    const text = doc.getText();
    const at = doc.positionAt(text.indexOf('+TWO'));
    editValid.replace(doc.uri, new vscode.Range(at, at.translate(0, 4)), '+TWO-EDITED');
    assert.ok(await vscode.workspace.applyEdit(editValid));
    assert.ok(await doc.save());
    // The save watcher revalidates against the base tree and re-consecrates.
    await waitFor(() => shelf.verify(res.meta.id), 15_000);

    git('apply', '--index', patchFile);
    assert.strictEqual(
      fs.readFileSync(abs('e7.txt'), 'utf8'),
      'one\nTWO-EDITED\nthree\n',
      'edited hunk unshelved with the edit',
    );
    git('checkout', '-f', 'p7/shelfedit');
    git('clean', '-fd');

    // Broken edit: corrupt a context line — apply --check must fail and the
    // entry must NOT be re-consecrated (sha mismatch keeps use blocked).
    const doc2 = await vscode.workspace.openTextDocument(vscode.Uri.file(patchFile));
    const text2 = doc2.getText();
    const brk = new vscode.WorkspaceEdit();
    const ctx = doc2.positionAt(text2.indexOf(' three'));
    brk.replace(doc2.uri, new vscode.Range(ctx, ctx.translate(0, 6)), ' MISMATCH');
    assert.ok(await vscode.workspace.applyEdit(brk));
    assert.ok(await doc2.save());
    await new Promise((r) => setTimeout(r, 2500)); // give the watcher its chance
    assert.strictEqual(shelf.verify(res.meta.id), false, 'broken edit must stay unconsecrated');
    assert.throws(
      () => shelf.readPatch(res.meta.id),
      (err: unknown) => err instanceof Error && err.name === 'ShelfIntegrityError',
      'unshelve/edit paths refuse the broken patch',
    );
    shelf.delete(res.meta.id);
  });
});
