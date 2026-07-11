/**
 * Staging-mode operations (P3-T4): group-level stage/unstage-all, selection→
 * patch commands, and hunk CodeLenses ("Stage hunk ≫ / Revert") shown on the
 * modified side of index↔worktree diff editors — the clickable stand-in for
 * IntelliJ's `>>` gutter chevrons.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { computeLineChanges } from '../../core/patch/lineDiff';
import { applyLineChanges, buildPatch, complementChanges, type LineChange } from '../../core/patch/patchBuilder';
import { repoRelative } from '../../core/util/paths';
import { revObjectSpec, REV_SCHEME, parseRevUri } from '../../core/vdocs/revContentProvider';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';

async function readRev(repo: RepoHandle, rel: string, ref: string): Promise<string | undefined> {
  const result = await repo.queue.enqueue({
    label: `show ${ref}:${rel}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['show', revObjectSpec(ref, rel)], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

interface RangeTarget {
  repo: RepoHandle;
  rel: string;
  doc: vscode.TextDocument;
}

function targetOf(core: Core, editor: vscode.TextEditor | undefined): RangeTarget | undefined {
  const doc = editor?.document;
  if (!doc || doc.uri.scheme !== 'file') return undefined;
  const repo = core.repoForUri(doc.uri);
  if (!repo) return undefined;
  const rel = repoRelative(repo.root, doc.uri.fsPath);
  if (rel === undefined) return undefined;
  return { repo, rel, doc };
}

/** Changes whose modified-side lines intersect any selection (or cursor hunk). */
export function selectChanges(
  changes: readonly LineChange[],
  selections: ReadonlyArray<{ startLine: number; endLine: number }>,
): LineChange[] {
  return changes.filter((c) => {
    // Deletions anchor at the modified line after which content vanished.
    const start = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber;
    const end = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber + 1 : c.modifiedEndLineNumber;
    return selections.some((s) => s.startLine + 1 <= end && s.endLine + 1 >= start);
  });
}

async function stageSelected(core: Core, reverse: boolean): Promise<void> {
  const target = targetOf(core, vscode.window.activeTextEditor);
  if (!target) return;
  const { repo, rel, doc } = target;
  if (doc.isDirty) await doc.save();

  const baseRef = reverse ? 'HEAD' : ':0';
  const modifiedText = reverse ? await readRev(repo, rel, ':0') : doc.getText();
  const originalText = await readRev(repo, rel, baseRef);
  if (originalText === undefined || modifiedText === undefined) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('File is not tracked — stage the whole file instead.'),
    );
    return;
  }
  const changes = computeLineChanges(originalText, modifiedText);
  const selections = vscode.window.activeTextEditor!.selections.map((s) => ({
    startLine: s.start.line,
    endLine: s.end.line,
  }));
  const picked = selectChanges(changes, selections);
  if (picked.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No changed lines in the selection.'));
    return;
  }
  const patch = buildPatch({ relPath: rel, originalText, modifiedText, changes: picked });
  await repo.queue.enqueue({
    label: reverse
      ? vscode.l10n.t('Unstage selected ranges in {0}', path.basename(rel))
      : vscode.l10n.t('Stage selected ranges in {0}', path.basename(rel)),
    kind: 'mutate',
    run: async (git, token) => {
      const args = ['apply', '--cached', '--unidiff-zero'];
      if (reverse) args.push('--reverse');
      args.push('-');
      await git.exec(repo.root, args, { stdin: patch, token });
    },
  });
}

async function revertSelected(core: Core): Promise<void> {
  const target = targetOf(core, vscode.window.activeTextEditor);
  if (!target) return;
  const { repo, rel, doc } = target;
  const originalText = await readRev(repo, rel, ':0');
  if (originalText === undefined) return;
  const changes = computeLineChanges(originalText, doc.getText());
  const selections = vscode.window.activeTextEditor!.selections.map((s) => ({
    startLine: s.start.line,
    endLine: s.end.line,
  }));
  const picked = selectChanges(changes, selections);
  if (picked.length === 0) return;
  const keep = complementChanges(
    changes,
    picked.map((c) => changes.indexOf(c)),
  );
  await repo.queue.enqueue({
    label: vscode.l10n.t('Revert selected ranges in {0}', path.basename(rel)),
    kind: 'mutate',
    isDestructive: true,
    snapshotLabel: SNAPSHOT_LABELS.rollback,
    snapshotPaths: [doc.uri.fsPath],
    run: async () => {
      const reverted = applyLineChanges(originalText, doc.getText(), keep);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), reverted);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error('revert edit not applied');
    },
  });
}

/**
 * Hunk CodeLenses on file documents that are the RIGHT side of a visible
 * index↔worktree diff (left side = gittree-rev). Decorations aren't
 * clickable, so lenses carry the `>>` actions.
 */
class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly core: Core) {}

  fire(): void {
    this._onDidChange.fire();
  }

  private isRightSideOfOurDiff(doc: vscode.TextDocument): boolean {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff) {
          if (
            input.modified.toString() === doc.uri.toString() &&
            input.original.scheme === REV_SCHEME &&
            parseRevUri(input.original)?.ref === ':0'
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (doc.uri.scheme !== 'file' || !this.isRightSideOfOurDiff(doc)) return [];
    const repo = this.core.repoForUri(doc.uri);
    if (!repo) return [];
    const rel = repoRelative(repo.root, doc.uri.fsPath);
    if (rel === undefined) return [];
    const base = await readRev(repo, rel, ':0');
    if (base === undefined) return [];
    const changes = computeLineChanges(base, doc.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const c of changes) {
      const line = Math.max(0, (c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          command: 'gittree.stage.hunkAt',
          title: vscode.l10n.t('Stage hunk ≫'),
          arguments: [doc.uri, c],
        }),
        new vscode.CodeLens(range, {
          command: 'gittree.revert.hunkAt',
          title: vscode.l10n.t('Revert hunk'),
          arguments: [doc.uri, c],
        }),
      );
    }
    return lenses;
  }
}

export function registerStagingOps(context: vscode.ExtensionContext, core: Core): void {
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('gittree.stage.selectedRanges', () => stageSelected(core, false));
  register('gittree.unstage.selectedRanges', () => stageSelected(core, true));
  register('gittree.revert.selectedRanges', () => revertSelected(core));

  register('gittree.stageAll', async (repoRoot) => {
    const repo = (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? core.repos[0];
    if (!repo) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Stage all changes'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['add', '-A'], { token });
      },
    });
  });
  register('gittree.unstageAll', async (repoRoot) => {
    const repo = (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? core.repos[0];
    if (!repo) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Unstage all changes'),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['reset', '-q'], { token, allowNonZeroExit: true });
      },
    });
  });

  // Single-hunk lens targets.
  register('gittree.stage.hunkAt', async (uri, change) => {
    if (!(uri instanceof vscode.Uri) || typeof change !== 'object' || change === null) return;
    const repo = core.repoForUri(uri);
    if (!repo) return;
    const rel = repoRelative(repo.root, uri.fsPath);
    if (rel === undefined) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) await doc.save();
    const base = await readRev(repo, rel, ':0');
    if (base === undefined) return;
    const patch = buildPatch({
      relPath: rel,
      originalText: base,
      modifiedText: doc.getText(),
      changes: [change as LineChange],
    });
    await repo.queue.enqueue({
      label: vscode.l10n.t('Stage hunk in {0}', path.basename(rel)),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['apply', '--cached', '--unidiff-zero', '-'], {
          stdin: patch,
          token,
        });
      },
    });
    lensProvider.fire();
  });
  register('gittree.revert.hunkAt', async (uri, change) => {
    if (!(uri instanceof vscode.Uri) || typeof change !== 'object' || change === null) return;
    const repo = core.repoForUri(uri);
    if (!repo) return;
    const rel = repoRelative(repo.root, uri.fsPath);
    if (rel === undefined) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const base = await readRev(repo, rel, ':0');
    if (base === undefined) return;
    const changes = computeLineChanges(base, doc.getText());
    const idx = changes.findIndex(
      (c) => JSON.stringify(c) === JSON.stringify(change),
    );
    if (idx === -1) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Revert hunk in {0}', path.basename(rel)),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: [uri.fsPath],
      run: async () => {
        const reverted = applyLineChanges(base, doc.getText(), complementChanges(changes, [idx]));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), reverted);
        await vscode.workspace.applyEdit(edit);
      },
    });
    lensProvider.fire();
  });

  const lensProvider = new HunkCodeLensProvider(core);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lensProvider),
    vscode.window.tabGroups.onDidChangeTabs(() => lensProvider.fire()),
  );
}
