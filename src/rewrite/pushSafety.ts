/**
 * Post-rewrite push safety (P5-T6): after any successful rewrite on a branch
 * with an upstream, the status widget already shows the diverged arrows —
 * this adds the one-time explanatory toast offering `gittree.pushForceWithLease`
 * (never plain --force), gated by the "after rewrite: ask/never" setting.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { Emitter, type Event } from '../core/util/events';
import { upstreamRef } from './publishedGuard';

export interface PushSafetyOffer {
  repo: RepoHandle;
  upstream: string;
}

export class PushSafetyService {
  /** One toast per (repo, upstream tip) — repeated rewrites don't stack. */
  private readonly offered = new Set<string>();
  private readonly _onDidOffer = new Emitter<PushSafetyOffer>();
  readonly onDidOffer: Event<PushSafetyOffer> = this._onDidOffer.event;

  constructor(private readonly core: Core) {}

  /** Call after a successful rewrite; decides whether to offer the push. */
  async maybeOffer(repo: RepoHandle): Promise<void> {
    const mode = vscode.workspace
      .getConfiguration('gittree.pushSafety')
      .get<'ask' | 'never'>('afterRewrite', 'ask');
    if (mode === 'never') return;

    const upstream = await upstreamRef(repo);
    if (upstream === undefined) return;

    // Diverged = the upstream tip is no longer an ancestor of the rewritten
    // HEAD; a plain push would be rejected and a force is genuinely needed.
    const ancestry = await repo.queue.enqueue({
      label: 'push safety (divergence check)',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['merge-base', '--is-ancestor', upstream, 'HEAD'], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    if (ancestry.exitCode === 0) return; // still fast-forwardable — no force needed

    const upstreamSha = await repo.queue.enqueue({
      label: 'push safety (upstream tip)',
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['rev-parse', upstream], {
          structured: true,
          noOptionalLocks: true,
          allowNonZeroExit: true,
          token,
        }),
    });
    const key = `${canonicalKey(repo.root)}@${upstreamSha.stdout.trim()}`;
    if (this.offered.has(key)) return;
    this.offered.add(key);

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
        repo.model.snapshot.headRef ?? 'HEAD',
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
