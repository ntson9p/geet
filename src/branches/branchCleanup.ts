/**
 * Clean Up Branches… (new-way-4): the local branches that look finished —
 * merged into the main branch, or tracking a remote branch the hosting site
 * deleted — listed for one pick, deleted in one go, restorable from the
 * notification that says it is done.
 *
 * The merged ones start ticked: deleting them loses nothing. The ones whose
 * remote branch is gone but whose commits are not on the main branch (a squash
 * or rebase merge leaves exactly that) are listed unticked, and ticking any
 * of them asks once more before they go.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { repoLabels, sortRootsByLabel } from '../core/util/repoLabels';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import { notifySuccess } from '../ui/notify';
import { reposOf } from './panelActions';
import {
  cleanupCandidates,
  mainBranchOf,
  mergedArgs,
  mergedBranches,
  preTicked,
  type CleanupCandidate,
} from './panelState';
import { showInfo } from '../ui/notices';

interface Pick extends vscode.QuickPickItem {
  readonly repo?: RepoHandle;
  readonly candidate?: CleanupCandidate;
}

interface Deleted {
  readonly repo: RepoHandle;
  readonly name: string;
  readonly sha: string;
  readonly upstream?: string;
}

async function mergedIn(
  repo: RepoHandle,
): Promise<{ main?: string; mainSha?: string; names: string[] }> {
  const snap = repo.model.snapshot;
  const main = mainBranchOf(snap.refs);
  if (main === undefined) return { names: [] };
  const mainSha = snap.refs.find(
    (r) => (r.type === 'remote' || r.type === 'head') && r.name === main,
  )?.sha;
  const res = await repo.queue.enqueue({
    label: 'merged branches',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, mergedArgs(main), {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return {
    main,
    ...(mainSha !== undefined ? { mainSha } : {}),
    names: res.exitCode === 0 ? mergedBranches(res.stdout, snap.refs, main) : [],
  };
}

/** `roots` limits it to those repositories; without them, every one. */
export async function cleanUpBranches(core: Core, roots?: readonly string[]): Promise<void> {
  const all = core.repos.map((r) => r.root);
  const labels = repoLabels(all);
  const repos = roots !== undefined && roots.length > 0
    ? reposOf(core, roots)
    : reposOf(core, sortRootsByLabel(all));
  const groups: Array<{ repo: RepoHandle; main?: string; candidates: CleanupCandidate[] }> = [];
  for (const repo of repos) {
    const { main, mainSha, names } = await mergedIn(repo);
    const candidates = cleanupCandidates(repo.model.snapshot.refs, names, mainSha);
    if (candidates.length > 0) groups.push({ repo, ...(main !== undefined ? { main } : {}), candidates });
  }
  if (groups.length === 0) {
    showInfo(
      vscode.l10n.t('Nothing to clean up: no branch is merged into the main branch or has lost its remote branch.'),
    );
    return;
  }

  const items: Pick[] = [];
  for (const { repo, main, candidates } of groups) {
    if (repos.length > 1) {
      items.push({ label: labels.get(repo.root) ?? repo.root, kind: vscode.QuickPickItemKind.Separator });
    }
    for (const c of candidates) {
      items.push({
        label: `$(git-branch) ${c.name}`,
        description: c.atMain
          ? vscode.l10n.t('same commit as {0}', main ?? 'the main branch')
          : c.merged
            ? vscode.l10n.t('merged into {0}', main ?? 'the main branch')
            : vscode.l10n.t('remote branch deleted · not merged'),
        picked: preTicked(c),
        repo,
        candidate: c,
      });
    }
  }
  // Test seam: `names:a,b` picks those branches, as if ticked by hand.
  const seeded = process.env['GITTREE_TEST_CLEANUP'];
  const named = seeded?.startsWith('names:') === true ? new Set(seeded.slice(6).split(',')) : undefined;
  const picked: readonly Pick[] | undefined =
    named !== undefined
      ? items.filter((i) => i.candidate !== undefined && named.has(i.candidate.name))
      : await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: vscode.l10n.t('Clean Up Branches'),
            placeHolder: vscode.l10n.t('Branches to delete — the merged ones are ticked'),
          });
  const chosen = (picked ?? []).filter(
    (p): p is Pick & { repo: RepoHandle; candidate: CleanupCandidate } =>
      p.repo !== undefined && p.candidate !== undefined,
  );
  if (chosen.length === 0) return;

  const unmerged = chosen.filter((p) => !p.candidate.merged);
  if (unmerged.length > 0) {
    const ok = await confirmModal(
      vscode.l10n.t('Delete {0} branches?', chosen.length),
      vscode.l10n.t(
        '{0} of them are not merged into the main branch: their commits will only be reachable from the reflog. The notification after deleting offers Restore.',
        unmerged.length,
      ),
      vscode.l10n.t('Delete'),
    );
    if (!ok) return;
  }

  const deleted: Deleted[] = [];
  const byRepo = new Map<RepoHandle, CleanupCandidate[]>();
  for (const p of chosen) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p.candidate]);
  for (const [repo, list] of byRepo) {
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Delete {0} branches', list.length),
        kind: 'mutate',
        isDestructive: list.some((c) => !c.merged),
        snapshotLabel: SNAPSHOT_LABELS.branchForceDelete,
        // `-D`: each was checked against the main branch here, or confirmed.
        // `-d` would judge "merged" against HEAD instead and refuse branches
        // merged on the main branch while another one is checked out.
        run: async (git, token) => {
          await git.exec(repo.root, ['branch', '-D', '--', ...list.map((c) => c.name)], { token });
        },
      });
      deleted.push(
        ...list.map((c) => ({
          repo,
          name: c.name,
          sha: c.sha,
          ...(c.upstream !== undefined ? { upstream: c.upstream } : {}),
        })),
      );
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '';
      void vscode.window.showErrorMessage(
        vscode.l10n.t('{0}: {1}', labels.get(repo.root) ?? repo.root, reason),
      );
    } finally {
      // Before the notification: its Restore asks the snapshot whether a branch
      // of that name has appeared since, and these must not still look present.
      await repo.refresher.refreshNow();
    }
  }
  if (deleted.length === 0) return;
  notifySuccess(
    deleted.length === 1
      ? vscode.l10n.t('Deleted branch {0}', deleted[0]!.name)
      : vscode.l10n.t('Deleted {0} branches', deleted.length),
    { title: vscode.l10n.t('Restore'), run: () => restore(deleted) },
  );
}

/**
 * Every deleted branch back at its old tip, tracking what it tracked — unless a
 * branch of that name has appeared since.
 */
async function restore(deleted: readonly Deleted[]): Promise<void> {
  let restored = 0;
  for (const d of deleted) {
    if (d.repo.model.snapshot.refs.some((r) => r.type === 'head' && r.name === d.name)) continue;
    try {
      await d.repo.queue.enqueue({
        label: vscode.l10n.t('Restore branch {0}', d.name),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(d.repo.root, ['branch', '--', d.name, d.sha], { token });
          if (d.upstream !== undefined) {
            // The remote branch may be gone by now; the branch itself is back either way.
            await git.exec(d.repo.root, ['branch', `--set-upstream-to=${d.upstream}`, '--', d.name], {
              token,
              allowNonZeroExit: true,
            });
          }
        },
      });
      restored++;
    } catch {
      // Its commit was pruned meanwhile; the others still come back.
    }
  }
  if (restored > 0) {
    notifySuccess(
      restored === 1
        ? vscode.l10n.t('Restored branch {0}', deleted[0]!.name)
        : vscode.l10n.t('Restored {0} branches', restored),
    );
  }
}
