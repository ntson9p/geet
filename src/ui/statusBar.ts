/**
 * Status-bar widget (P1-T5, re-hosted by P14-T4, reshaped by POST-P14r, given
 * a single owner by POST-P14s).
 *
 * POST-P14s is the fix for the reported defect, and the two before it were
 * not. The widget shows **one** repository at a time, but every repository got
 * its own `StatusBarController`, and every controller created its own
 * `vscode.StatusBarItem` with the *same* id — `gittree.status.0`. That id is
 * not decoration. `createStatusBarItem(id, …)` documents it as "must be unique
 * within the extension" because the extension host derives the entry's routing
 * key from it, where the id-less overload hands out a fresh key per item. So N
 * controllers did not own N entries — they owned **one**, and fought over it:
 *
 *   - `show()` defers to a `setTimeout(…, 0)` and then `setOrUpdateEntry`, so
 *     the last writer wins the text;
 *   - `hide()` is immediate and calls `$disposeEntry`, which **removes the
 *     shared entry from the status bar** — the one the active repository put
 *     there.
 *
 * A full pass over every controller therefore ended correctly (the hides ran
 * first, the active repository's deferred show recreated the entry), which is
 * why the widget was usually present. But any *single* inactive controller
 * updating on its own — `setFetching` during the per-repository fetch fan-out,
 * or a background status refresh in any other repository — ran `hide()` alone,
 * disposed the shared entry, and nothing rebuilt it. That is the report
 * exactly: fetch across seven repositories, the active repository's own fetch
 * flashes the button back, a later repository's `setFetching(false)` takes it
 * away again, and it stays away.
 *
 * It was invisible from inside the extension: `shown` was true, `item.text`
 * was right, the debug dump agreed — the destruction happened on the main
 * thread under a key no controller could see. Hence the two earlier misses.
 *
 * The fix is to stop having N owners of one slot. `StatusBarHost` owns the
 * items — one per slot, for the whole extension — and renders whichever
 * repository is active. Controllers keep per-repository state and answer what
 * they *would* contribute; they no longer touch a `StatusBarItem`, so no
 * controller can dispose another's entry. The ids stay exactly as they were,
 * which is what keeps a user's "hidden" choice attached to the right row.
 *
 * The shape itself (POST-P14r) is unchanged and still right: VS Code's
 * built-in Git extension already draws a branch readout, so ours is an action
 * — `$(list-tree) Geet $(chevron-down)`, constant width, opening the
 * branches popup — growing only for what the built-in widget does not show.
 * POST-P14t gave it the product's name, because an unlabelled `$(git-branch)`
 * beside the built-in widget's own `$(git-branch)` was read as a duplicate of
 * it rather than as us. `full` restores the readout for people who have no
 * other one, which is what `auto` picks when the built-in Git extension is
 * absent or disabled.
 *
 * The shaping rules live in `statusBarModel.ts`, vscode-free and unit-tested;
 * this file is the sink and the tooltip, which needs `l10n`.
 */
import * as vscode from 'vscode';
import { conflictedFilesCount } from './counts';
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
  if (conflicts > 0) lines.push(conflictedFilesCount(conflicts));
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
 * Index-matched to the commands a controller builds. The rebase row has its own
 * id rather than inheriting slot 1 from the deleted sync item — a user who had
 * hidden "Geet Sync" would otherwise find the rebase controls hidden too.
 *
 * There is exactly one of each for the whole extension. Anything that creates a
 * second item with one of these ids is not adding a second widget, it is taking
 * a co-owner of the first one's entry — see the file header.
 */
const ITEM_SPECS: readonly ItemSpec[] = [
  { id: 'gittree.status.0', name: 'Geet Branch' },
  { id: 'gittree.status.rebase', name: 'Geet Rebase' },
];

/**
 * The single owner of Geet's status-bar entries.
 *
 * One host per extension, not per repository: a `StatusBarItem`'s id is the key
 * VS Code routes by, so items are a property of the *slot*, never of the
 * repository that happens to be filling it. Retargeting one item is what
 * "switch which repository the widget shows" means.
 */
export class StatusBarHost implements vscode.Disposable {
  private readonly items: vscode.StatusBarItem[] = [];
  private current: string[] = [];

  /**
   * The ids currently alive. The invariant the reported bug broke: no id
   * appears twice. `statusBarVisibility.test.ts` asserts it, because nothing
   * downstream of a violation is observable from inside the extension.
   */
  get itemIds(): string[] {
    return this.items.map((i) => i.id);
  }

  /** What was last pushed to the status bar — the shown items' texts, in order. */
  get rendered(): string[] {
    return [...this.current];
  }

  /** One item per slot, created on demand and reused across renders. */
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
      // `show()` of ours can undo. Every item calling itself "Geet" made
      // that menu unreadable: you could not tell which row was the branch
      // widget, nor see that it was the one switched off.
      item.name = spec?.name ?? `Geet ${index}`;
      this.items[index] = item;
    }
    return item;
  }

  /** Draw exactly these commands; hide every slot beyond them. */
  render(commands: readonly vscode.Command[]): void {
    commands.forEach((command, i) => {
      const item = this.itemAt(i);
      item.text = command.title;
      item.tooltip = command.tooltip;
      item.command = command;
      item.show();
    });
    // A finished rebase — or a repository with nothing to contribute — drops
    // the trailing commands, and their slots go with them. Safe here in a way
    // it was not before: this host is the only owner of these ids, so hiding
    // slot 1 cannot take slot 0's entry, nor another repository's, with it.
    for (let i = commands.length; i < this.items.length; i++) this.items[i]?.hide();
    this.current = commands.map((c) => c.title);
  }

  dispose(): void {
    for (const item of this.items) item.dispose();
    this.items.length = 0;
    this.current = [];
  }
}

/**
 * One repository's contribution to the widget: what it would draw, and whether
 * it is the repository whose turn it is. It owns no `StatusBarItem` — the host
 * does — so nothing here can affect another repository's widget.
 */
export class StatusBarController implements vscode.Disposable {
  private fetching = false;
  private shown = false;
  private state: vscode.Command[] = [];
  private readonly sub: { dispose(): void };

  constructor(
    private readonly repo: RepoHandle,
    private readonly isActive: () => boolean,
    private readonly mode: () => ResolvedStatusBarMode = () => 'full',
    private readonly repoCount: () => number = () => 1,
    /** Tells the owner to re-render; the owner decides whose turn it is. */
    private readonly onDidChangeState: () => void = () => {},
  ) {
    this.sub = repo.model.onDidChange(() => this.update());
    this.recompute();
  }

  setFetching(fetching: boolean): void {
    this.fetching = fetching;
    this.update();
  }

  /**
   * What this repository would put in the status bar, in slot order. Empty
   * means it contributes nothing at all (`off`), which is not the same as being
   * hidden because another repository is active.
   */
  get commands(): readonly vscode.Command[] {
    return this.state;
  }

  /**
   * P14-T4 test seam: the item texts, in order. Replaces reading
   * `SourceControl.statusBarCommands[i].title`, which is what the P1 tests
   * asserted on before the SourceControl was deleted.
   */
  get titles(): string[] {
    return this.state.map((c) => c.title);
  }

  /** The widget's tooltips — where the exact counts moved to. */
  get tooltips(): string[] {
    return this.state.map((c) => (typeof c.tooltip === 'string' ? c.tooltip : ''));
  }

  /**
   * Whether this is the repository the widget is showing. `StatusBarItem`
   * exposes no `visible`, and "the widget is gone" is precisely the regression
   * that has to be assertable — reading `titles` cannot see it, because a
   * repository that is merely not active still has something to say.
   */
  get visible(): boolean {
    return this.shown;
  }

  /** Recompute, then tell the owner. Cached, so a redraw is a wiring fact. */
  update(): void {
    this.recompute();
    this.onDidChangeState();
  }

  private recompute(): void {
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
      // Kept as its own slot because continue/skip/abort is a second verb —
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
    this.state = commands;
    this.shown = this.isActive() && commands.length > 0;
  }

  dispose(): void {
    this.sub.dispose();
  }
}
