/**
 * Commit actions & navigation wiring (P4-T5): the webview/context menu
 * commands. Handlers receive the row's data-vscode-context payload
 * ({sha, shas}). Reset-hard is destructive-flagged; multi-select rewrite
 * entries are reserved for P5 behind gittree:rewriteReady.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import { parseNameStatusZ } from '../branches/parsing';
import type { LogViewProvider } from './logView';

interface CommitContext {
  sha?: string;
  shas?: string[];
}

function shaOf(arg: unknown): string | undefined {
  if (typeof arg === 'object' && arg !== null && 'sha' in arg) {
    const sha = (arg as CommitContext).sha;
    if (typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
  }
  if (typeof arg === 'string' && /^[0-9a-f]{7,64}$/i.test(arg)) return arg;
  return undefined;
}

export function registerCommitActions(
  context: vscode.ExtensionContext,
  core: Core,
  logView: LogViewProvider,
): void {
  const repoOf = (): RepoHandle | undefined => {
    const root = logView.currentSession?.repoRoot;
    return (root !== undefined ? core.getRepo(root) : undefined) ?? core.repos[0];
  };
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('gittree.log.refresh', () => logView.refresh());
  register('gittree.log.revealCommit', async (sha, repoRoot) => {
    const s = shaOf(sha);
    if (s !== undefined) {
      await logView.revealCommit(s, typeof repoRoot === 'string' ? repoRoot : undefined);
    }
  });

  register('gittree.log.copySha', async (arg) => {
    const ctx = arg as CommitContext | undefined;
    const text = (ctx?.shas && ctx.shas.length > 1 ? ctx.shas : [shaOf(arg) ?? '']).join('\n');
    if (text.length > 0) await vscode.env.clipboard.writeText(text);
  });

  register('gittree.log.createBranchHere', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const name =
      process.env['GITTREE_TEST_BRANCH_NAME'] ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New branch at {0}', sha.slice(0, 7)),
        ignoreFocusOut: true,
      }));
    if (name === undefined || name.trim().length === 0) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Create branch {0}', name),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['branch', '--', name.trim(), sha], { token });
      },
    });
  });

  register('gittree.log.createTagHere', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const name =
      process.env['GITTREE_TEST_BRANCH_NAME'] ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New tag at {0}', sha.slice(0, 7)),
        ignoreFocusOut: true,
      }));
    if (name === undefined || name.trim().length === 0) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Create tag {0}', name),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['tag', '--', name.trim(), sha], { token });
      },
    });
  });

  register('gittree.log.checkoutRevision', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const ok = await confirmModal(
      vscode.l10n.t('Checkout revision {0}?', sha.slice(0, 7)),
      vscode.l10n.t('HEAD will be detached — new commits stay unless you create a branch.'),
      vscode.l10n.t('Checkout'),
    );
    if (!ok) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Checkout {0} (detached)', sha.slice(0, 7)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.checkoutDirty,
      snapshotAfter: true,
      run: async (git, token) => {
        await git.exec(repo.root, ['checkout', '--detach', sha], { token });
      },
    });
  });

  register('gittree.log.resetHere', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    interface ModeItem extends vscode.QuickPickItem {
      mode: 'soft' | 'mixed' | 'hard';
    }
    const items: ModeItem[] = [
      { label: vscode.l10n.t('Soft — keep index and worktree'), mode: 'soft' },
      { label: vscode.l10n.t('Mixed — keep worktree, reset index'), mode: 'mixed' },
      { label: vscode.l10n.t('Hard — discard EVERYTHING after {0}', sha.slice(0, 7)), mode: 'hard' },
    ];
    const testMode = process.env['GITTREE_TEST_RESET_MODE'];
    const picked =
      testMode === 'soft' || testMode === 'mixed' || testMode === 'hard'
        ? items.find((i) => i.mode === testMode)
        : await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Reset current branch to {0}', sha.slice(0, 7)),
          });
    if (!picked) return;
    if (picked.mode === 'hard') {
      const ok = await confirmModal(
        vscode.l10n.t('Hard reset to {0}?', sha.slice(0, 7)),
        vscode.l10n.t('Uncommitted changes are discarded. A Local History snapshot is taken first.'),
        vscode.l10n.t('Reset Hard'),
      );
      if (!ok) return;
    }
    await repo.queue.enqueue({
      label: vscode.l10n.t('Reset ({0}) to {1}', picked.mode, sha.slice(0, 7)),
      kind: 'mutate',
      isDestructive: picked.mode === 'hard',
      ...(picked.mode === 'hard' ? { snapshotLabel: SNAPSHOT_LABELS.reset, snapshotAfter: true } : {}),
      run: async (git, token) => {
        await git.exec(repo.root, ['reset', `--${picked.mode}`, sha], { token });
      },
    });
  });

  register('gittree.log.compareWithLocal', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Diff {0} with working tree', sha.slice(0, 7)),
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['diff', '--name-status', '-z', '-M', sha], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const entries = parseNameStatusZ(result.stdout);
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = entries.map((e) => {
      const fileUri = vscode.Uri.file(path.join(repo.root, e.path));
      const left = e.status === 'A' ? undefined : makeRevUri(repo.root, e.origPath ?? e.path, sha);
      const right = e.status === 'D' ? undefined : fileUri;
      return [fileUri, left, right];
    });
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('{0} ⟷ Working Tree', sha.slice(0, 7)),
      changes,
    );
  });

  register('gittree.log.openOnRemote', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const remote = await repo.queue.enqueue({
      label: 'read remote url',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['config', '--get', 'remote.origin.url'], {
          structured: true,
          allowNonZeroExit: true,
          noOptionalLocks: true,
          token,
        }),
    });
    if (remote.exitCode !== 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No origin remote configured.'));
      return;
    }
    const url = commitWebUrl(remote.stdout.trim(), sha);
    if (url === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Unrecognized remote host — cannot build a commit URL.'),
      );
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  register('gittree.log.setFilter', async (filter) => {
    if (typeof filter === 'object' && filter !== null) {
      await logView.setFilter(filter as never);
    }
  });

  // P2-T5 upgrade: Compare with Current now routes into the filtered log
  // (range mode with side badges). Command id unchanged.
  register('gittree.branches.compareInLog', async (repoRoot, branch) => {
    const repo = (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? repoOf();
    if (!repo || typeof branch !== 'string') return;
    const current = repo.model.snapshot.headRef ?? 'HEAD';
    await logView.setFilter({ sort: 'topo', range: { a: branch, b: current } });
  });

  void GitError; // (classification handled inside queue paths)
}

/** github/gitlab-style commit URL builders (capability-hidden otherwise). */
export function commitWebUrl(remoteUrl: string, sha: string): string | undefined {
  let host: string | undefined;
  let repoPath: string | undefined;
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(remoteUrl);
  const https = /^https?:\/\/([^/]+)\/(.+?)(\.git)?$/.exec(remoteUrl);
  if (ssh) {
    host = ssh[1];
    repoPath = ssh[2];
  } else if (https) {
    host = https[1];
    repoPath = https[2];
  }
  if (host === undefined || repoPath === undefined) return undefined;
  if (host.includes('github')) return `https://${host}/${repoPath}/commit/${sha}`;
  if (host.includes('gitlab')) return `https://${host}/${repoPath}/-/commit/${sha}`;
  return undefined;
}
