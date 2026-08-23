/**
 * VCS Operations Popup (P13-T7, gap analysis S6): `Alt+\`` opens a QuickPick of
 * every action applicable *right now*, enumerated from `dialogRegistry.ts` and
 * `branchActions.ts` rather than a hand-kept list — absent entirely before.
 *
 * The context is read at open time from the model (dirty, upstream, remotes,
 * stashes, in-progress op) and from the workbench (focused diff editor, log
 * selection). Recently used actions float to the top, per workspace.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { isDirty } from '../core/model/statusEntry';
import {
  buildOperationsItems,
  OPS_GROUP_LABEL,
  OPS_GROUP_ORDER,
  recordRecent,
  type OpsContext,
  type OpsItem,
} from './operationsModel';

const RECENT_KEY = 'gittree.operationsPopup.recent';

interface OpsQuickPickItem extends vscode.QuickPickItem {
  item?: OpsItem;
}

/**
 * True when the focused tab is a diff editor. The merge-editor input type is
 * newer than our `@types/vscode` floor, so it is probed by name rather than
 * pinned to a class that may not exist at compile time.
 */
export function isDiffEditorFocused(): boolean {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab) return false;
  const input: unknown = tab.input;
  if (input instanceof vscode.TabInputTextDiff) return true;
  return input !== null && typeof input === 'object'
    ? input.constructor.name === 'TabInputTextMerge'
    : false;
}

export interface OperationsPopupDeps {
  core: Core;
  /** Whether the log currently has a commit selected (P4/P12 seam). */
  commitSelected?: () => boolean;
}

/** Reads the live context the popup filters on. */
export function readOpsContext(deps: OperationsPopupDeps, repo: RepoHandle | undefined): OpsContext {
  if (!repo) {
    return {
      hasRepo: false,
      dirty: false,
      hasUpstream: false,
      hasRemote: false,
      hasStash: false,
      diffEditorFocused: isDiffEditorFocused(),
      commitSelected: false,
    };
  }
  const snap = repo.model.snapshot;
  return {
    hasRepo: true,
    dirty: snap.statusEntries.some((e) => isDirty(e) && e.kind !== 'ignored'),
    hasUpstream: snap.upstream !== undefined,
    // `refs` carries the remote-tracking branches; an unfetched remote still
    // counts, so fall back to the upstream when there are no remote refs yet.
    hasRemote: snap.refs.some((r) => r.type === 'remote') || snap.upstream !== undefined,
    hasStash: snap.stashes.length > 0,
    ...(snap.inProgressOp !== undefined ? { inProgressOp: snap.inProgressOp.kind } : {}),
    diffEditorFocused: isDiffEditorFocused(),
    commitSelected: deps.commitSelected?.() ?? false,
    ...(snap.headRef !== undefined ? { currentBranch: snap.headRef } : {}),
  };
}

/** Assembles the QuickPick rows, with a separator per non-empty group. */
export function toQuickPickItems(items: readonly OpsItem[]): OpsQuickPickItem[] {
  const out: OpsQuickPickItem[] = [];
  for (const group of OPS_GROUP_ORDER) {
    const inGroup = items.filter((i) => i.group === group);
    if (inGroup.length === 0) continue;
    out.push({
      label: OPS_GROUP_LABEL[group],
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const item of inGroup) {
      out.push({
        label: item.icon !== undefined ? `$(${item.icon}) ${item.label}` : item.label,
        ...(item.accelerator !== undefined ? { description: item.accelerator } : {}),
        item,
      });
    }
  }
  return out;
}

export interface OperationsPopupRegistry {
  /**
   * `repoRoot` is explicit on purpose: with nothing focused the popup falls
   * back to `core.repos[0]`, which in a multi-root workspace is not
   * necessarily the repository the caller means.
   */
  readContext(repoRoot?: string): OpsContext;
  buildItems(repoRoot?: string): OpsItem[];
}

export function registerOperationsPopup(
  context: vscode.ExtensionContext,
  deps: OperationsPopupDeps,
): OperationsPopupRegistry {
  const { core } = deps;
  const repoOf = (arg?: unknown): RepoHandle | undefined => {
    if (typeof arg === 'string' && arg.length > 0) return core.getRepo(arg);
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };
  const recent = (): string[] => context.workspaceState.get<string[]>(RECENT_KEY, []);
  const readContext = (arg?: unknown): OpsContext => readOpsContext(deps, repoOf(arg));
  const buildItems = (arg?: unknown): OpsItem[] =>
    buildOperationsItems(readContext(arg), recent());

  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.operationsPopup', async (arg?: unknown) => {
      const repo = repoOf(arg);
      const items = buildItems(arg);
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No VCS operations apply right now.'),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(toQuickPickItems(items), {
        placeHolder: vscode.l10n.t('VCS Operations'),
        matchOnDescription: true,
      });
      const chosen = picked?.item;
      if (!chosen) return;
      await context.workspaceState.update(RECENT_KEY, recordRecent(recent(), chosen.command));
      // Repo-scoped commands take the root; the rest ignore the extra argument.
      await vscode.commands.executeCommand(chosen.command, ...(chosen.args ?? [repo?.root]));
    }),
  );

  const registry: OperationsPopupRegistry = {
    readContext: (repoRoot?: string) => readContext(repoRoot),
    buildItems: (repoRoot?: string) => buildItems(repoRoot),
  };
  core.debugRegistry.set('operationsPopup', registry);
  return registry;
}
