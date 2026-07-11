/**
 * Status-bar widget (P1-T5): branch + incoming/outgoing arrows rendered
 * through SourceControl.statusBarCommands — the same slot the built-in git
 * extension uses, so takeover mode looks native. Pure render function is
 * unit-testable; the class only wires model → commands.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { RepoSnapshot } from '../core/model/repositoryModel';

export interface StatusBarState {
  checkoutText: string;
  checkoutTooltip: string;
  syncText: string;
  syncTooltip: string;
}

export function renderStatusBar(snap: RepoSnapshot, fetching: boolean): StatusBarState {
  let checkoutText: string;
  if (snap.detached) {
    checkoutText = `$(git-commit) ${(snap.headSha ?? '').slice(0, 7)}`;
  } else {
    checkoutText = `$(git-branch) ${snap.headRef ?? '…'}`;
  }
  if (snap.inProgressOp) {
    const op = snap.inProgressOp;
    const opName =
      op.kind === 'merge'
        ? 'MERGING'
        : op.kind === 'cherry-pick'
          ? 'CHERRY-PICKING'
          : op.kind === 'revert'
            ? 'REVERTING'
            : 'REBASING';
    const steps = op.step !== undefined && op.total !== undefined ? ` ${op.step}/${op.total}` : '';
    checkoutText += ` $(warning) ${opName}${steps}`;
  }

  let syncText: string;
  if (fetching) {
    syncText = '$(sync~spin)';
  } else if ((snap.ahead ?? 0) > 0 || (snap.behind ?? 0) > 0) {
    syncText = `$(arrow-down) ${snap.behind ?? 0} $(arrow-up) ${snap.ahead ?? 0}`;
  } else {
    syncText = '$(sync)';
  }

  const upstream = snap.upstream
    ? snap.upstreamGone
      ? vscode.l10n.t('Upstream {0} is gone', snap.upstream)
      : vscode.l10n.t('Synchronize with {0}', snap.upstream)
    : vscode.l10n.t('Publish branch');

  return {
    checkoutText,
    checkoutTooltip: vscode.l10n.t('GitTree: checkout branch…'),
    syncText,
    syncTooltip: upstream,
  };
}

export class StatusBarController implements vscode.Disposable {
  private fetching = false;
  private readonly sub: { dispose(): void };

  constructor(
    private readonly repo: RepoHandle,
    private readonly sc: vscode.SourceControl,
  ) {
    this.sub = repo.model.onDidChange(() => this.update());
    this.update();
  }

  setFetching(fetching: boolean): void {
    this.fetching = fetching;
    this.update();
  }

  update(): void {
    const state = renderStatusBar(this.repo.model.snapshot, this.fetching);
    this.sc.statusBarCommands = [
      {
        command: 'gittree.branches.open',
        title: state.checkoutText,
        tooltip: state.checkoutTooltip,
        arguments: [this.repo.root],
      },
      {
        command: 'gittree.sync',
        title: state.syncText,
        tooltip: state.syncTooltip,
        arguments: [this.repo.root],
      },
    ];
  }

  dispose(): void {
    this.sub.dispose();
  }
}
