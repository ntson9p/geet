/**
 * Shelve Changes dialog, host half (P11-T7): builds the params from the live
 * changelists, serves lazy per-file diffs to the webview, and turns the
 * accepted result into a `ShelfStore` capture — `shelve()` when every file is
 * whole, `shelveSelected()` when any file contributes only ticked changes.
 *
 * Staleness follows the P11-T3 commit rule exactly: each partial selection
 * carries the signature of the change list it was made against, the host
 * re-diffs at accept time, and a mismatch falls back to shelving the whole
 * file (with a warning) rather than applying renumbered hunks.
 */
import * as vscode from 'vscode';
import { notifySuccess } from '../ui/notify';
import type { Core, RepoHandle } from '../core/core';
import { withCrlf } from '../core/patch/eol';
import { applyLineChanges, complementChanges } from '../core/patch/patchBuilder';
import { canonicalKey } from '../core/repoDiscovery';
import { isUntracked, shortCode } from '../core/model/statusEntry';
import type { ChangelistService } from '../commit/changelists/changelistService';
import { UNVERSIONED_ID } from '../commit/changelists/changelistService';
import { computeFileDiff } from '../commit/window/fileDiff';
import { signChanges } from '../commit/window/inclusion';
import {
  SHELVE_DIALOG_METHODS,
  type CommitChangeDto,
  type ShelveDialogParamsDto,
  type ShelveDialogResultDto,
  type ShelveFileDiffDto,
} from '../shared/protocol';
import { openDialog } from '../ui/dialogHost';
import { statusColorOverrides } from '../ui/statusColors';
import type { ShelfStore } from './shelfStore';
import { showInfo } from '../ui/notices';

export interface ShelveDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  changelistsFor(repo: RepoHandle): ChangelistService;
  storeFor(repoRoot: string): ShelfStore | undefined;
  /** The commit-window draft, used as the message prefill. */
  draftMessage(repo: RepoHandle): string;
  trace?: (line: string) => void;
}

function changeDto(service: ChangelistService, relPath: string): CommitChangeDto {
  const entry = service.statusEntry(relPath);
  const kind: CommitChangeDto['kind'] = !entry
    ? 'modified'
    : entry.kind === 'unmerged'
      ? 'conflicted'
      : isUntracked(entry)
        ? 'untracked'
        : entry.x === 'A' || entry.y === 'A'
          ? 'added'
          : entry.x === 'D' || entry.y === 'D'
            ? 'deleted'
            : 'modified';
  return {
    path: relPath.replace(/\\/gu, '/'),
    code: entry ? shortCode(entry) : 'M.',
    kind,
    checked: true,
  };
}

export function buildShelveParams(
  deps: ShelveDialogDeps,
  repo: RepoHandle,
  listId?: string,
): ShelveDialogParamsDto | undefined {
  const service = deps.changelistsFor(repo);
  const lists: ShelveDialogParamsDto['lists'] = service
    .getLists()
    .map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive,
      files: l.files.map((f) => changeDto(service, f)),
    }))
    .filter((l) => l.files.length > 0);
  const unversioned = service.unversioned();
  if (unversioned.length > 0) {
    lists.push({
      id: UNVERSIONED_ID,
      name: vscode.l10n.t('Unversioned Files'),
      isActive: false,
      files: unversioned.map((f) => changeDto(service, f)),
    });
  }
  if (lists.length === 0) return undefined;

  const preferred =
    (listId !== undefined ? lists.find((l) => l.id === listId) : undefined) ??
    lists.find((l) => l.isActive) ??
    lists[0]!;
  const draft = deps.draftMessage(repo).trim();
  return {
    repoRoot: repo.root,
    repoLabel: repo.root.split(/[\\/]/u).pop() ?? repo.root,
    lists,
    listId: preferred.id,
    message: draft.length > 0 ? draft : preferred.name,
    colors: statusColorOverrides(),
  };
}

/** Opens the dialog; resolves true when a shelve actually happened. */
export async function showShelveDialog(
  deps: ShelveDialogDeps,
  repo: RepoHandle,
  listId?: string,
): Promise<boolean> {
  const params = buildShelveParams(deps, repo, listId);
  if (!params) {
    showInfo(vscode.l10n.t('There are no changes to shelve.'));
    return false;
  }
  const store = deps.storeFor(repo.root);
  if (!store) return false;

  const result = await openDialog<ShelveDialogParamsDto, ShelveDialogResultDto>({
    app: 'dialogs',
    dialog: 'shelve',
    title: vscode.l10n.t('Shelve Changes'),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: {
      [SHELVE_DIALOG_METHODS.fileDiff]: async (raw): Promise<ShelveFileDiffDto> => {
        const p = raw as { relPath: string };
        const diff = await computeFileDiff(repo, p.relPath);
        return {
          path: p.relPath,
          originalText: diff.originalText,
          modifiedText: diff.modifiedText,
          changes: diff.changes,
          wholeFileOnly: diff.wholeFileOnly,
          signature: signChanges(diff.changes),
        };
      },
      [SHELVE_DIALOG_METHODS.refresh]: (): ShelveDialogParamsDto =>
        buildShelveParams(deps, repo, listId) ?? {
          repoRoot: repo.root,
          repoLabel: params.repoLabel,
          lists: [],
          listId: '',
          message: '',
        },
    },
  });
  if (!result) return false; // cancelled — worktree and shelf untouched
  return applyShelveResult(deps, repo, result);
}

/**
 * The accept half, separated so integration tests can drive it with exactly
 * the payload the webview posts — the dialog UI itself is Playwright-covered.
 */
export async function applyShelveResult(
  deps: ShelveDialogDeps,
  repo: RepoHandle,
  result: ShelveDialogResultDto,
): Promise<boolean> {
  if (result.paths.length === 0 && result.partials.length === 0) return false;
  const store = deps.storeFor(repo.root);
  if (!store) return false;

  const name = result.message.split('\n', 1)[0]?.trim() ?? '';
  const comment = result.message.includes('\n')
    ? result.message.slice(result.message.indexOf('\n') + 1).trim()
    : '';

  // Re-diff every partial at accept time; a stale selection shelves whole.
  const wholePaths = [...result.paths];
  const stale: string[] = [];
  const partials: Array<{ relPath: string; includedText: string; residueText: string }> = [];
  for (const partial of result.partials) {
    if (partial.included.length === 0) continue; // nothing ticked → file is out
    const diff = await computeFileDiff(repo, partial.relPath);
    const included = [...partial.included].sort((a, b) => a - b);
    const sigMismatch = signChanges(diff.changes) !== partial.signature;
    if (diff.wholeFileOnly || sigMismatch || included.length >= diff.changes.length) {
      // Applying indices to a renumbered change list is the one failure the
      // signature exists to prevent — fall back to the whole file, loudly.
      if (sigMismatch && !diff.wholeFileOnly) stale.push(partial.relPath);
      wholePaths.push(partial.relPath);
      continue;
    }
    const chosen = diff.changes.filter((_, i) => included.includes(i));
    const excluded = complementChanges(diff.changes, included);
    const residue = applyLineChanges(diff.originalText, diff.modifiedText, excluded);
    partials.push({
      relPath: partial.relPath,
      // Goes into a blob: the blob's line endings, as `git add` would store it.
      includedText: applyLineChanges(diff.originalText, diff.modifiedText, chosen),
      // Goes back into the working tree: its own line endings again.
      residueText: diff.worktreeCrlf ? withCrlf(residue) : residue,
    });
  }
  if (stale.length > 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Shelving {0} whole: its changes moved since they were selected.',
        stale.join(', '),
      ),
    );
  }
  if (wholePaths.length === 0 && partials.length === 0) return false;

  try {
    const res =
      partials.length > 0
        ? await store.shelveSelected({
            name: name.length > 0 ? name : vscode.l10n.t('Shelved changes'),
            ...(comment.length > 0 ? { comment } : {}),
            wholePaths,
            partials,
            removeFromWorktree: result.removeFromWorktree,
          })
        : await store.shelve({
            name: name.length > 0 ? name : vscode.l10n.t('Shelved changes'),
            ...(comment.length > 0 ? { comment } : {}),
            paths: wholePaths,
            removeFromWorktree: result.removeFromWorktree,
          });
    if (res.removalSkippedReason !== undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Shelved, but the changes stay in the worktree: the patch failed its re-apply check ({0}).',
          res.removalSkippedReason,
        ),
      );
    }
    const repoKey = canonicalKey(repo.root);
    deps.trace?.(`shelve dialog: stored "${res.meta.id}" for ${repoKey}`);
    await repo.refresher.refreshNow();
    // IntelliJ's `shelve.successful.message` — the warning above said it otherwise.
    if (res.removalSkippedReason === undefined) {
      notifySuccess(vscode.l10n.t('Changes shelved successfully'));
    }
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Shelve failed: {0}', err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}
