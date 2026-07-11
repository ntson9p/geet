/**
 * Commit MVP (P1-T7): SCM input box → commit. Superseded by the full P3
 * pipeline; the command id `gittree.commit` stays stable. Commits staged
 * files, or all tracked changes after a modal confirm when nothing is
 * staged (IntelliJ's "commit all" default posture).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { isStaged } from '../core/model/statusEntry';
import { confirmModal } from '../ui/confirm';
import type { GitTreeSourceControl } from './sourceControl';

export function registerCommitMvp(
  context: vscode.ExtensionContext,
  core: Core,
  scFor: (root: string) => GitTreeSourceControl | undefined,
): void {
  const attach = (root: string): void => {
    const sc = scFor(root);
    if (sc && !sc.sc.acceptInputCommand) {
      sc.sc.acceptInputCommand = {
        command: 'gittree.commit',
        title: vscode.l10n.t('Commit'),
        arguments: [root],
      };
    }
  };
  for (const repo of core.repos) attach(repo.root);
  const addSub = core.onDidAddRepo((repo) => attach(repo.root));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  async function commit(repo: RepoHandle, amend: boolean): Promise<void> {
    const sc = scFor(repo.root);
    const message = sc?.sc.inputBox.value.trim() ?? '';
    if (message.length === 0 && !amend) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Enter a commit message first.'));
      return;
    }
    const snap = repo.model.snapshot;
    const hasStaged = snap.statusEntries.some(isStaged);
    const hasTrackedChanges = snap.statusEntries.some(
      (e) => e.kind !== 'untracked' && e.kind !== 'ignored',
    );

    const args = ['commit'];
    if (amend) {
      args.push('--amend');
      if (message.length === 0) {
        args.push('--no-edit');
      }
    } else if (!hasStaged) {
      if (!hasTrackedChanges) {
        void vscode.window.showInformationMessage(vscode.l10n.t('No changes to commit.'));
        return;
      }
      const ok = await confirmModal(
        vscode.l10n.t('Nothing is staged. Commit all tracked changes?'),
        '',
        vscode.l10n.t('Commit All'),
      );
      if (!ok) return;
      args.push('--all');
    }
    if (message.length > 0) {
      args.push('-m', message);
    }

    await repo.queue.enqueue({
      label: amend ? vscode.l10n.t('Commit (amend)') : vscode.l10n.t('Commit'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, args, { token });
      },
    });
    if (sc) sc.sc.inputBox.value = '';
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.commit', async (repoRoot?: unknown) => {
      const repo =
        (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? core.repos[0];
      if (repo) await commit(repo, false);
    }),
    vscode.commands.registerCommand('gittree.commitAmend', async (repoRoot?: unknown) => {
      const repo =
        (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? core.repos[0];
      if (repo) await commit(repo, true);
    }),
  );
}
