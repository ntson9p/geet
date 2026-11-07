/**
 * Phase 7 registration (T1 service + T2 stashes view/commands + T3 shelf
 * store; T4/T5 add the shelf view and unshelve engine).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import { writeSetting } from '../ui/writeSetting';
import { notifySuccess } from '../ui/notify';
import type { Core, RepoHandle } from '../core/core';
import { splitPatchFiles } from '../core/patch/patchParser';
import { canonicalKey } from '../core/repoDiscovery';
import { repoStoreKey } from '../localHistory/snapshotStore';
import { confirmModal, typedConfirm } from '../ui/confirm';
import { repoRootOf } from '../ui/rowContext';
import type { ConflictSource } from '../merge/conflictSession';
import type { Phase03Registry } from '../commit/register';
import { ShelfBridge } from '../commit/window/shelfBridge';
import { StashBridge } from '../commit/window/stashBridge';
import { showShelveDialog } from '../shelf/shelveDialog';
import { ShelfStore, type ShelfFileMeta, type ShelfMeta, type ShelveOptions } from '../shelf/shelfStore';
import {
  makeShelfUri,
  SHELF_SCHEME,
  shelfDiffSides,
  ShelfContentProvider,
} from '../shelf/shelfView';
import { UnshelveEngine } from '../shelf/unshelve';
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
  getSession?(repoRoot: string): unknown;
  lifecycle: {
    expectConflict(repoRoot: string, source: ConflictSource): void;
    onDidChangeSessions?: vscode.Event<void>;
  };
}

/** P3 registry slice for the post-unshelve changelist filing (P5-T3 shape). */
interface CommitShape {
  paradigm: { paradigm: 'changelists' | 'staging' };
  changelistsFor: (repo: RepoHandle) => {
    getLists(): Array<{ id: string; name: string }>;
    create(name: string, comment?: string, makeActive?: boolean): { id: string };
    moveFiles(relPaths: readonly string[], targetId: string): void;
  };
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
      notifySuccess(vscode.l10n.t('Files stashed successfully'));
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
    // IntelliJ's `stash.files.success`.
    notifySuccess(vscode.l10n.t('Files stashed successfully'));
  });

  // IntelliJ's `unstash.stash.applied` once it went in cleanly; a conflicted
  // one has the conflicts session to say so instead.
  register('gittree.stash.apply', async (arg) => {
    const t = await pickStash(arg);
    if (!t) return;
    const outcome = await t.service.apply(t.index, { restoreIndex: true });
    if (outcome.status === 'clean') notifySuccess(vscode.l10n.t('Stash successfully applied'));
  });
  register('gittree.stash.pop', async (arg) => {
    const t = await pickStash(arg);
    if (!t) return;
    const outcome = await t.service.pop(t.index, { restoreIndex: true });
    if (outcome.status === 'clean') notifySuccess(vscode.l10n.t('Stash successfully applied'));
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
    if (name === undefined || name.trim().length === 0) return;
    await t.service.branch(name.trim(), t.index);
    notifySuccess(vscode.l10n.t('Stash successfully applied on new branch {0}', name.trim()));
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

  // ---- P7-T4: shelf per-file diffs, patch edit/import/export --------------
  // P14-T2: the `gittree.shelf` tree view is gone; the commit window's Shelf
  // tab (P11-T6) renders the same stores through shelfBridge.
  const shelfContent = new ShelfContentProvider(
    (repoRoot) => shelves.get(canonicalKey(repoRoot)),
    (repoRoot) => core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot)),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SHELF_SCHEME, shelfContent),
  );
  // P14-T2: no tree view to push to. ShelfBridge (P11-T6) carries its own
  // per-store onDidChange subscriptions and its own showUnshelved config
  // listener, so the Shelf tab still refreshes on every store change.

  /**
   * Resolve the acted-on shelf entry: the `{repoRoot, shelfId}` shape the
   * commit window's Shelf tab and its native context menu pass (P11-T6), else
   * QuickPick. P14-T2 removed the tree-node branch with the tree view.
   */
  const pickShelf = async (
    arg: unknown,
  ): Promise<{ repo: RepoHandle; store: ShelfStore; meta: ShelfMeta } | undefined> => {
    if (arg && typeof arg === 'object' && 'shelfId' in arg && 'repoRoot' in arg) {
      const ref = arg as { repoRoot: string; shelfId: string };
      const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(ref.repoRoot));
      const store = shelves.get(canonicalKey(ref.repoRoot));
      const meta = store?.get(ref.shelfId);
      if (repo && store && meta) return { repo, store, meta };
      void vscode.window.showWarningMessage(vscode.l10n.t('That shelved change no longer exists.'));
      return undefined;
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
    if (seeded !== undefined) {
      // Name match first (stable under leftover entries), index fallback.
      return choices.find((c) => c.meta.name === seeded) ?? choices[Number.parseInt(seeded, 10)];
    }
    return vscode.window.showQuickPick(choices, {
      placeHolder: vscode.l10n.t('Select a shelved change'),
    });
  };

  const phase03 = (): Phase03Registry | undefined =>
    core.debugRegistry.get('phase03') as Phase03Registry | undefined;
  /** Commit-window group rows identify a changelist by {repoRoot, listId}. */
  const listCtx = (arg: unknown): { repo: RepoHandle; listId: string } | undefined => {
    if (typeof arg !== 'object' || arg === null) return undefined;
    const c = arg as { repoRoot?: unknown; listId?: unknown };
    if (typeof c.repoRoot !== 'string' || typeof c.listId !== 'string') return undefined;
    const key = canonicalKey(c.repoRoot);
    const repo = core.repos.find((r) => canonicalKey(r.root) === key);
    return repo ? { repo, listId: c.listId } : undefined;
  };
  const listOf = (
    repo: RepoHandle,
    listId: string,
  ): { name: string; files: readonly string[] } | undefined => phase03()?.changelistsFor(repo).getList(listId);

  /** Shelve flow — commit-window group row, toolbar and palette all land here. */
  register('gittree.shelf.shelve', async (arg) => {
    // P14-T2: the changelists tree view is gone; the commit window's group row
    // passes {repoRoot, listId} through its native context menu instead.
    const ctx = listCtx(arg);
    const repo = ctx?.repo ?? repoForNew();
    if (!repo) return;
    const store = shelves.get(canonicalKey(repo.root))!;
    const list = ctx ? listOf(repo, ctx.listId) : undefined;
    const listPaths = list && list.files.length > 0 ? list.files : undefined;

    const seeded = process.env['GITTREE_TEST_SHELVE'];
    if (seeded !== undefined) {
      const opts = JSON.parse(seeded) as ShelveOptions;
      const res = await store.shelve(list ? { paths: listPaths, ...opts } : opts);
      if (res.removalSkippedReason === undefined) {
        notifySuccess(vscode.l10n.t('Changes shelved successfully'));
      }
      return;
    }
    // IntelliJ default name: the changelist name, else the commit-window draft.
    const draft = phase03()?.messageBoxFor(repo).value.trim();
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Shelf name'),
      value: list ? list.name : draft && draft.length > 0 ? draft.split('\n')[0] : '',
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
    } else {
      // IntelliJ's `shelve.successful.message`.
      notifySuccess(vscode.l10n.t('Changes shelved successfully'));
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
      vscode.l10n.t('{0} will be lost. This cannot be undone.', filesCount(t.meta.files.length)),
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
    // IntelliJ's `create.patch.success.confirmation`.
    notifySuccess(vscode.l10n.t('Successfully created patch {0}', target.fsPath));
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
    notifySuccess(vscode.l10n.t('Imported "{0}" to the shelf ({1})', name, filesCount(sections.length)));
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

  // ---- T5: unshelve engine + commands --------------------------------------
  const engineFor = (t: { repo: RepoHandle; store: ShelfStore }): UnshelveEngine =>
    new UnshelveEngine(t.repo, t.store, expectConflict, trace);

  /**
   * Delete/prune the entry once the conflict session this unshelve produced
   * completes (spec: delete-after is "skipped automatically when conflicts
   * occurred until session completes"). The lifecycle ends a session only
   * when zero unmerged paths remain, so session-end ≙ resolution.
   */
  const finalizeAfterSession = (
    t: { repo: RepoHandle; store: ShelfStore; meta: ShelfMeta },
    indexes: readonly number[] | undefined,
  ): void => {
    const p6 = core.debugRegistry.get('phase06') as Phase06LifecycleShape | undefined;
    if (!p6?.getSession || !p6.lifecycle.onDidChangeSessions) return;
    // The session already exists by now (the engine's refresh created it
    // synchronously) — seed from live state so an end-event with no
    // intermediate fires still triggers the finalize.
    let seen = p6.getSession(t.repo.root) !== undefined;
    const sub = p6.lifecycle.onDidChangeSessions(() => {
      const session = p6.getSession!(t.repo.root);
      if (session !== undefined) {
        seen = true;
        return;
      }
      if (!seen) return;
      sub.dispose();
      engineFor(t).finalize(t.meta.id, indexes);
    });
    context.subscriptions.push(sub);
  };

  const runUnshelve = async (
    t: { repo: RepoHandle; store: ShelfStore; meta: ShelfMeta },
    indexes: readonly number[] | undefined,
    deleteAfter: boolean,
  ): Promise<void> => {
    const p3 = core.debugRegistry.get('phase03') as CommitShape | undefined;
    const changelists = p3?.paradigm.paradigm === 'changelists';
    const engine = engineFor(t);
    let res;
    try {
      res = await engine.unshelve(t.meta, {
        ...(indexes === undefined ? {} : { sectionIndexes: indexes }),
        deleteAfter,
        unstageAfterApply: changelists,
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Cannot unshelve "{0}": {1}', t.meta.name, String((err as Error).message)),
      );
      return;
    }
    if (res.status === 'failed') {
      const exportAction = vscode.l10n.t('Export Patch…');
      const choice = await vscode.window.showErrorMessage(
        vscode.l10n.t('Unshelve failed: {0}. No files were changed.', res.reason),
        exportAction,
      );
      if (choice === exportAction) {
        await vscode.commands.executeCommand('gittree.shelf.export', {
          kind: 'entry',
          repo: t.repo,
          store: t.store,
          meta: t.meta,
        });
      }
      return;
    }
    if (res.status === 'clean') {
      // IntelliJ parity: unshelved files land in a changelist named after
      // the entry (the model's active-list adoption is superseded by the
      // explicit move, which also files untracked files).
      if (changelists && res.relPaths.length > 0) {
        const service = p3?.changelistsFor(t.repo);
        if (service) {
          const existing = service.getLists().find((l) => l.name === t.meta.name);
          const target = existing ?? service.create(t.meta.name);
          service.moveFiles(res.relPaths, target.id);
        }
      }
      // P11-T6: a kept-after-apply entry is IntelliJ's greyed "already
      // unshelved" state — mark full unshelves so the Shelf surfaces can hide
      // them behind the Show-already-unshelved toggle.
      if (!deleteAfter && indexes === undefined) t.store.markUnshelved(t.meta.id);
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Unshelved "{0}" ({1}).', t.meta.name, filesCount(res.relPaths.length)),
      );
      return;
    }
    // conflicts: the P6 session toast has already fired.
    if (deleteAfter) {
      finalizeAfterSession(t, indexes);
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Unshelve of "{0}" produced conflicts — the shelf entry is kept until they are resolved.',
          t.meta.name,
        ),
      );
    }
  };

  /** Two-item remove/keep choice, drift note in the placeholder (step 3). */
  const pickDeleteAfter = async (
    engine: UnshelveEngine,
    meta: ShelfMeta,
  ): Promise<boolean | undefined> => {
    const drifted = await engine.baseDrifted(meta);
    const note = drifted
      ? vscode.l10n.t(
          ' Note: the shelf base {0} is not an ancestor of HEAD — conflicts are possible.',
          meta.baseSha.slice(0, 7),
        )
      : '';
    const choice = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t('Unshelve and remove from shelf'), deleteAfter: true },
        { label: vscode.l10n.t('Unshelve keeping the shelf entry'), deleteAfter: false },
      ],
      { placeHolder: vscode.l10n.t('Apply "{0}" to the working tree.', meta.name) + note },
    );
    return choice?.deleteAfter;
  };

  register('gittree.shelf.unshelve', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    const seeded = process.env['GITTREE_TEST_UNSHELVE'];
    let deleteAfter: boolean | undefined;
    if (seeded !== undefined) {
      deleteAfter = (JSON.parse(seeded) as { deleteAfter?: boolean }).deleteAfter ?? true;
    } else {
      deleteAfter = await pickDeleteAfter(engineFor(t), t.meta);
    }
    if (deleteAfter === undefined) return;
    await runUnshelve(t, undefined, deleteAfter);
  });

  // P11-T6: IntelliJ's "Unshelve Silently" — apply with the defaults, no
  // prompts. deleteAfter=true is this codebase's stated IntelliJ default
  // (P7-T5's pickDeleteAfter labels), kept consistent here.
  register('gittree.shelf.unshelveSilently', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    await runUnshelve(t, undefined, true);
  });

  /** Resolve a shelf FILE from a tree node or the tab's {repoRoot, shelfId, relPath}. */
  const pickShelfFile = async (
    arg: unknown,
  ): Promise<
    { repo: RepoHandle; store: ShelfStore; meta: ShelfMeta; file: ShelfFileMeta } | undefined
  > => {
    if (arg && typeof arg === 'object' && 'relPath' in arg) {
      const ref = arg as { repoRoot?: string; shelfId?: string; relPath: string };
      const t = await pickShelf(ref);
      const file = t?.meta.files.find((f) => f.relPath === ref.relPath);
      if (t && file) return { ...t, file };
    }
    return undefined;
  };

  // P11-T6: shelved content ↔ the file as it is in the worktree right now.
  register('gittree.shelf.compareWithLocal', async (arg) => {
    const t = await pickShelfFile(arg);
    if (!t) return;
    if (t.file.isBinary) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" is binary — no text comparison available.', t.file.relPath),
      );
      return;
    }
    const baseName = t.file.relPath.split('/').pop() ?? t.file.relPath;
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeShelfUri(t.repo.root, t.meta.id, t.file.relPath),
      vscode.Uri.file(path.join(t.repo.root, t.file.relPath)),
      vscode.l10n.t('{0} (Shelved: {1} ↔ Local)', baseName, t.meta.name),
    );
  });

  // P11-T6: the tab's file-row activate — same base↔shelved diff the tree opens.
  register('gittree.shelf.openShelvedDiff', async (arg) => {
    const t = await pickShelfFile(arg);
    if (!t || t.file.isBinary) return;
    const sides = shelfDiffSides({
      kind: 'file',
      repo: t.repo,
      store: t.store,
      meta: t.meta,
      file: t.file,
    });
    await vscode.commands.executeCommand('vscode.diff', sides.left, sides.right, sides.title);
  });

  register('gittree.shelf.showUnshelved', async () => {
    const config = vscode.workspace.getConfiguration('gittree.shelf');
    await writeSetting('gittree.shelf', 'showUnshelved', !config.get<boolean>('showUnshelved', false));
  });
  // P14-T2: no listener here any more — ShelfBridge carries its own
  // `gittree.shelf.showUnshelved` config listener for the Shelf tab.

  register('gittree.shelf.unshelvePartial', async (arg) => {
    const t = await pickShelf(arg);
    if (!t) return;
    const engine = engineFor(t);
    const seeded = process.env['GITTREE_TEST_UNSHELVE_PARTIAL'];
    if (seeded !== undefined) {
      const opts = JSON.parse(seeded) as { indexes: number[]; deleteAfter?: boolean };
      await runUnshelve(t, opts.indexes, opts.deleteAfter ?? true);
      return;
    }
    const sections = engine.sectionsOf(t.meta);
    interface FileChoice extends vscode.QuickPickItem {
      index: number;
    }
    const picked = await vscode.window.showQuickPick<FileChoice>(
      sections.map((s, index) => ({
        label: s.relPath,
        description: s.isBinary ? `${s.status} · binary` : s.status,
        picked: true,
        index,
      })),
      { canPickMany: true, placeHolder: vscode.l10n.t('Files to unshelve from "{0}"', t.meta.name) },
    );
    if (picked === undefined || picked.length === 0) return;
    const deleteAfter = await pickDeleteAfter(engine, t.meta);
    if (deleteAfter === undefined) return;
    await runUnshelve(
      t,
      picked.map((c) => c.index),
      deleteAfter,
    );
  });

  // P11-T7: the Shelve Changes dialog — the IntelliJ-shaped surface. The
  // QuickPick flow above (`gittree.shelf.shelve`) remains for native mode and
  // for tests that seed it via env.
  register('gittree.shelve.dialog', async (arg) => {
    const p3full = core.debugRegistry.get('phase03') as Phase03Registry | undefined;
    if (!p3full) return;
    let repo: RepoHandle | undefined;
    let listId: string | undefined;
    if (typeof arg === 'string') {
      repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
    } else {
      const ctx = listCtx(arg);
      if (ctx) {
        repo = ctx.repo;
        listId = ctx.listId;
      } else {
        // A repository row of the Commit window: every change of that repository.
        const root = repoRootOf(arg);
        if (root !== undefined) repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
      }
    }
    repo ??= repoForNew();
    if (!repo) return;
    await showShelveDialog(
      {
        core,
        extensionUri: context.extensionUri,
        changelistsFor: (r) => p3full.changelistsFor(r),
        storeFor: (root) => shelves.get(canonicalKey(root)),
        draftMessage: (r) => p3full.commitWindow.getMessage(r),
        trace,
      },
      repo,
      listId,
    );
  });

  // P11-T6: hand the commit window its Shelf tab data source. Phase 03 built
  // the window; the stores live here — the bridge ties them together and the
  // tab dispatches back into the very commands registered above.
  const shelfBridge = new ShelfBridge({
    core,
    storeFor: (repoRoot) => shelves.get(canonicalKey(repoRoot)),
  });
  context.subscriptions.push(shelfBridge);
  // POST-P14l: the same tie for the Stash tab. IntelliJ keeps stashes in a tab
  // of the Commit tool window beside Shelf, not in a sidebar pane.
  const stashBridge = new StashBridge({
    core,
    serviceFor: (repoRoot) => services.get(canonicalKey(repoRoot)),
  });
  context.subscriptions.push(stashBridge);
  const commitWindow = (
    core.debugRegistry.get('phase03') as
      | {
          commitWindow?: {
            attachShelf(bridge: ShelfBridge): void;
            attachStash(bridge: StashBridge): void;
          };
        }
      | undefined
  )?.commitWindow;
  commitWindow?.attachShelf(shelfBridge);
  commitWindow?.attachStash(stashBridge);

  core.debugRegistry.set('phase07', {
    getStashService: (repoRoot: string) => services.get(canonicalKey(repoRoot)),
    /** POST-P14n: lets the gate be asserted against a real view, not the manifest. */
    stashView: view,
    getShelfStore: (repoRoot: string) => shelves.get(canonicalKey(repoRoot)),
    shelfBridge,
    stashBridge,
    makeUnshelveEngine: (repoRoot: string) => {
      const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot));
      const store = shelves.get(canonicalKey(repoRoot));
      return repo && store ? new UnshelveEngine(repo, store, expectConflict, trace) : undefined;
    },
    stashViewProvider: viewProvider,
    shelfContent,
  });
}
