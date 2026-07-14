/**
 * Phase 6 registration (T1 slice — conflict sessions + Conflicts view;
 * T2..T7 extend this file with the merge computation, tri-editor, chevrons,
 * magic wand, native bridge and lifecycle routing).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { confirmModal } from '../ui/confirm';
import { ConflictSession, isSpecialConflict, type ConflictSource } from './conflictSession';
import { ConflictsViewProvider, type ConflictNode } from './conflictsView';
import { MergeComputer, type MergeExec } from './mergeCompute';

export function registerPhase06MergeEngine(context: vscode.ExtensionContext, core: Core): void {
  const sessions = new Map<string, ConflictSession>();
  const viewProvider = new ConflictsViewProvider();
  const view = vscode.window.createTreeView('gittree.conflicts', {
    treeDataProvider: viewProvider,
  });
  context.subscriptions.push(view);

  const pushSessions = (): void => {
    viewProvider.setSessions([...sessions.values()]);
    const any = [...sessions.values()].some((s) => s.remaining > 0);
    const canContinue = [...sessions.values()].some((s) => s.remaining === 0);
    void vscode.commands.executeCommand('setContext', 'gittree.hasConflicts', any || sessions.size > 0);
    void vscode.commands.executeCommand('setContext', 'gittree.conflicts.canContinue', canContinue);
  };

  const sourceOf = (repo: RepoHandle): ConflictSource => {
    switch (repo.model.snapshot.inProgressOp?.kind) {
      case 'merge':
        return 'merge';
      case 'rebase-interactive':
      case 'rebase-apply':
        return 'rebase';
      case 'cherry-pick':
        return 'cherry-pick';
      case 'revert':
        return 'revert';
      case undefined:
      default:
        // No op marker: stash-pop / checkout -m style conflicts (T7 refines).
        return 'checkout-merge';
    }
  };

  const evaluate = (repo: RepoHandle): void => {
    const key = canonicalKey(repo.root);
    const existing = sessions.get(key);
    const unmerged = repo.model.snapshot.statusEntries.filter((e) => e.kind === 'unmerged').length;
    if (!existing && unmerged > 0) {
      const session = new ConflictSession(repo, sourceOf(repo));
      sessions.set(key, session);
      pushSessions();
      // IntelliJ Conflicts-dialog parity: reveal + one-shot toast.
      void vscode.commands.executeCommand('gittree.conflicts.focus');
      const show = vscode.l10n.t('Show Conflicts');
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t('{0} produced {1} conflicted file(s).', session.source, unmerged),
          show,
        )
        .then((choice) => {
          if (choice === show) return vscode.commands.executeCommand('gittree.conflicts.focus');
          return undefined;
        });
      session.onDidChange(() => pushSessions());
      session.onDidResolveAll(() => {
        pushSessions();
        if (session.source === 'checkout-merge') return;
        const cont = vscode.l10n.t('Continue {0}', session.source);
        void vscode.window
          .showInformationMessage(vscode.l10n.t('All conflicts resolved.'), cont)
          .then((choice) => {
            if (choice === cont) return session.continueOp();
            return undefined;
          });
      });
      return;
    }
    if (existing && unmerged === 0 && repo.model.snapshot.inProgressOp === undefined) {
      existing.dispose();
      sessions.delete(key);
      pushSessions();
      return;
    }
    if (existing) pushSessions();
  };

  const attach = (repo: RepoHandle): void => {
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('status') || sections.has('op')) evaluate(repo);
      }),
    );
    evaluate(repo);
  };
  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));
  context.subscriptions.push(
    new vscode.Disposable(() => {
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
    }),
  );

  // ---- commands -------------------------------------------------------------
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  const sessionFor = (arg?: unknown): ConflictSession | undefined => {
    if (typeof arg === 'string') return sessions.get(canonicalKey(arg));
    if (typeof arg === 'object' && arg !== null && 'session' in arg) {
      return (arg as ConflictNode).session;
    }
    return [...sessions.values()][0];
  };

  /** Delete/mode conflicts: tailored QuickPick instead of the tri-editor. */
  const resolveSpecial = async (node: ConflictNode): Promise<void> => {
    interface Choice extends vscode.QuickPickItem {
      keep: 'deleted' | 'file';
      side?: 'ours' | 'theirs';
    }
    const choices: Choice[] = [];
    if (node.kind === 'deleted-by-us') {
      choices.push(
        { label: vscode.l10n.t('$(trash) Keep deleted (your side)'), keep: 'deleted' },
        { label: vscode.l10n.t('$(file) Keep their file'), keep: 'file', side: 'theirs' },
      );
    } else if (node.kind === 'deleted-by-them') {
      choices.push(
        { label: vscode.l10n.t('$(file) Keep your file'), keep: 'file', side: 'ours' },
        { label: vscode.l10n.t('$(trash) Keep deleted (their side)'), keep: 'deleted' },
      );
    } else if (node.kind === 'both-deleted') {
      choices.push({ label: vscode.l10n.t('$(trash) Confirm deletion'), keep: 'deleted' });
    } else {
      choices.push(
        { label: vscode.l10n.t('$(arrow-left) Keep yours (mode/content)'), keep: 'file', side: 'ours' },
        { label: vscode.l10n.t('$(arrow-right) Keep theirs (mode/content)'), keep: 'file', side: 'theirs' },
      );
    }
    const seeded = process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    const picked =
      seeded !== undefined
        ? choices[Number.parseInt(seeded, 10)]
        : await vscode.window.showQuickPick(choices, {
            placeHolder: vscode.l10n.t('Resolve {0}', node.path),
          });
    if (picked) await node.session.resolveSpecial(node.path, picked.keep, picked.side);
  };

  /** Queue-routed read seam for the merge computer (P6-T2). */
  const mergeExecFor = (repo: RepoHandle): MergeExec => (args) =>
    repo.queue.enqueue({
      label: 'merge compute read',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, args, {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });

  /** Binary / oversized conflicts: whole-file side pick instead of an editor. */
  const resolveBinary = async (node: ConflictNode, why: 'binary' | 'too-large'): Promise<void> => {
    interface Choice extends vscode.QuickPickItem {
      side: 'ours' | 'theirs';
    }
    const choices: Choice[] = [
      { label: vscode.l10n.t('$(arrow-left) Keep your version'), side: 'ours' },
      { label: vscode.l10n.t('$(arrow-right) Keep their version'), side: 'theirs' },
    ];
    const seeded = process.env['GITTREE_TEST_SPECIAL_CHOICE'];
    const picked =
      seeded !== undefined
        ? choices[Number.parseInt(seeded, 10)]
        : await vscode.window.showQuickPick(choices, {
            placeHolder:
              why === 'binary'
                ? vscode.l10n.t('{0} is binary — pick the version to keep', node.path)
                : vscode.l10n.t('{0} is too large to merge in the editor — pick a version', node.path),
          });
    if (picked) await node.session.acceptSide([node.path], picked.side);
  };

  register('gittree.merge.open', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) {
      await resolveSpecial(node);
      return;
    }
    const computer = new MergeComputer(mergeExecFor(node.session.repo));
    const input = await computer.compute(node.path);
    if (input.kind === 'binary' || input.kind === 'too-large') {
      await resolveBinary(node, input.kind);
      return;
    }
    // T3 replaces this placeholder with the tri-editor.
    void vscode.window.showInformationMessage(
      vscode.l10n.t('The 3-pane merge editor for {0} lands with P6-T3.', node.path),
    );
  });
  register('gittree.merge.acceptYoursFile', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) return resolveSpecial(node);
    await node.session.acceptSide([node.path], 'ours');
  });
  register('gittree.merge.acceptTheirsFile', async (arg) => {
    const node = arg as ConflictNode | undefined;
    if (!node || !('path' in node)) return;
    if (isSpecialConflict(node.kind)) return resolveSpecial(node);
    await node.session.acceptSide([node.path], 'theirs');
  });
  register('gittree.merge.acceptAllYours', async (arg) => {
    const session = sessionFor(arg);
    if (!session) return;
    const paths = session.files().filter((f) => !isSpecialConflict(f.kind)).map((f) => f.path);
    const ok = await confirmModal(
      vscode.l10n.t('Accept YOUR version for {0} file(s)?', paths.length),
      vscode.l10n.t('Their changes to these files are discarded (Local History keeps a snapshot).'),
      vscode.l10n.t('Accept All Yours'),
    );
    if (ok) await session.acceptSide(paths, 'ours');
  });
  register('gittree.merge.acceptAllTheirs', async (arg) => {
    const session = sessionFor(arg);
    if (!session) return;
    const paths = session.files().filter((f) => !isSpecialConflict(f.kind)).map((f) => f.path);
    const ok = await confirmModal(
      vscode.l10n.t('Accept THEIR version for {0} file(s)?', paths.length),
      vscode.l10n.t('Your changes to these files are discarded (Local History keeps a snapshot).'),
      vscode.l10n.t('Accept All Theirs'),
    );
    if (ok) await session.acceptSide(paths, 'theirs');
  });
  register('gittree.merge.continueOp', async (arg) => {
    await sessionFor(arg)?.continueOp();
  });
  register('gittree.merge.abortOp', async (arg) => {
    await sessionFor(arg)?.abortOp();
  });

  core.debugRegistry.set('phase06', {
    getSession: (repoRoot: string) => sessions.get(canonicalKey(repoRoot)),
    viewProvider,
  });
}
