/**
 * Phase 7 registration (T1 service + T2 stashes view/commands; T3..T5 add
 * the shelf engine, view and unshelve).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { confirmModal, typedConfirm } from '../ui/confirm';
import type { ConflictSource } from '../merge/conflictSession';
import { StashService, type StashPushOptions } from './stashService';
import { relativeTime, stashDiffSides, StashViewProvider, type StashNode } from './stashView';

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
  const attach = (repo: RepoHandle): void => {
    const service = new StashService(repo, expectConflict);
    services.set(canonicalKey(repo.root), service);
    repo.disposables.add(service.onDidChange(() => viewProvider.refresh()));
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

  core.debugRegistry.set('phase07', {
    getStashService: (repoRoot: string) => services.get(canonicalKey(repoRoot)),
    stashViewProvider: viewProvider,
  });
}
