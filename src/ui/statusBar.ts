/**
 * Status-bar widget (P1-T5, re-hosted by P14-T4): branch + incoming/outgoing
 * arrows. Rendered through `window.createStatusBarItem` now that GitTree
 * registers no SourceControl — `statusBarCommands` was the old sink, and it
 * belonged to the SCM framework this phase removes. The pure render function
 * is unchanged and still carries the unit tests; only the sink moved.
 *
 * Only the active repository's items are visible. `statusBarCommands` was
 * scoped to the selected provider by VS Code; with plain items that scoping is
 * ours to do, and N repos × 3 items would otherwise fill the status bar.
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

/** Left-aligned, just left of where the built-in git extension puts its own. */
const BASE_PRIORITY = 100;

export class StatusBarController implements vscode.Disposable {
  private fetching = false;
  private readonly sub: { dispose(): void };
  private readonly items: vscode.StatusBarItem[] = [];

  constructor(
    private readonly repo: RepoHandle,
    private readonly isActive: () => boolean,
  ) {
    this.sub = repo.model.onDidChange(() => this.update());
    this.update();
  }

  setFetching(fetching: boolean): void {
    this.fetching = fetching;
    this.update();
  }

  /**
   * P14-T4 test seam: the item texts, in order. Replaces reading
   * `SourceControl.statusBarCommands[i].title`, which is what the P1 tests
   * asserted on before the SourceControl was deleted.
   */
  get titles(): string[] {
    return this.items.map((i) => i.text);
  }

  /** One item per command, created on demand and reused across updates. */
  private itemAt(index: number): vscode.StatusBarItem {
    let item = this.items[index];
    if (!item) {
      item = vscode.window.createStatusBarItem(
        `gittree.status.${index}`,
        vscode.StatusBarAlignment.Left,
        BASE_PRIORITY - index,
      );
      item.name = 'GitTree';
      this.items[index] = item;
    }
    return item;
  }

  update(): void {
    const snap = this.repo.model.snapshot;
    const state = renderStatusBar(snap, this.fetching);
    const commands: vscode.Command[] = [
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
    // P5-T1: rebase actions stay one click away while a rebase is running.
    const opKind = snap.inProgressOp?.kind;
    if (opKind === 'rebase-interactive' || opKind === 'rebase-apply') {
      commands.push({
        command: 'gittree.rebase.actions',
        title: '$(list-selection) ' + vscode.l10n.t('Rebase…'),
        tooltip: vscode.l10n.t('Continue, skip or abort the rebase'),
        arguments: [this.repo.root],
      });
    }
    const visible = this.isActive();
    commands.forEach((command, i) => {
      const item = this.itemAt(i);
      item.text = command.title;
      item.tooltip = command.tooltip;
      item.command = command;
      if (visible) item.show();
      else item.hide();
    });
    // A finished rebase drops the third command; its item must go with it.
    for (let i = commands.length; i < this.items.length; i++) this.items[i]?.hide();
  }

  dispose(): void {
    this.sub.dispose();
    for (const item of this.items) item.dispose();
  }
}
