/**
 * Phase 7 registration (T1 service + T2 stashes view/commands + T3 shelf
 * store; T4/T5 add the shelf view and unshelve engine).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangelistNode } from '../commit/changelists/changelistsView';
import type { Core, RepoHandle } from '../core/core';
import { splitPatchFiles } from '../core/patch/patchParser';
import { canonicalKey } from '../core/repoDiscovery';
import { repoStoreKey } from '../localHistory/snapshotStore';
import { confirmModal, typedConfirm } from '../ui/confirm';
import type { ConflictSource } from '../merge/conflictSession';
import { ShelfStore, type ShelfMeta, type ShelveOptions } from '../shelf/shelfStore';
import { SHELF_SCHEME, ShelfContentProvider, ShelfViewProvider, type ShelfNode } from '../shelf/shelfView';
import { StashService, type StashPushOptions } from './stashService';
import { relativeTime, stashDiffSides, StashViewProvider, type StashNode } from './stashView';

/**
 * P7-T3: shelf root — `gittree.shelf.path` when set AND write-probe passes,
 * else `<globalStorage>/shelf`. Both live outside `.git` and the workspace,
 * so shelves survive repo deletion. Read once per repo attach; changing the
 * setting applies to repos attached afterwards (reload for existing ones).
 */
function shelfRootDir(context: vscode.ExtensionContext): string {
  const override = vscode.workspace.getConfiguration('gittree.shelf').get<string>('path', '').trim();
  if (override.length > 0) {
    try {
      fs.mkdirSync(override, { recursive: true });
      const probe = path.join(override, `.gittree-write-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.rmSync(probe, { force: true });
      return override;
    } catch {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'The configured shelf location "{0}" is not writable — using the default location instead.',
          override,
        ),
      );
    }
  }
  return path.join(context.globalStorageUri.fsPath, 'shelf');
}

interface Phase06LifecycleShape {
  lifecycle: { expectConflict(repoRoot: string, source: ConflictSource): void };
}

export function registerPhase07StashShelve(context: vscode.ExtensionContext, core: Core): void {
  const services = new Map<string, StashService>();
  const expectConflict = (repoRoot: string, source: ConflictSource): void => {
    const p6 = core.debugRegistry.get('phase06') as Phase06LifecycleShape | undefined;
    p6?.lifecycle.expectConflict(repoRoot, source);
  };

  const viewProvider = new StashViewProvider();
  const view = vscode.window.createTreeView('gittree.stashes', { treeDataProvider: viewProvider });
  context.subscriptions.push(view);
  const pushRepos = (): void => {
    viewProvider.setRepos(
      core.repos.map((repo) => ({ repo, service: services.get(canonicalKey(repo.root))! })),
    );
  };
  // ---- P7-T3: one ShelfStore per repo, outside .git and the workspace ----
  const shelves = new Map<string, ShelfStore>();
  const trace = (l: string): void => core.output.appendLine(`[shelf] ${l}`);

  const attach = (repo: RepoHandle): void => {
    const service = new StashService(repo, expectConflict);
    services.set(canonicalKey(repo.root), service);
    repo.disposables.add(service.onDidChange(() => viewProvider.refresh()));
    const shelf = new ShelfStore({
      storeDir: path.join(shelfRootDir(context), repoStoreKey(canonicalKey(repo.root))),
      repoRoot: repo.root,
      queue: repo.queue,
      progressLabel: (name) => vscode.l10n.t('Shelve: {0}', name),
      trace,
    });
    shelves.set(canonicalKey(repo.root), shelf);
    repo.disposables.add(shelf);
    pushRepos();
  };
  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  // ---- commands (rows pass a StashNode; the palette picks via QuickPick) ----
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  /** Resolve the acted-on stash: tree node, else QuickPick across repos. */
  const pickStash = async (
    arg: unknown,
  ): Promise<{ repo: RepoHandle; service: StashService; index: number; message: string } | undefined> => {
    const node = arg as StashNode | undefined;
    if (node && typeof node === 'object' && 'kind' in node && node.kind === 'stash') {
      return {
        repo: node.repo,
        service: node.service,
        index: node.info.index,
        message: node.info.message,
      };
    }
    interface Choice extends vscode.QuickPickItem {
      repo: RepoHandle;
      service: StashService;
      index: number;
      message: string;
    }
    const choices: Choice[] = [];
    for (const repo of core.repos) {
      const service = services.get(canonicalKey(repo.root))!;
      for (const info of service.list()) {
        choices.push({
          label: `${info.selector} · ${info.message}`,
          description: relativeTime(info.time),
          repo,
          service,
          index: info.index,
          message: info.message,
        });
      }
    }
    if (choices.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no stashes.'));
      return undefined;
    }
    const seeded = process.env['GITTREE_TEST_STASH_PICK'];
    if (seeded !== undefined) return choices[Number.parseInt(seeded, 10)];
    return vscode.window.showQuickPick(choices, { placeHolder: vscode.l10n.t('Select a stash') });
  };

  const repoForNew = (): RepoHandle | undefined => {
    const repo =
      core.repos.length === 1
        ? core.repos[0]
        : core.repoForUri(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file('')) ??
          core.repos[0];
    if (!repo) void vscode.window.showInformationMessage(vscode.l10n.t('No git repository.'));
    return repo;
  };

  /** View-title `+`: message → option toggles → optional file subset. */
  register('gittree.stash.push', async () => {
    const repo = repoForNew();
    if (!repo) return;
    const service = services.get(canonicalKey(repo.root))!;
    const includeUntrackedDefault = vscode.workspace
      .getConfiguration('gittree.stash')
      .get<boolean>('includeUntrackedDefault', true);

    const seeded = process.env['GITTREE_TEST_STASH_PUSH'];
    if (seeded !== undefined) {
      await service.push(JSON.parse(seeded) as StashPushOptions);
      return;
    }

    const message = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Stash message (optional)'),
      placeHolder: vscode.l10n.t('WIP on {0}', repo.model.snapshot.headRef ?? 'HEAD'),
    });
    if (message === undefined) return; // cancelled
    interface Opt extends vscode.QuickPickItem {
      id: 'untracked' | 'staged' | 'subset';
    }
    const opts: Opt[] = [
      {
        id: 'untracked',
        label: vscode.l10n.t('Include untracked files'),
        picked: includeUntrackedDefault,
      },
      { id: 'staged', label: vscode.l10n.t('Only staged changes (git ≥ 2.35)') },
      { id: 'subset', label: vscode.l10n.t('Choose files…') },
    ];
    const chosen = await vscode.window.showQuickPick(opts, {
      canPickMany: true,
      placeHolder: vscode.l10n.t('Stash options'),
    });
    if (chosen === undefined) return;
    const has = (id: Opt['id']): boolean => chosen.some((c) => c.id === id);
    let paths: string[] | undefined;
    if (has('subset')) {
      const dirty = repo.model.snapshot.statusEntries.map((e) => e.path);
      const pickedFiles = await vscode.window.showQuickPick(dirty, {
        canPickMany: true,
        placeHolder: vscode.l10n.t('Files to stash'),
      });
      if (pickedFiles === undefined || pickedFiles.length === 0) return;
      paths = pickedFiles;
    }
    const push: StashPushOptions = {
      includeUntracked: has('untracked'),
      staged: has('staged'),
    };
    if (message.length > 0) push.message = message;
    if (paths) push.paths = paths;
    await service.push(push);
  });

  register('gittree.stash.apply', async (arg) => {
    const t = await pickStash(arg);
    if (t) await t.service.apply(t.index, { restoreIndex: true });
  });
  register('gittree.stash.pop', async (arg) => {
    const t = await pickStash(arg);
    if (t) await t.service.pop(t.index, { restoreIndex: true });
  });
  register('gittree.stash.drop', async (arg) => {
    const t = await pickStash(arg);
    if (!t) return;
    const age = relativeTime(t.service.list().find((s) => s.index === t.index)?.time ?? 0);
    const ok = await confirmModal(
      vscode.l10n.t('Drop stash "{0}"?', t.message),
      vscode.l10n.t('Created {0}. This cannot be undone by git (Local History keeps a snapshot).', age),
      vscode.l10n.t('Drop'),
    );
    if (ok) await t.service.drop(t.index);
  });
  register('gittree.stash.branch', async (arg) => {
    const t = await pickStash(arg);
    if (!t) return;
    const seeded = process.env['GITTREE_TEST_STASH_BRANCH'];
    const name =
      seeded ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New branch from stash'),
        validateInput: (v) => (v.trim().length === 0 ? vscode.l10n.t('Branch name required') : undefined),
      }));
    if (name !== undefined && name.trim().length > 0) await t.service.branch(name.trim(), t.index);
  });
  register('gittree.stash.clear', async () => {
    const repo = repoForNew();
    if (!repo) return;
    const service = services.get(canonicalKey(repo.root))!;
    const n = service.list().length;
    if (n === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no stashes.'));
      return;
    }
    const ok = await typedConfirm(
      vscode.l10n.t('Delete ALL {0} stash entries? This cannot be undone by git.', n),
      'CLEAR',
    );
    if (ok) await service.clear();
  });
  register('gittree.stash.copyMessage', async (arg) => {
    const t = await pickStash(arg);
    if (t) await vscode.env.clipboard.writeText(t.message);
  });
  /** "Compare all vs working tree" — one multi-diff for the whole stash. */
  register('gittree.stash.diffAll', async (arg) => {
    const t = await pickStash(arg);
    if (!t) return;
    const files = await t.service.getStashFiles(t.index);
    const resources = files.map((file) => {
      const sides = stashDiffSides(t.repo, file);
      return [vscode.Uri.file(`${t.repo.root}/${file.path}`), sides.left, sides.right] as [
        vscode.Uri,
        vscode.Uri,
        vscode.Uri,
      ];
    });
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('Stash {0} vs Working Tree', `stash@{${t.index}}`),
      resources,
    );
  });

  // ---- P7-T4: shelf view, per-file diffs, patch edit/import/export --------
  const shelfViewProvider = new ShelfViewProvider();
  const shelfView = vscode.window.createTreeView('gittree.shelf', {
    treeDataProvider: shelfViewProvider,
  });
  context.subscriptions.push(shelfView);
  const shelfContent = new ShelfContentProvider(
    (repoRoot) => shelves.get(canonicalKey(repoRoot)),
    (repoRoot) => core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot)),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SHELF_SCHEME, shelfContent),
  );
  const pushShelves = (): void => {
    shelfViewProvider.setRepos(
      core.repos.map((repo) => ({ repo, store: shelves.get(canonicalKey(repo.root))! })),
    );
  };
  for (const repo of core.repos) {
    repo.disposables.add(shelves.get(canonicalKey(repo.root))!.onDidChange(() => pushShelves()));
  }
  const shelfAddSub = core.onDidAddRepo((repo) => {
    repo.disposables.add(shelves.get(canonicalKey(repo.root))!.onDidChange(() => pushShelves()));
    pushShelves();
  });
  context.subscriptions.push(new vscode.Disposable(() => shelfAddSub.dispose()));
  pushShelves();

  /** Resolve the acted-on shelf entry: tree node, else QuickPick. */
  const pickShelf = async (
    arg: unknown,
  ): Promise<{ repo: RepoHandle; store: ShelfStore; meta: ShelfMeta } | undefined> => {
    const node = arg as ShelfNode | undefined;
    if (node && typeof node === 'object' && 'kind' in node && node.kind === 'entry') {
      return { repo: node.repo, store: node.store, meta: node.meta };
    }
    interface Choice extends vscode.QuickPickItem {
      repo: RepoHandle;
      store: ShelfStore;
      meta: ShelfMeta;
    }
    const choices: Choice[] = [];
    for (const repo of core.repos) {
      const store = shelves.get(canonicalKey(repo.root))!;
      for (const meta of store.list()) {
        choices.push({
          label: meta.name,
          description: `${relativeTime(Math.floor(meta.createdAt / 1000))} · ${meta.files.length}`,
          repo,
          store,
          meta,
        });
      }
    }
    if (choices.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no shelved changes.'));
      return undefined;
    }
    const seeded = process.env['GITTREE_TEST_SHELF_PICK'];
    if (seeded !== undefined) return choices[Number.parseInt(seeded, 10)];
    return vscode.window.showQuickPick(choices, {
      placeHolder: vscode.l10n.t('Select a shelved change'),
    });
  };

  /** Shelve flow — view `+`, changelist context and palette all land here. */
  register('gittree.shelf.shelve', async (arg) => {
    const node = arg as ChangelistNode | undefined;
    const fromList = node && typeof node === 'object' && 'kind' in node && node.kind === 'list';
    const repo = fromList ? node.repo : repoForNew();
    if (!repo) return;
    const store = shelves.get(canonicalKey(repo.root))!;
    const listPaths = fromList && node.list.files.length > 0 ? node.list.files : undefined;

    const seeded = process.env['GITTREE_TEST_SHELVE'];
    if (seeded !== undefined) {
      const opts = JSON.parse(seeded) as ShelveOptions;
      await store.shelve(fromList ? { paths: listPaths, ...opts } : opts);
      return;
    }
    // IntelliJ default name: the changelist name, else the SCM input draft.
    const p1 = core.debugRegistry.get('phase01') as
      | { sourceControls: Map<string, { sc: vscode.SourceControl }> }
      | undefined;
    const draft = p1?.sourceControls.get(canonicalKey(repo.root))?.sc.inputBox.value.trim();
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Shelf name'),
      value: fromList ? node.list.name : draft && draft.length > 0 ? draft.split('\n')[0] : '',
      validateInput: (v) => (v.trim().length === 0 ? vscode.l10n.t('Name required') : undefined),
    });
    if (name === undefined || name.trim().length === 0) return;
    const remove = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t('Shelve and remove from worktree'), remove: true },
        { label: vscode.l10n.t('Shelve and keep changes'), remove: false },
      ],
      { placeHolder: vscode.l10n.t('IntelliJ shelves remove the changes by default') },
    );
    if (remove === undefined) return;
    const opts: ShelveOptions = { name: name.trim(), removeFromWorktree: remove.remove };
    if (listPaths) opts.paths = listPaths;
    const res = await store.shelve(opts);
    if (res.removalSkippedReason !== undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Shelved, but the changes stay in the worktree: the patch failed its re-apply check ({0}).',
          res.removalSkippedReason,
        ),
      );
    }
  });

  register('gittree.shelf.rename', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    const seeded = process.env['GITTREE_TEST_SHELF_RENAME'];
    const name =
      seeded ??
      (await vscode.window.showInputBox({ prompt: vscode.l10n.t('Shelf name'), value: t.meta.name }));
    if (name === undefined || name.trim().length === 0) return;
    const comment = seeded !== undefined ? t.meta.comment : await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Comment (optional)'),
      value: t.meta.comment,
    });
    t.store.rename(t.meta.id, name.trim(), comment);
  });

  register('gittree.shelf.delete', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    const ok = await confirmModal(
      vscode.l10n.t('Delete shelved change "{0}"?', t.meta.name),
      vscode.l10n.t('{0} file(s) will be lost. This cannot be undone.', t.meta.files.length),
      vscode.l10n.t('Delete'),
    );
    if (ok) t.store.delete(t.meta.id);
  });

  register('gittree.shelf.export', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    const seeded = process.env['GITTREE_TEST_SHELF_EXPORT'];
    const target =
      seeded !== undefined
        ? vscode.Uri.file(seeded)
        : await vscode.window.showSaveDialog({
            filters: { [vscode.l10n.t('Patch files')]: ['patch', 'diff'] },
            defaultUri: vscode.Uri.file(`${t.meta.name.replace(/[^\w.-]+/gu, '_')}.patch`),
          });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, t.store.readPatch(t.meta.id));
  });

  register('gittree.shelf.import', async () => {
    const repo = repoForNew();
    if (!repo) return;
    const store = shelves.get(canonicalKey(repo.root))!;
    const seeded = process.env['GITTREE_TEST_SHELF_IMPORT'];
    const picked =
      seeded !== undefined
        ? [vscode.Uri.file(seeded)]
        : await vscode.window.showOpenDialog({
            filters: { [vscode.l10n.t('Patch files')]: ['patch', 'diff'] },
            canSelectMany: false,
          });
    if (!picked || picked.length === 0) return;
    const bytes = Buffer.from(await vscode.workspace.fs.readFile(picked[0]!));
    const sections = splitPatchFiles(bytes.toString('utf8'));
    if (sections.length === 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('"{0}" is not a git patch (no file sections found).', picked[0]!.fsPath),
      );
      return;
    }
    const read = (args: string[]): Promise<{ stdout: string }> =>
      repo.queue.enqueue({
        label: 'shelf import read',
        kind: 'read',
        run: (git, token) => git.exec(repo.root, args, { structured: true, token }),
      });
    const baseSha = (await read(['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (await read(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const name = picked[0]!.path.split('/').pop()?.replace(/\.(patch|diff)$/u, '') ?? 'imported';
    store.importPatch(name, bytes, { baseSha, branch, comment: vscode.l10n.t('Imported patch') }, sections.map((s) => ({ relPath: s.relPath, status: s.status === 'modified' ? 'modified' as const : s.status, isBinary: s.isBinary })));
  });

  // Pristine bytes cached at open time so a broken edit can be reverted.
  const pristinePatches = new Map<
    string,
    { store: ShelfStore; id: string; repo: RepoHandle; bytes: Buffer | undefined }
  >();

  register('gittree.shelf.showPatch', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    pristinePatches.set(t.store.patchPath(t.meta.id), {
      store: t.store,
      id: t.meta.id,
      repo: t.repo,
      bytes: t.store.readPatch(t.meta.id),
    });
    await vscode.window.showTextDocument(vscode.Uri.file(t.store.patchPath(t.meta.id)));
  });

  // ---- T4 step 3: revalidate edited shelf patches on save -----------------
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== 'file' || !doc.uri.fsPath.endsWith('changes.patch')) return;
      const known = pristinePatches.get(doc.uri.fsPath);
      const owner =
        known ??
        [...shelves.entries()]
          .map(([key, store]) => {
            const meta = store
              .list()
              .find((m) => store.patchPath(m.id) === doc.uri.fsPath);
            return meta
              ? { store, id: meta.id, repo: core.repos.find((r) => canonicalKey(r.root) === key)!, bytes: undefined }
              : undefined;
          })
          .find((x) => x !== undefined);
      if (!owner) return;
      const meta = owner.store.get(owner.id);
      if (!meta) return;
      // Validate against the BASE tree through a throwaway index — the real
      // index and worktree stay untouched whatever the verdict.
      const tmpIndex = path.join(os.tmpdir(), `gittree-shelf-check-${process.pid}-${Date.now()}`);
      const verdict = await owner.repo.queue.enqueue({
        label: vscode.l10n.t('Validate shelf patch'),
        kind: 'read',
        run: async (git, token) => {
          const env = { GIT_INDEX_FILE: tmpIndex };
          await git.exec(owner.repo.root, ['read-tree', meta.baseSha], { env, token });
          return git.exec(owner.repo.root, ['apply', '--check', '--cached', doc.uri.fsPath], {
            env,
            structured: true,
            allowNonZeroExit: true,
            token,
          });
        },
      });
      try {
        fs.rmSync(tmpIndex, { force: true });
      } catch {
        // temp index — best effort
      }
      if (verdict.exitCode === 0) {
        owner.store.updateAfterEdit(
          owner.id,
          splitPatchFiles(doc.getText()).map((s) => ({
            relPath: s.relPath,
            status: s.status,
            isBinary: s.isBinary,
          })),
        );
        return;
      }
      const revert = vscode.l10n.t('Revert Edit');
      const detail = verdict.stderr.split('\n')[0] ?? '';
      const choice = await vscode.window.showErrorMessage(
        vscode.l10n.t('Edited patch no longer applies to its base: {0}', detail),
        ...(owner.bytes ? [revert] : []),
      );
      if (choice === revert && owner.bytes) {
        fs.writeFileSync(doc.uri.fsPath, owner.bytes);
        owner.store.updateAfterEdit(owner.id, meta.files);
      }
    }),
  );

  core.debugRegistry.set('phase07', {
    getStashService: (repoRoot: string) => services.get(canonicalKey(repoRoot)),
    getShelfStore: (repoRoot: string) => shelves.get(canonicalKey(repoRoot)),
    stashViewProvider: viewProvider,
    shelfViewProvider,
    shelfContent,
  });
}
