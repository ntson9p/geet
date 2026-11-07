/**
 * Phase 3 registration: paradigm manager, changelist service+view, staging
 * ops, commit service/flow (supersedes the P1-T7 MVP over the same command
 * ids), message history, check pipeline.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { isStaged, isUnstaged, isUntracked } from '../core/model/statusEntry';
import { canonicalKey } from '../core/repoDiscovery';
import { confirmModal } from '../ui/confirm';
import { ChangelistService, DEFAULT_LIST_ID, UNVERSIONED_ID } from './changelists/changelistService';
import {
  chunked,
  listIdFor,
  listKeyOf,
  moveChoices,
  UNVERSIONED_KEY,
  type MoveChoice,
} from './changelists/moveChoices';
import { analyzeCheck } from './checks/analyze';
import { cleanupCheck } from './checks/cleanup';
import { optimizeImportsCheck } from './checks/optimizeImports';
import { CheckPipeline, configureChecks } from './checks/pipeline';
import { reformatCheck } from './checks/reformat';
import { todoCheck } from './checks/todo';
import { runCommitAcross, runCommitFlow, type CommitFlowDeps } from './commitFlow';
import { CommitService } from './commitService';
import type { CommitMessageBox } from './messageBox';
import { MessageHistory } from './messageHistory';
import { ParadigmManager } from './paradigmManager';
import { registerStagingOps } from './staging/stagingOps';
import { CommitWindowViewProvider } from './window/commitWindowView';
import { writeCommitGroupBy } from './window/groupBy';
import { InclusionModel } from './window/inclusion';
import { CommitOptionsStore, type DeferredChecksOutcome } from './window/options';
import { repoRootOf } from '../ui/rowContext';
import { STAGING_SIDES, stagingSideOf } from '../shared/protocol';

export interface Phase03Registry {
  paradigm: ParadigmManager;
  commitService: CommitService;
  pipeline: CheckPipeline;
  history: MessageHistory;
  changelistsFor: (repo: RepoHandle) => ChangelistService;
  /** P11-T2 — the commit tool window; undefined has no meaning, it is always built. */
  commitWindow: CommitWindowViewProvider;
  /** P14-T2 — the one place a commit message lives, now the only surface. */
  messageBoxFor: (repo: RepoHandle) => CommitMessageBox;
  /** P11-T3 — per-change inclusion, shared by the window and the commit flow. */
  inclusion: InclusionModel;
  /** P11-T5 — author/sign-off/deferred-checks store behind the gear popup. */
  optionsStore: CommitOptionsStore;
  /** P11-T5 — the most recent deferred post-commit check run (test seam). */
  lastDeferredChecks?: Promise<DeferredChecksOutcome | undefined>;
}

export function registerPhase03(context: vscode.ExtensionContext, core: Core): Phase03Registry {
  const paradigm = new ParadigmManager(core);
  context.subscriptions.push(paradigm);

  // Changelist services per repo.
  const services = new Map<string, ChangelistService>();
  const changelistsFor = (repo: RepoHandle): ChangelistService => {
    const key = canonicalKey(repo.root);
    let s = services.get(key);
    if (!s) {
      s = new ChangelistService(repo.model, context.workspaceState, `gittree.changelists.${key}`);
      services.set(key, s);
      repo.disposables.add(s);
      repo.disposables.add({ dispose: () => services.delete(key) });
    }
    return s;
  };
  for (const repo of core.repos) changelistsFor(repo);
  const addSub = core.onDidAddRepo((repo) => void changelistsFor(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  // P14-T2: the changelists tree view is gone. The commit window's change tree
  // renders the same model with folder rows and tri-state checkboxes the tree
  // view could not, and its native context menus carry the list actions.

  registerStagingOps(context, core);

  const commitService = new CommitService(core);
  context.subscriptions.push(new vscode.Disposable(() => commitService.dispose()));
  const pipeline = new CheckPipeline([
    reformatCheck,
    optimizeImportsCheck,
    cleanupCheck,
    analyzeCheck,
    todoCheck,
  ]);
  const history = new MessageHistory(core, context.globalState);

  // P11-T3: which changes inside a file are in the next commit. One instance
  // shared by the window (which edits it) and the commit flow (which reads it).
  const inclusion = new InclusionModel();
  context.subscriptions.push(new vscode.Disposable(() => inclusion.dispose()));

  // P11-T5: the gear popup's backing store.
  const optionsStore = new CommitOptionsStore(context.workspaceState);

  const commitWindow = new CommitWindowViewProvider({
    context,
    core,
    changelistsFor,
    commitService,
    history,
    paradigm,
    inclusion,
    options: optionsStore,
    runCommit: (repo, options) => runCommitAcross(flowDeps, repo, options),
  });
  context.subscriptions.push(commitWindow);

  /**
   * One accessor for "where the commit message lives". P14-T2 retired the SCM
   * input box, so there is now exactly one answer — but the indirection stays,
   * because every reader and writer already goes through it.
   */
  const messageBoxFor = (repo: RepoHandle): CommitMessageBox => commitWindow.messageBoxFor(repo);

  const flowDeps: CommitFlowDeps = {
    core,
    paradigm,
    commitService,
    pipeline,
    history,
    changelistsFor,
    inputBoxFor: messageBoxFor,
    inclusion,
    options: optionsStore,
    onDeferredChecks: (run) => {
      registry.lastDeferredChecks = run;
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitWindowViewProvider.viewType, commitWindow, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const pickRepo = (arg?: unknown): RepoHandle | undefined => {
    if (typeof arg === 'string') return core.getRepo(arg);
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Commit commands (ids stable since P1).
  // An explicit repo argument is a *scoped* request — a context menu, or a
  // test naming its fixture — and commits exactly that repository. The bare
  // command (palette, Ctrl+K, the commit window's button) means "commit what
  // is ticked", which in a multi-root workspace may span repositories.
  register('gittree.commit', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    if (repoRoot === undefined) await runCommitAcross(flowDeps, repo);
    else await runCommitFlow(flowDeps, repo);
  });
  register('gittree.commitAndPush', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    if (repoRoot === undefined) await runCommitAcross(flowDeps, repo, { andPush: true });
    else await runCommitFlow(flowDeps, repo, { andPush: true });
  });
  register('gittree.commitAmend', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    if (!commitService.isAmend(repo)) {
      const result = await commitService.toggleAmend(repo);
      if (!result.amend) return;
      const input = messageBoxFor(repo);
      if (input && input.value.trim().length === 0 && result.previousMessage !== undefined) {
        input.value = result.previousMessage;
      }
    }
    await runCommitFlow(flowDeps, repo);
  });
  register('gittree.commit.toggleAmend', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    const result = await commitService.toggleAmend(repo);
    const input = messageBoxFor(repo);
    if (result.amend && input && input.value.trim().length === 0 && result.previousMessage !== undefined) {
      input.value = result.previousMessage;
    }
    commitWindow.push();
  });
  register('gittree.commit.toggleSign', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    const on = await commitService.toggleSign(repo);
    void vscode.window.setStatusBarMessage(
      on ? vscode.l10n.t('GPG signing enabled for the next commit') : vscode.l10n.t('GPG signing disabled'),
      3000,
    );
  });
  // A row's menu: what walking from it means depends on the tree the webview shows.
  register('gittree.commit.openChanges', (arg) => {
    const { repoRoot, relPath, stagingSide } = (arg ?? {}) as {
      repoRoot?: unknown;
      relPath?: unknown;
      stagingSide?: unknown;
    };
    if (typeof repoRoot === 'string' && typeof relPath === 'string') {
      // With staging, the half of the file the row stands for (POST-QA F5).
      const side = STAGING_SIDES.find((x) => x === stagingSide);
      commitWindow.openDiffAt({ repoRoot, path: relPath, ...(side !== undefined ? { side } : {}) });
    }
  });

  /**
   * POST-QA F5: Stage / Unstage from a staging-mode row's menu. A file or a
   * folder row names its files; a node row (Staged, Unstaged, Unversioned
   * Files) stands for every file in it, in each repository it spans.
   */
  const stageFromRow = async (arg: unknown, how: 'stage' | 'unstage'): Promise<void> => {
    const ctx = (arg ?? {}) as { repoRoot?: unknown; relPaths?: unknown; targets?: unknown };
    if (typeof ctx.repoRoot === 'string' && Array.isArray(ctx.relPaths)) {
      const repo = core.getRepo(ctx.repoRoot);
      const paths = ctx.relPaths.filter((p): p is string => typeof p === 'string');
      if (repo && paths.length > 0) await commitWindow.stagePaths(repo, paths, how);
      return;
    }
    if (!Array.isArray(ctx.targets)) return;
    for (const target of ctx.targets as Array<{ repoRoot?: unknown; listId?: unknown }>) {
      if (typeof target.repoRoot !== 'string' || typeof target.listId !== 'string') continue;
      const repo = core.getRepo(target.repoRoot);
      const side = stagingSideOf(target.listId);
      if (!repo || side === undefined) continue;
      const paths = repo.model.snapshot.statusEntries
        .filter((e) =>
          side === 'staged' ? isStaged(e) : side === 'unstaged' ? isUnstaged(e) : side === 'unversioned' && isUntracked(e),
        )
        .map((e) => e.path);
      if (paths.length > 0) await commitWindow.stagePaths(repo, paths, how);
    }
  };
  register('gittree.commit.stage', (arg) => stageFromRow(arg, 'stage'));
  register('gittree.commit.unstage', (arg) => stageFromRow(arg, 'unstage'));
  register('gittree.commit.switchParadigm', () => paradigm.switch());
  // The Commit window's View Options › Group By, from the palette or a key.
  register('gittree.commit.groupByRepository', () => writeCommitGroupBy('repository'));
  register('gittree.commit.groupByChangelist', () => writeCommitGroupBy('changelist'));
  register('gittree.commit.configureChecks', () => configureChecks(pipeline));
  register('gittree.commit.showMessageHistory', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    const input = repo ? messageBoxFor(repo) : undefined;
    if (repo && input) await history.showPicker(repo, input);
  });

  // Changelist commands.
  /** The commit window's native context menu passes {repoRoot, listId}. */
  const listArg = (node: unknown): { repo: RepoHandle; listId: string } | undefined => {
    if (typeof node !== 'object' || node === null) return undefined;
    const c = node as { repoRoot?: unknown; listId?: unknown };
    if (typeof c.repoRoot === 'string' && typeof c.listId === 'string') {
      const repo = core.getRepo(c.repoRoot);
      if (repo) return { repo, listId: c.listId };
    }
    return undefined;
  };
  /**
   * The same changelist in every repository the group row stands for. A repo
   * row (and every row in a single-root workspace) carries `{repoRoot, listId}`
   * and yields exactly one target, so scoped callers are unchanged; a merged
   * group row carries `targets` and the action fans out — which is what a
   * project-level changelist means when the storage is per repository.
   */
  const listTargets = (node: unknown): Array<{ repo: RepoHandle; listId: string }> => {
    if (typeof node === 'object' && node !== null) {
      const raw = (node as { targets?: unknown }).targets;
      if (Array.isArray(raw)) {
        const out = raw.flatMap((t) => {
          const e = t as { repoRoot?: unknown; listId?: unknown };
          if (typeof e.repoRoot !== 'string' || typeof e.listId !== 'string') return [];
          const repo = core.getRepo(e.repoRoot);
          return repo ? [{ repo, listId: e.listId }] : [];
        });
        if (out.length > 0) return out;
      }
    }
    const one = listArg(node);
    return one ? [one] : [];
  };
  /**
   * Commit-window file rows carry {repoRoot, relPath, relPaths}; tree nodes do
   * not. `relPath` is the row the menu was opened on and leads the list;
   * `relPaths` (POST-P14v) is the rest of the Ctrl-clicked selection.
   */
  const fileCtxArg = (
    arg: unknown,
  ): { repo: RepoHandle; relPath: string; relPaths: string[] } | undefined => {
    if (typeof arg !== 'object' || arg === null) return undefined;
    const c = arg as { repoRoot?: unknown; relPath?: unknown; relPaths?: unknown };
    if (typeof c.repoRoot !== 'string' || typeof c.relPath !== 'string') return undefined;
    const repo = core.getRepo(c.repoRoot);
    if (!repo) return undefined;
    const rest = Array.isArray(c.relPaths)
      ? c.relPaths.filter((p): p is string => typeof p === 'string' && p !== c.relPath)
      : [];
    return { repo, relPath: c.relPath, relPaths: [c.relPath, ...rest] };
  };
  register('gittree.changelist.new', async (arg) => {
    // A changelist is a project-level idea. Creating it in every repository is
    // what keeps the merged row honest: the next new file lands in the same
    // named list whichever repository it belongs to, and `Move to…` offers it
    // everywhere rather than only where it happens to exist. An explicit repo
    // argument (palette, or a caller naming one) still scopes it.
    const explicit = typeof arg === 'string' ? pickRepo(arg) : undefined;
    const repos = explicit ? [explicit] : core.repos;
    if (repos.length === 0) return;
    const name =
      process.env['GITTREE_TEST_BRANCH_NAME'] ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New changelist name'),
        ignoreFocusOut: true,
      }));
    if (name === undefined || name.trim().length === 0) return;
    const comment = await (process.env['GITTREE_TEST'] === '1'
      ? Promise.resolve(undefined)
      : vscode.window.showInputBox({
          prompt: vscode.l10n.t('Comment (optional)'),
          ignoreFocusOut: true,
        }));
    for (const repo of repos) {
      changelistsFor(repo).create(name.trim(), comment?.trim() || undefined, false);
    }
  });
  register('gittree.changelist.rename', async (node) => {
    const targets = listTargets(node);
    const first = targets[0];
    if (!first) return;
    const list = changelistsFor(first.repo).getList(first.listId);
    if (!list) return;
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Rename changelist'),
      value: list.name,
      ignoreFocusOut: true,
    });
    if (name === undefined || name.trim().length === 0) return;
    const comment = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Comment (optional)'),
      value: list.comment ?? '',
      ignoreFocusOut: true,
    });
    for (const t of targets) changelistsFor(t.repo).rename(t.listId, name.trim(), comment?.trim());
  });
  register('gittree.changelist.delete', async (node) => {
    const targets = listTargets(node).filter((t) => {
      const l = changelistsFor(t.repo).getList(t.listId);
      return l !== undefined && !l.isDefault;
    });
    const first = targets[0];
    if (!first) return;
    if (targets.length > 1) {
      // Across repositories the per-repo "move its files to…" pick would be one
      // prompt per repository for one gesture. The files go to each repo's own
      // default list, which is where deleting a list puts them anyway.
      for (const t of targets) changelistsFor(t.repo).remove(t.listId, DEFAULT_LIST_ID);
      return;
    }
    const service = changelistsFor(first.repo);
    const list = service.getList(first.listId);
    if (!list) return;
    let target = DEFAULT_LIST_ID;
    if (list.files.length > 0) {
      const options = service
        .getLists()
        .filter((l) => l.id !== first.listId)
        .map((l) => ({ label: l.name, id: l.id }));
      const picked =
        options.length === 1
          ? options[0]
          : await vscode.window.showQuickPick(options, {
              placeHolder: vscode.l10n.t('Move {0} file(s) to…', list.files.length),
            });
      if (!picked) return;
      target = picked.id;
    }
    service.remove(first.listId, target);
  });
  register('gittree.changelist.setActive', (node) => {
    for (const t of listTargets(node)) changelistsFor(t.repo).setActive(t.listId);
  });
  register('gittree.changelist.commitList', async (node) => {
    const targets = listTargets(node);
    const first = targets[0];
    if (!first) return;
    if (targets.length === 1) {
      await runCommitFlow(flowDeps, first.repo, { listId: first.listId });
      return;
    }
    // One list, several repositories: the same spanning commit the button runs,
    // narrowed to this changelist in each of them.
    const lists = new Map(targets.map((t) => [canonicalKey(t.repo.root), t.listId]));
    await runCommitAcross(flowDeps, pickRepo(undefined) ?? first.repo, { lists });
  });
  /**
   * POST-P14bf: the files a change-tree row's menu acts on, per repository,
   * as IntelliJ's actions act on every file under the node they are invoked on.
   * A file or folder row names its files; a list row names lists, whose files
   * are read here, where they are current (Unversioned Files' being the
   * repository's unversioned files); a repository row names the repository,
   * every change of it.
   */
  const rowFiles = (args: readonly unknown[]): Array<{ repo: RepoHandle; relPaths: string[] }> => {
    for (const arg of args) {
      const files = fileCtxArg(arg);
      if (files) return [{ repo: files.repo, relPaths: files.relPaths }];
    }
    for (const arg of args) {
      if (typeof arg !== 'object' || arg === null) continue;
      const c = arg as { targets?: unknown; listId?: unknown };
      if (Array.isArray(c.targets) || typeof c.listId === 'string') {
        const byRepo = new Map<RepoHandle, string[]>();
        for (const { repo, listId } of listTargets(arg)) {
          const service = changelistsFor(repo);
          const files = listId === UNVERSIONED_ID ? service.unversioned() : (service.getList(listId)?.files ?? []);
          byRepo.set(repo, [...(byRepo.get(repo) ?? []), ...files]);
        }
        if (byRepo.size > 0) return [...byRepo].map(([repo, relPaths]) => ({ repo, relPaths }));
        continue;
      }
      const root = repoRootOf(arg);
      const repo = root !== undefined ? core.getRepo(root) : undefined;
      if (repo) {
        const service = changelistsFor(repo);
        return [{ repo, relPaths: [...service.getLists().flatMap((l) => l.files), ...service.unversioned()] }];
      }
    }
    return [];
  };

  /**
   * `add -N` rather than a plain `add`: intent-to-add makes git track the
   * path without copying its content into the index, which is the invariant
   * the changelists paradigm and per-change inclusion both rest on (the commit
   * path assembles its own tree — see `commitChangelistPartial`). The file
   * still reads as `A` in status, so it shows up green exactly as IntelliJ
   * draws it. In slices, so a repository's every new file fits a command line.
   */
  const intentToAdd = async (repo: RepoHandle, relPaths: readonly string[]): Promise<void> => {
    if (relPaths.length === 0) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Add {0} file(s) to VCS', relPaths.length),
      kind: 'mutate',
      run: async (git, token) => {
        for (const slice of chunked(relPaths)) {
          await git.exec(repo.root, ['add', '-N', '--', ...slice], { token });
        }
      },
    });
  };

  /**
   * IntelliJ's chooser for Move to Another Changelist…: a list's key, or the
   * name of a new one. One choice per merged row of the tree, so files of
   * several repositories go to each one's copy of the list.
   */
  const pickMoveTarget = async (
    choices: readonly MoveChoice[],
    count: number,
  ): Promise<{ readonly key: string } | { readonly name: string } | undefined> => {
    const seeded = process.env['GITTREE_TEST_CHANGELIST_PICK'];
    if (seeded !== undefined) {
      const hit = choices.find((c) => c.label === seeded);
      return hit !== undefined ? { key: hit.key } : { name: seeded };
    }
    const newListLabel = vscode.l10n.t('$(add) New changelist…');
    const picked = await vscode.window.showQuickPick(
      [...choices.map((c) => ({ label: c.label, key: c.key })), { label: newListLabel, key: '__new__' }],
      { placeHolder: vscode.l10n.t('Move {0} file(s) to…', count) },
    );
    if (!picked) return undefined;
    if (picked.key !== '__new__') return { key: picked.key };
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('New changelist name'),
      ignoreFocusOut: true,
    });
    if (name === undefined || name.trim().length === 0) return undefined;
    return { name: name.trim() };
  };

  /**
   * IntelliJ's Move to Another Changelist…, on files, folders, the Unversioned
   * Files rows and a repository row. Unversioned files are added to VCS in the
   * list they move to, as IntelliJ's `MoveChangesToAnotherListAction` does
   * (`addUnversionedFilesToVcsInBackground(project, targetList, …)`).
   */
  register('gittree.changelist.moveTo', async (...args) => {
    const rows = rowFiles(args).filter((r) => r.relPaths.length > 0);
    const count = rows.reduce((n, r) => n + r.relPaths.length, 0);
    if (count === 0) return;
    const choices = moveChoices(
      rows.map(({ repo, relPaths }) => {
        const service = changelistsFor(repo);
        return {
          lists: service.getLists(),
          fromKeys: new Set(
            relPaths.map((p) => {
              const list = service.listOf(p);
              return list !== undefined ? listKeyOf(list) : UNVERSIONED_KEY;
            }),
          ),
        };
      }),
    );
    const target = await pickMoveTarget(choices, count);
    if (!target) return;
    for (const { repo, relPaths } of rows) {
      const service = changelistsFor(repo);
      const lists = service.getLists();
      // A repository with no copy of the list gets one under the same name, as
      // New Changelist… makes one in every repository.
      const id =
        'key' in target
          ? (listIdFor(lists, target.key) ??
            service.create(choices.find((c) => c.key === target.key)?.label ?? target.key).id)
          : (lists.find((l) => !l.isDefault && l.name === target.name)?.id ?? service.create(target.name).id);
      const unversioned = relPaths.filter((p) => service.isUntrackedPath(p));
      service.moveFiles(relPaths, id);
      await intentToAdd(repo, unversioned);
    }
  });

  /**
   * POST-P14v — IntelliJ's `Add to VCS`: unversioned files become versioned
   * and land in the **default** changelist, ticked. POST-P14bf: on folders, the
   * Unversioned Files rows and a repository row too; a file already moved into
   * a list stays in it.
   */
  register('gittree.addToVcs', async (...args) => {
    for (const { repo, relPaths } of rowFiles(args)) {
      const service = changelistsFor(repo);
      // The menu is gated on the rows holding unversioned files, but a status
      // refresh can land while the menu is open. Re-adding a tracked file would
      // stage content nobody asked to stage.
      const targets = relPaths.filter((p) => service.isUntrackedPath(p));
      if (targets.length === 0) continue;
      // Asked before git hears of them: once tracked, reconcile adopts them
      // into the active list, and they would no longer read as loose.
      const loose = targets.filter((p) => service.listOf(p) === undefined);
      await intentToAdd(repo, targets);
      // The default list, not whichever list happens to be active: reconcile's
      // adoption rule is the latter, so saying so explicitly is the only way.
      if (loose.length > 0) service.moveFiles(loose, DEFAULT_LIST_ID);
    }
  });

  // Template prefill per repo (P14-T2 dropped acceptInputCommand with the box).
  const attach = (repo: RepoHandle): void => {
    void history.applyTemplate(repo, messageBoxFor(repo));
  };
  for (const repo of core.repos) attach(repo);
  const addSub2 = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub2.dispose()));

  const registry: Phase03Registry = {
    paradigm,
    commitService,
    pipeline,
    history,
    changelistsFor,
    commitWindow,
    messageBoxFor,
    inclusion,
    optionsStore,
  };
  core.debugRegistry.set('phase03', registry);
  return registry;
}

/** Re-exported for the unstage-on-switch confirm (kept here for cohesion). */
export { confirmModal };
