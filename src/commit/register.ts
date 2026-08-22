/**
 * Phase 3 registration: paradigm manager, changelist service+view, staging
 * ops, commit service/flow (supersedes the P1-T7 MVP over the same command
 * ids), message history, check pipeline.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { setHideStagingGroupsProvider, type GitTreeSourceControl } from '../scm/sourceControl';
import type { Phase01Registry } from '../scm/register';
import { confirmModal } from '../ui/confirm';
import { ChangelistService, DEFAULT_LIST_ID } from './changelists/changelistService';
import { ChangelistsViewProvider, type ChangelistNode } from './changelists/changelistsView';
import { analyzeCheck } from './checks/analyze';
import { cleanupCheck } from './checks/cleanup';
import { optimizeImportsCheck } from './checks/optimizeImports';
import { CheckPipeline, configureChecks } from './checks/pipeline';
import { reformatCheck } from './checks/reformat';
import { todoCheck } from './checks/todo';
import { runCommitFlow, type CommitFlowDeps } from './commitFlow';
import { CommitService } from './commitService';
import type { CommitMessageBox } from './messageBox';
import { MessageHistory } from './messageHistory';
import { ParadigmManager } from './paradigmManager';
import { registerStagingOps } from './staging/stagingOps';
import { CommitWindowViewProvider } from './window/commitWindowView';
import { InclusionModel } from './window/inclusion';

export interface Phase03Registry {
  paradigm: ParadigmManager;
  commitService: CommitService;
  pipeline: CheckPipeline;
  history: MessageHistory;
  changelistsFor: (repo: RepoHandle) => ChangelistService;
  viewProvider: ChangelistsViewProvider;
  /** P11-T2 — the commit tool window; undefined has no meaning, it is always built. */
  commitWindow: CommitWindowViewProvider;
  /** P11-T2 — resolved commit surface (`gittree.commit.window`). */
  commitWindowMode: () => 'webview' | 'native';
  /** P11-T3 — per-change inclusion, shared by the window and the commit flow. */
  inclusion: InclusionModel;
}

export function registerPhase03(context: vscode.ExtensionContext, core: Core): Phase03Registry {
  const phase01 = core.debugRegistry.get('phase01') as Phase01Registry | undefined;
  const scFor = (repo: RepoHandle): GitTreeSourceControl | undefined =>
    phase01?.sourceControls.get(canonicalKey(repo.root));

  const paradigm = new ParadigmManager(core);
  context.subscriptions.push(paradigm);

  // SCM groups hide in changelists mode (P3-T1 step 3).
  setHideStagingGroupsProvider(() => paradigm.paradigm === 'changelists');
  const rerenderAll = (): void => {
    for (const repo of core.repos) scFor(repo)?.update();
  };
  const paradigmSub = paradigm.onDidChange(() => rerenderAll());
  context.subscriptions.push(new vscode.Disposable(() => paradigmSub.dispose()));
  rerenderAll();

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

  // Changelists view.
  const viewProvider = new ChangelistsViewProvider(core, changelistsFor);
  const view = vscode.window.createTreeView('gittree.changelists', {
    treeDataProvider: viewProvider,
    dragAndDropController: viewProvider,
    canSelectMany: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    view,
    view.onDidChangeCheckboxState((e) => viewProvider.onCheckboxChanged(e.items)),
  );

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

  // ---- P11-T2: commit tool window -----------------------------------------
  // `webview` is the default surface; `native` restores the P3 SCM view + input
  // box untouched, which is the escape hatch for the master §6 objection.
  const commitWindowMode = (): 'webview' | 'native' =>
    vscode.workspace.getConfiguration('gittree').get<string>('commit.window') === 'native'
      ? 'native'
      : 'webview';

  // P11-T3: which changes inside a file are in the next commit. One instance
  // shared by the window (which edits it) and the commit flow (which reads it).
  const inclusion = new InclusionModel();
  context.subscriptions.push(new vscode.Disposable(() => inclusion.dispose()));

  const commitWindow = new CommitWindowViewProvider({
    context,
    core,
    changelistsFor,
    commitService,
    history,
    paradigm,
    inclusion,
    runCommit: (repo, options) => runCommitFlow(flowDeps, repo, options),
  });
  context.subscriptions.push(commitWindow);

  /**
   * One accessor for "where the commit message lives". Everything that reads or
   * writes a message goes through it, so the two surfaces cannot diverge.
   */
  const messageBoxFor = (repo: RepoHandle): CommitMessageBox | undefined =>
    commitWindowMode() === 'webview' ? commitWindow.messageBoxFor(repo) : scFor(repo)?.sc.inputBox;

  const flowDeps: CommitFlowDeps = {
    core,
    paradigm,
    commitService,
    pipeline,
    history,
    changelistsFor,
    inputBoxFor: messageBoxFor,
    inclusion,
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitWindowViewProvider.viewType, commitWindow, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /** Drives the `when` clauses and hides the now-redundant SCM input box. */
  const applyWindowMode = (): void => {
    const mode = commitWindowMode();
    void vscode.commands.executeCommand('setContext', 'gittree.commitWindow', mode);
    for (const repo of core.repos) {
      const box = scFor(repo)?.sc.inputBox;
      if (box) box.visible = mode === 'native';
    }
  };
  applyWindowMode();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gittree.commit.window')) {
        applyWindowMode();
        commitWindow.push();
      }
    }),
  );
  const modeSub = core.onDidAddRepo(() => applyWindowMode());
  context.subscriptions.push(new vscode.Disposable(() => modeSub.dispose()));

  const pickRepo = (arg?: unknown): RepoHandle | undefined => {
    if (typeof arg === 'string') return core.getRepo(arg);
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  // Commit commands (ids stable since P1).
  register('gittree.commit', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (repo) await runCommitFlow(flowDeps, repo);
  });
  register('gittree.commitAndPush', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (repo) await runCommitFlow(flowDeps, repo, { andPush: true });
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
  register('gittree.commit.switchParadigm', () => paradigm.switch());
  register('gittree.commit.configureChecks', () => configureChecks(pipeline));
  register('gittree.commit.showMessageHistory', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    const input = repo ? messageBoxFor(repo) : undefined;
    if (repo && input) await history.showPicker(repo, input);
  });

  // Changelist commands.
  const listArg = (node: unknown): { repo: RepoHandle; listId: string } | undefined => {
    if (typeof node === 'object' && node !== null && 'kind' in node && node.kind === 'list') {
      const n = node as Extract<ChangelistNode, { kind: 'list' }>;
      return { repo: n.repo, listId: n.list.id };
    }
    return undefined;
  };
  register('gittree.changelist.new', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
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
    changelistsFor(repo).create(name.trim(), comment?.trim() || undefined, false);
  });
  register('gittree.changelist.rename', async (node) => {
    const arg = listArg(node);
    if (!arg) return;
    const list = changelistsFor(arg.repo).getList(arg.listId);
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
    changelistsFor(arg.repo).rename(arg.listId, name.trim(), comment?.trim());
  });
  register('gittree.changelist.delete', async (node) => {
    const arg = listArg(node);
    if (!arg) return;
    const service = changelistsFor(arg.repo);
    const list = service.getList(arg.listId);
    if (!list || list.isDefault) return;
    let target = DEFAULT_LIST_ID;
    if (list.files.length > 0) {
      const options = service
        .getLists()
        .filter((l) => l.id !== arg.listId)
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
    service.remove(arg.listId, target);
  });
  register('gittree.changelist.setActive', (node) => {
    const arg = listArg(node);
    if (arg) changelistsFor(arg.repo).setActive(arg.listId);
  });
  register('gittree.changelist.commitList', async (node) => {
    const arg = listArg(node);
    if (arg) await runCommitFlow(flowDeps, arg.repo, { listId: arg.listId });
  });
  register('gittree.changelist.moveTo', async (...args) => {
    const files = args.filter(
      (a): a is Extract<ChangelistNode, { kind: 'file' }> =>
        typeof a === 'object' && a !== null && 'kind' in a && a.kind === 'file',
    );
    if (files.length === 0) return;
    const repo = files[0]!.repo;
    const service = changelistsFor(repo);
    const newListLabel = vscode.l10n.t('$(add) New changelist…');
    const options = [
      ...service.getLists().map((l) => ({ label: l.name, id: l.id })),
      { label: newListLabel, id: '__new__' },
    ];
    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: vscode.l10n.t('Move {0} file(s) to…', files.length),
    });
    if (!picked) return;
    let targetId = picked.id;
    if (targetId === '__new__') {
      const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New changelist name'),
        ignoreFocusOut: true,
      });
      if (name === undefined || name.trim().length === 0) return;
      targetId = service.create(name.trim()).id;
    }
    service.moveFiles(
      files.map((f) => f.relPath),
      targetId,
    );
  });

  // Attach acceptInputCommand + template prefill per repo.
  const attach = (repo: RepoHandle): void => {
    const sc = scFor(repo);
    if (sc) {
      sc.sc.acceptInputCommand = {
        command: 'gittree.commit',
        title: vscode.l10n.t('Commit'),
        arguments: [repo.root],
      };
    }
    const box = messageBoxFor(repo);
    if (box) void history.applyTemplate(repo, box);
  };
  for (const repo of core.repos) attach(repo);
  const addSub2 = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub2.dispose()));

  register('gittree.commit.window.toggle', async () => {
    const config = vscode.workspace.getConfiguration('gittree');
    const next = commitWindowMode() === 'webview' ? 'native' : 'webview';
    await config.update('commit.window', next, vscode.ConfigurationTarget.Global);
  });

  const registry: Phase03Registry = {
    paradigm,
    commitService,
    pipeline,
    history,
    changelistsFor,
    viewProvider,
    commitWindow,
    commitWindowMode,
    inclusion,
  };
  core.debugRegistry.set('phase03', registry);
  return registry;
}

/** Re-exported for the unstage-on-switch confirm (kept here for cohesion). */
export { confirmModal };
