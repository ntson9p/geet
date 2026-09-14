/**
 * Status-bar widget (P1-T5, re-hosted by P14-T4, reshaped by POST-P14r).
 *
 * The reshape answers a problem the first two versions had backwards. VS Code's
 * built-in Git extension already puts a branch name and ahead/behind counts in
 * the status bar, and it does that well. A second readout beside it is not
 * fidelity, it is a duplicate — and it was an *unbounded* duplicate, which is
 * what made the branch widget appear to vanish after a fetch.
 *
 * IntelliJ's widget and VS Code's look alike but are different things. VS Code's
 * is a *status readout* that happens to be clickable; IntelliJ's is a *menu
 * opener* that happens to show the branch. GitTree's value here was never the
 * readout — it is the branches popup. So the default widget is an action
 * button, sized once, and it grows only for what VS Code's own widget does not
 * show: an in-progress operation, and conflicts.
 *
 * `full` restores the readout for the people who have no other one, which is
 * what `auto` picks when the built-in Git extension is absent or disabled.
 *
 * The shaping rules live in `statusBarModel.ts`, vscode-free and unit-tested;
 * this file is the sink and the tooltip, which needs `l10n`.
 *
 * Only the active repository's items are visible. `statusBarCommands` was
 * scoped to the selected provider by VS Code; with plain items that scoping is
 * ours to do, and N repos × 2 items would otherwise fill the status bar.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { RepoSnapshot } from '../core/model/repositoryModel';
import {
  conflictCount,
  opLabel,
  renderStatusBarText,
  type ResolvedStatusBarMode,
} from './statusBarModel';

export {
  formatCount,
  resolveStatusBarMode,
  type ResolvedStatusBarMode,
  type StatusBarMode,
} from './statusBarModel';

export interface StatusBarState {
  /** Empty means the widget contributes no item at all (`off`). */
  text: string;
  tooltip: string;
}

/**
 * The tooltip is where the truth lives: uncapped counts, the upstream, the
 * project scope. The button deliberately shows none of that, so the tooltip has
 * to carry all of it — that trade is what buys the constant width.
 */
function buildTooltip(snap: RepoSnapshot, repoCount: number): string {
  const lines: string[] = [];
  lines.push(
    snap.detached
      ? vscode.l10n.t('Detached at {0}', (snap.headSha ?? '').slice(0, 7))
      : vscode.l10n.t('On branch {0}', snap.headRef ?? '…'),
  );
  if (snap.upstream === undefined) {
    lines.push(vscode.l10n.t('No upstream'));
  } else if (snap.upstreamGone) {
    lines.push(vscode.l10n.t('Upstream {0} is gone', snap.upstream));
  } else {
    lines.push(
      vscode.l10n.t(
        'Tracking {0} — {1} behind, {2} ahead',
        snap.upstream,
        snap.behind ?? 0,
        snap.ahead ?? 0,
      ),
    );
  }
  const op = opLabel(snap);
  if (op !== undefined) lines.push(op);
  const conflicts = conflictCount(snap);
  if (conflicts > 0) lines.push(vscode.l10n.t('{0} conflicted file(s)', conflicts));
  if (repoCount > 1) lines.push(vscode.l10n.t('{0} repositories in this project', repoCount));
  lines.push(vscode.l10n.t('Click for branches and actions'));
  return lines.join('\n');
}

export function renderStatusBar(
  snap: RepoSnapshot,
  fetching: boolean,
  mode: ResolvedStatusBarMode = 'full',
  repoCount = 1,
): StatusBarState {
  const text = renderStatusBarText(snap, fetching, mode);
  return { text, tooltip: text.length === 0 ? '' : buildTooltip(snap, repoCount) };
}

/** Left-aligned, just left of where the built-in git extension puts its own. */
const BASE_PRIORITY = 100;

interface ItemSpec {
  /** Stable across releases: VS Code persists per-id "hidden" state by it. */
  readonly id: string;
  /** What the status bar's right-click "Manage" menu lists this row as. */
  readonly name: string;
}

/**
 * Index-matched to the commands built in `update()`. The rebase row has its own
 * id rather than inheriting slot 1 from the deleted sync item — a user who had
 * hidden "GitTree Sync" would otherwise find the rebase controls hidden too.
 */
const ITEM_SPECS: readonly ItemSpec[] = [
  { id: 'gittree.status.0', name: 'GitTree Branch' },
  { id: 'gittree.status.rebase', name: 'GitTree Rebase' },
];

export class StatusBarController implements vscode.Disposable {
  private fetching = false;
  private shown = false;
  private readonly sub: { dispose(): void };
  private readonly items: vscode.StatusBarItem[] = [];

  constructor(
    private readonly repo: RepoHandle,
    private readonly isActive: () => boolean,
    private readonly mode: () => ResolvedStatusBarMode = () => 'full',
    private readonly repoCount: () => number = () => 1,
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

  /** The widget's tooltips — where the exact counts moved to. */
  get tooltips(): string[] {
    return this.items.map((i) => (typeof i.tooltip === 'string' ? i.tooltip : ''));
  }

  /**
   * Last visibility decision. `StatusBarItem` exposes no `visible`, and "the
   * widget is gone" is precisely the regression that has to be assertable —
   * reading `titles` cannot see it, because a hidden item keeps its text.
   */
  get visible(): boolean {
    return this.shown;
  }

  /** One item per command, created on demand and reused across updates. */
  private itemAt(index: number): vscode.StatusBarItem {
    let item = this.items[index];
    if (!item) {
      const spec = ITEM_SPECS[index];
      item = vscode.window.createStatusBarItem(
        spec?.id ?? `gittree.status.${index}`,
        vscode.StatusBarAlignment.Left,
        BASE_PRIORITY - index,
      );
      // `name` is what the status bar's own right-click "Manage" menu lists,
      // and that menu is how a user hides an entry — permanently, in a way no
      // `show()` of ours can undo. Every item calling itself "GitTree" made
      // that menu unreadable: you could not tell which row was the branch
      // widget, nor see that it was the one switched off.
      item.name = spec?.name ?? `GitTree ${index}`;
      this.items[index] = item;
    }
    return item;
  }

  update(): void {
    const snap = this.repo.model.snapshot;
    const state = renderStatusBar(snap, this.fetching, this.mode(), this.repoCount());
    const commands: vscode.Command[] = [];
    if (state.text.length > 0) {
      commands.push({
        command: 'gittree.branches.open',
        title: state.text,
        tooltip: state.tooltip,
        arguments: [this.repo.root],
      });
      // P5-T1: rebase actions stay one click away while a rebase is running.
      // Kept as its own item because continue/skip/abort is a second verb —
      // and one the built-in Git widget does not offer at all, so it is not a
      // duplicate of anything.
      const opKind = snap.inProgressOp?.kind;
      if (opKind === 'rebase-interactive' || opKind === 'rebase-apply') {
        commands.push({
          command: 'gittree.rebase.actions',
          title: '$(list-selection) ' + vscode.l10n.t('Rebase…'),
          tooltip: vscode.l10n.t('Continue, skip or abort the rebase'),
          arguments: [this.repo.root],
        });
      }
    }
    const visible = this.isActive() && commands.length > 0;
    this.shown = visible;
    commands.forEach((command, i) => {
      const item = this.itemAt(i);
      item.text = command.title;
      item.tooltip = command.tooltip;
      item.command = command;
      if (visible) item.show();
      else item.hide();
    });
    // A finished rebase drops the second command; its item must go with it.
    // The text is cleared as well as hidden so `titles` — which the debug dump
    // prints — never reports a label that is no longer on screen.
    for (let i = commands.length; i < this.items.length; i++) {
      const stale = this.items[i];
      if (!stale) continue;
      stale.text = '';
      stale.hide();
    }
  }

  dispose(): void {
    this.sub.dispose();
    for (const item of this.items) item.dispose();
  }
}
