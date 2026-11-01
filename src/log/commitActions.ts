/**
 * Commit actions & navigation wiring (P4-T5): the webview/context menu
 * commands. Handlers receive the row's data-vscode-context payload
 * ({sha, shas}). Reset-hard is destructive-flagged; multi-select rewrite
 * entries are reserved for P5 behind gittree:rewriteReady.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { notifySuccess } from '../ui/notify';
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

  register('gittree.log.refresh', () => {
    logView.refresh();
  });
  register('gittree.log.revealCommit', async (sha, repoRoot) => {
    const s = shaOf(sha);
    if (s !== undefined) {
      await logView.revealCommit(s, typeof repoRoot === 'string' ? repoRoot : undefined);
    }
  });

  // IntelliJ's Copy Revision Number: several hashes go on one line, spaced,
  // in the order the log lists them.
  register('gittree.log.copySha', async (arg) => {
    const ctx = arg as CommitContext | undefined;
    const text = (ctx?.shas && ctx.shas.length > 1 ? ctx.shas : [shaOf(arg) ?? '']).join(' ');
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
    notifySuccess(vscode.l10n.t('Branch {0} was created', name.trim()));
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
    notifySuccess(vscode.l10n.t('Created tag {0}', name.trim()));
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
    notifySuccess(vscode.l10n.t('Checked out {0}', sha.slice(0, 8)));
  });

  register('gittree.log.resetHere', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    interface ModeItem extends vscode.QuickPickItem {
      mode: 'soft' | 'mixed' | 'hard' | 'keep';
    }
    const items: ModeItem[] = [
      { label: vscode.l10n.t('Soft — keep index and worktree'), mode: 'soft' },
      { label: vscode.l10n.t('Mixed — keep worktree, reset index'), mode: 'mixed' },
      { label: vscode.l10n.t('Hard — discard EVERYTHING after {0}', sha.slice(0, 7)), mode: 'hard' },
      // P12-T7.6: git's fourth mode, previously missing everywhere — moves
      // HEAD but REFUSES rather than discard local changes.
      { label: vscode.l10n.t('Keep — like hard, but refuses to touch local changes'), mode: 'keep' },
    ];
    const testMode = process.env['GITTREE_TEST_RESET_MODE'];
    const picked =
      testMode === 'soft' || testMode === 'mixed' || testMode === 'hard' || testMode === 'keep'
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
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Reset ({0}) to {1}', picked.mode, sha.slice(0, 7)),
        kind: 'mutate',
        isDestructive: picked.mode === 'hard' || picked.mode === 'keep',
        ...(picked.mode === 'hard' || picked.mode === 'keep'
          ? { snapshotLabel: SNAPSHOT_LABELS.reset, snapshotAfter: true }
          : {}),
        run: async (git, token) => {
          await git.exec(repo.root, ['reset', `--${picked.mode}`, sha], { token });
        },
      });
      // IntelliJ's `GitResetOperation`.
      notifySuccess(vscode.l10n.t('Reset successful'));
    } catch (err) {
      // `--keep` refusing to discard local changes is the point of the mode;
      // surface git's own reason instead of a stack trace.
      if (picked.mode === 'keep' && err instanceof GitError) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Reset --keep refused: {0}',
            err.stderr.split('\n').find((l) => l.trim().length > 0) ?? 'local changes would be lost',
          ),
        );
        return;
      }
      throw err;
    }
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

  /**
   * IntelliJ's Compare Versions, offered when exactly two commits are
   * selected: every file that differs between them, from the lower one in
   * the log to the upper one, kept to the log's path filter as IntelliJ keeps
   * it to the affected paths.
   */
  register('gittree.log.compareVersions', async (arg) => {
    const shas = (arg as CommitContext | undefined)?.shas;
    const repo = repoOf();
    if (!repo || !Array.isArray(shas) || shas.length !== 2) return;
    const [upper, lower] = shas as [string, string];
    const paths = logView.currentSession?.filter.paths ?? [];
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Compare {0} with {1}', lower.slice(0, 7), upper.slice(0, 7)),
      kind: 'read',
      run: (git, token) =>
        git.exec(
          repo.root,
          ['diff', '--name-status', '-z', '-M', lower, upper, ...(paths.length > 0 ? ['--', ...paths] : [])],
          { structured: true, noOptionalLocks: true, token },
        ),
    });
    const entries = parseNameStatusZ(result.stdout);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('{0} and {1} have the same content.', lower.slice(0, 7), upper.slice(0, 7)),
      );
      return;
    }
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = entries.map((e) => [
      vscode.Uri.file(path.join(repo.root, e.path)),
      e.status.startsWith('A') ? undefined : makeRevUri(repo.root, e.origPath ?? e.path, lower),
      e.status.startsWith('D') ? undefined : makeRevUri(repo.root, e.path, upper),
    ]);
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('Changes between {0} and {1}', lower.slice(0, 7), upper.slice(0, 7)),
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

  // An optional root, so a caller acting on one repository of several filters
  // *that* repository's log rather than whichever one the log shows (POST-P14ae:
  // Update Project's `Show in Log`, whose range exists only in its own repo).
  register('gittree.log.setFilter', async (filter, root) => {
    if (typeof filter === 'object' && filter !== null) {
      await logView.setFilter(filter as never, typeof root === 'string' ? root : undefined);
    }
  });

  // Internal: the same arguments, shown in a Log tab of its own (reused when
  // one already shows exactly that), so the active tab's filters survive.
  // What an update's Show in Log runs.
  register('gittree.log.openTab', async (filter, root) => {
    if (typeof filter === 'object' && filter !== null) {
      await logView.openTab(filter as never, typeof root === 'string' ? root : undefined);
    }
  });

  // P2-T5 upgrade: Compare with Current now routes into the filtered log
  // (range mode with side badges), in a Log tab of its own. Command id unchanged.
  register('gittree.branches.compareInLog', async (repoRoot, branch) => {
    const repo = (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? repoOf();
    if (!repo || typeof branch !== 'string') return;
    const current = repo.model.snapshot.headRef ?? 'HEAD';
    // Both sides of the range are `repo`'s branches; without the root the log
    // would run `--left-right a...b` in the focused editor's repository, where
    // neither name resolves and the page read fails outright.
    await logView.openTab({ sort: 'topo', range: { a: branch, b: current } }, repo.root);
  });

  // ---- P12-T7: the reference menu's missing items --------------------------

  const isAncestorOfHead = async (repo: RepoHandle, sha: string): Promise<boolean> => {
    const result = await repo.queue.enqueue({
      label: 'ancestor check',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['merge-base', '--is-ancestor', sha, 'HEAD'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    return result.exitCode === 0;
  };

  /** The ticked-paths target the shared commit flow would use (changelists). */
  const tickedPaths = (repo: RepoHandle): string[] => {
    const p3 = core.debugRegistry.get('phase03') as
      | {
          paradigm: { paradigm: 'changelists' | 'staging' };
          changelistsFor: (r: RepoHandle) => {
            getLists(): Array<{ checked: string[] }>;
            unversionedCheckedPaths(): string[];
          };
        }
      | undefined;
    if (!p3 || p3.paradigm.paradigm !== 'changelists') return [];
    const service = p3.changelistsFor(repo);
    return [...service.getLists().flatMap((l) => l.checked), ...service.unversionedCheckedPaths()];
  };

  /**
   * Fixup / Squash Into (step 2): commit the current inclusion set with
   * `--fixup`/`--squash`, then offer a non-interactive autosquash rebase onto
   * the target's parent. `GIT_SEQUENCE_EDITOR=:` accepts git's own generated
   * plan; git runs editors through its sh even on Windows, so `:` is safe.
   */
  const fixupLike = async (arg: unknown, mode: 'fixup' | 'squash'): Promise<void> => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    if (!(await isAncestorOfHead(repo, sha))) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          '{0} is not an ancestor of HEAD — a {1} commit could never be squashed into it.',
          sha.slice(0, 7),
          mode,
        ),
      );
      return;
    }
    const paths = tickedPaths(repo);
    await repo.queue.enqueue({
      label: vscode.l10n.t('Commit --{0}={1}', mode, sha.slice(0, 7)),
      kind: 'mutate',
      run: async (git, token) => {
        const args = ['commit', `--${mode}=${sha}`];
        if (paths.length > 0) args.push('--only', '--', ...paths);
        await git.exec(repo.root, args, { token });
      },
    });
    await repo.refresher.refreshNow();

    const doRebase =
      process.env['GITTREE_TEST_AUTOSQUASH'] === 'yes'
        ? true
        : process.env['GITTREE_TEST_AUTOSQUASH'] === 'no'
          ? false
          : (await vscode.window.showInformationMessage(
              vscode.l10n.t('{0} commit created. Run rebase --autosquash now?', mode),
              vscode.l10n.t('Rebase Now'),
            )) !== undefined;
    if (!doRebase) return;
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('rebase --autosquash onto {0}^', sha.slice(0, 7)),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.rebaseStart,
        run: async (git, token) => {
          await git.exec(repo.root, ['rebase', '--interactive', '--autosquash', '--autostash', `${sha}^`], {
            env: { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' },
            token,
          });
        },
      });
      notifySuccess(
        vscode.l10n.t('Rebase successful: the {0} commit was folded into {1}', mode, sha.slice(0, 8)),
      );
    } catch (err) {
      // A conflicted autosquash pauses the rebase — the P5 monitor and P6
      // conflict flow own it from here; say so instead of failing silently.
      void vscode.window.showWarningMessage(
        vscode.l10n.t('Autosquash paused: {0}', err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)),
      );
    }
    await repo.refresher.refreshNow();
  };
  register('gittree.log.fixup', (arg) => fixupLike(arg, 'fixup'));
  register('gittree.log.squashInto', (arg) => fixupLike(arg, 'squash'));

  /**
   * Push All up to Here… — IntelliJ's `GitPushUpToCommitAction`: the Push
   * dialog with the commit as its source, so the commits that would go are
   * listed, and the target can still be changed, before anything is pushed.
   */
  register('gittree.log.pushAllUpToHere', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    await vscode.commands.executeCommand('gittree.push.upTo', repo.root, sha);
  });

  /**
   * Branches › (step 4): lazy `--contains` list, each ref offering the shared
   * registry's checkout / new-branch-from / compare. QuickPick stands in for
   * the submenu — native webview menus cannot nest dynamically (D3).
   */
  register('gittree.log.commitBranches', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const [branches, tags] = await Promise.all([
      logView.logServiceFor(repo).getContainingBranches(sha),
      repo.queue.enqueue({
        label: 'tag --contains',
        kind: 'read',
        run: (git, token) =>
          git.exec(repo.root, ['tag', '--contains', sha], {
            structured: true,
            noOptionalLocks: true,
            allowNonZeroExit: true,
            token,
          }),
      }).then((r) => (r.exitCode === 0 ? r.stdout.split('\n').filter((l) => l.trim().length > 0) : [])),
    ]);
    interface RefItem extends vscode.QuickPickItem {
      ref: string;
      type: 'local' | 'tag';
    }
    const items: RefItem[] = [
      ...branches.map((b): RefItem => ({ label: `$(git-branch) ${b}`, ref: b, type: 'local' })),
      ...tags.map((t): RefItem => ({ label: `$(tag) ${t}`, ref: t, type: 'tag' })),
    ];
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('No branch or tag contains {0} yet.', sha.slice(0, 7)),
      );
      return;
    }
    const seededRef = process.env['GITTREE_TEST_COMMIT_BRANCH_PICK'];
    const pickedRef =
      seededRef !== undefined
        ? items.find((i) => i.ref === seededRef)
        : await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Branches containing {0}', sha.slice(0, 7)),
          });
    if (!pickedRef) return;
    interface ActionItem extends vscode.QuickPickItem {
      action: 'checkout' | 'newFrom' | 'compareWithCurrent';
    }
    const actions: ActionItem[] = [
      { label: vscode.l10n.t('Checkout'), action: 'checkout' },
      { label: vscode.l10n.t("New Branch from '{0}'…", pickedRef.ref), action: 'newFrom' },
      { label: vscode.l10n.t('Compare with Current'), action: 'compareWithCurrent' },
    ];
    const seededAction = process.env['GITTREE_TEST_COMMIT_BRANCH_ACTION'];
    const pickedAction =
      seededAction !== undefined
        ? actions.find((a) => a.action === seededAction)
        : await vscode.window.showQuickPick(actions, { placeHolder: pickedRef.ref });
    if (!pickedAction) return;
    await logView.branchesBridge.dispatch(repo, {
      action: pickedAction.action,
      name: pickedRef.ref,
      type: pickedRef.type,
    });
  });

  /** Go to Parent / Child (step 1). Child = a loaded row listing sha as parent. */
  register('gittree.log.goToParent', async (arg) => {
    const sha = shaOf(arg);
    const repo = repoOf();
    if (sha === undefined || !repo) return;
    const parents = await repo.queue.enqueue({
      label: 'read parents',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['rev-list', '--parents', '-1', sha], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const list = parents.stdout.trim().split(/\s+/u).slice(1);
    if (list.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('{0} is a root commit.', sha.slice(0, 7)));
      return;
    }
    const target =
      list.length === 1
        ? list[0]
        : await vscode.window.showQuickPick(list, {
            placeHolder: vscode.l10n.t('Merge commit — pick a parent'),
          });
    if (target !== undefined) await logView.revealCommit(target);
  });

  register('gittree.log.goToChild', async (arg) => {
    const sha = shaOf(arg);
    if (sha === undefined) return;
    const child = logView.findLoadedChild(sha);
    if (child === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('No loaded commit lists {0} as a parent (children load top-down).', sha.slice(0, 7)),
      );
      return;
    }
    await logView.revealCommit(child);
  });

  /** Create Patch… (step 1, over the T6 engine). */
  register('gittree.log.createPatch', async (arg) => {
    const ctx = arg as CommitContext | undefined;
    const repo = repoOf();
    const shas = ctx?.shas && ctx.shas.length > 0 ? ctx.shas : [shaOf(arg) ?? ''].filter((s) => s.length > 0);
    if (!repo || shas.length === 0) return;
    const { createPatchToFile } = await import('../rewrite/patch/createPatch');
    const seeded = process.env['GITTREE_TEST_CREATE_PATCH'];
    const target =
      seeded !== undefined
        ? vscode.Uri.file(seeded)
        : await vscode.window.showSaveDialog({
            filters: { [vscode.l10n.t('Patch files')]: ['patch'] },
            defaultUri: vscode.Uri.file(`${shas[0]!.slice(0, 7)}.patch`),
          });
    if (!target) return;
    await createPatchToFile(repo, { kind: 'commits', shas }, target.fsPath);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Patch with {0} commit(s) written to {1}.', shas.length, target.fsPath),
    );
  });

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
