/**
 * Post-rewrite push safety (P5-T6): after a successful rewrite on a branch
 * with an upstream, the one-time explanatory toast offering
 * `gittree.pushForceWithLease` (never plain --force), gated by the "after
 * rewrite: ask/never" setting.
 *
 * POST-QA F2: a force push is needed only when the rewrite replaced commits
 * that were already on the upstream. The old test — "the upstream is not an
 * ancestor of HEAD" — is also true whenever a teammate has pushed, so
 * rewording a commit nobody had seen offered to force-push over theirs, on
 * `main` as well. Now the question is asked of the commit the branch shared
 * with its upstream before the rewrite: still in HEAD, nothing published was
 * touched and a normal push (after a pull) is all it takes. And a protected
 * branch, or an upstream with commits the branch never took in, is said so
 * instead of offered a force push that would delete them.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { Emitter, type Event } from '../core/util/events';
import { DEFAULT_PROTECTED_BRANCHES } from '../scm/dialogs/pushModel';
import { upstreamRef } from './publishedGuard';
import { pushNeedAfterRewrite } from './pushNeed';

export interface PushSafetyOffer {
  repo: RepoHandle;
  upstream: string;
}

async function git(repo: RepoHandle, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return repo.queue.enqueue({
    label: 'push safety',
    kind: 'read',
    run: (g, token) =>
      g.exec(repo.root, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true, token }),
  });
}

/** HEAD's sha, or undefined on an unborn branch. */
export async function headSha(repo: RepoHandle): Promise<string | undefined> {
  const res = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  const sha = res.stdout.trim();
  return res.exitCode === 0 && sha.length > 0 ? sha : undefined;
}

function protectedPatterns(): string[] {
  return vscode.workspace
    .getConfiguration('gittree')
    .get<string[]>('protectedBranches', [...DEFAULT_PROTECTED_BRANCHES]);
}

export class PushSafetyService {
  /** One toast per (repo, upstream tip) — repeated rewrites don't stack. */
  private readonly offered = new Set<string>();
  private readonly _onDidOffer = new Emitter<PushSafetyOffer>();
  readonly onDidOffer: Event<PushSafetyOffer> = this._onDidOffer.event;

  constructor(private readonly core: Core) {}

  /**
   * Call after a successful rewrite with the HEAD it started from; decides
   * whether to say anything about the next push.
   */
  async maybeOffer(repo: RepoHandle, preHead: string | undefined): Promise<void> {
    const mode = vscode.workspace
      .getConfiguration('gittree.pushSafety')
      .get<'ask' | 'never'>('afterRewrite', 'ask');
    if (mode === 'never' || preHead === undefined) return;

    const upstream = await upstreamRef(repo);
    if (upstream === undefined) return;
    const patterns = protectedPatterns();
    const need = await repo.queue.enqueue({
      label: 'push safety',
      kind: 'read',
      run: (g, token) => pushNeedAfterRewrite(g, repo.root, upstream, preHead, patterns, token),
    });
    if (need === 'none') return;

    const upstreamSha = await git(repo, ['rev-parse', upstream]);
    const key = `${canonicalKey(repo.root)}@${upstreamSha.stdout.trim()}@${await headSha(repo)}`;
    if (this.offered.has(key)) return;
    this.offered.add(key);

    const branch = repo.model.snapshot.headRef ?? 'HEAD';
    if (need === 'protected') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          '"{0}" now differs from {1} in commits that were already pushed. {1} is a protected branch, so it cannot be force-pushed.',
          branch,
          upstream,
        ),
      );
      return;
    }
    if (need === 'force-would-lose') {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          '"{0}" now differs from {1} in commits that were already pushed, and {1} also has commits that "{0}" does not. A force push would delete them: bring them in first.',
          branch,
          upstream,
        ),
      );
      return;
    }

    this._onDidOffer.fire({ repo, upstream });

    const seam = process.env['GITTREE_TEST_PUSHSAFETY_CHOICE'];
    if (seam !== undefined) {
      if (seam === 'push') {
        await vscode.commands.executeCommand('gittree.pushForceWithLease', repo.root);
      }
      return;
    }

    const pushAction = vscode.l10n.t('Push --force-with-lease');
    const never = vscode.l10n.t("Don't ask again");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        '"{0}" was rewritten and has diverged from {1}. The remote needs a force push — with lease, so it refuses if someone else pushed meanwhile.',
        branch,
        upstream,
      ),
      pushAction,
      never,
    );
    if (choice === pushAction) {
      await vscode.commands.executeCommand('gittree.pushForceWithLease', repo.root);
    } else if (choice === never) {
      await vscode.workspace
        .getConfiguration('gittree.pushSafety')
        .update('afterRewrite', 'never', vscode.ConfigurationTarget.Global);
    }
  }

  dispose(): void {
    this._onDidOffer.dispose();
  }
}
