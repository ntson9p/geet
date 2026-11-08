/**
 * Staging-mode operations (P3-T4): group-level stage/unstage-all, selection→
 * patch commands, and hunk CodeLenses ("Stage hunk ≫ / Revert") shown on the
 * modified side of index↔worktree diff editors — the clickable stand-in for
 * IntelliJ's `>>` gutter chevrons.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { noConflictsLeft } from '../../core/model/statusEntry';
import { toBlobEol } from '../../core/patch/eol';
import { computeLineChanges } from '../../core/patch/lineDiff';
import {
  applyLineChanges,
  complementChanges,
  correspondingChanges,
  type LineChange,
} from '../../core/patch/patchBuilder';
import { repoRelative } from '../../core/util/paths';
import { revObjectSpec, REV_SCHEME, parseRevUri } from '../../core/vdocs/revContentProvider';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import { reportStageOutcome } from './stageMessages';
import { selectChanges, stageWorktreeLines, unstageIndexLines } from './stageLines';
import { showInfo } from '../../ui/notices';

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

function selectionsOf(editor: vscode.TextEditor): Array<{ startLine: number; endLine: number }> {
  return editor.selections.map((s) => ({ startLine: s.start.line, endLine: s.end.line }));
}

async function stageSelected(core: Core): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const target = targetOf(core, editor);
  if (!editor || !target) return;
  const { repo, rel, doc } = target;
  if (doc.isDirty) await doc.save();
  const selections = selectionsOf(editor);
  const outcome = await repo.queue.enqueue({
    label: vscode.l10n.t('Stage selected ranges in {0}', path.basename(rel)),
    kind: 'mutate',
    bypassHold: noConflictsLeft(repo.model.snapshot.statusEntries),
    run: (git, token) =>
      stageWorktreeLines(git, repo.root, rel, doc.getText(), (fresh) => selectChanges(fresh, selections), token),
  });
  reportStageOutcome(outcome);
}

/**
 * The index document an Unstage Selected Ranges acts on: the right side of a
 * HEAD ↔ index diff, where the selection's line numbers are index lines. A
 * selection in the working-tree file says nothing about which staged lines
 * are meant — those are not on screen there (POST-QA F1).
 */
function indexDocOf(
  core: Core,
  editor: vscode.TextEditor | undefined,
): { repo: RepoHandle; rel: string } | undefined {
  const query = editor ? parseRevUri(editor.document.uri) : undefined;
  if (!query || query.ref !== ':0') return undefined;
  const repo = core.getRepo(query.repo) ?? core.repoForUri(vscode.Uri.file(path.join(query.repo, query.rel)));
  return repo ? { repo, rel: query.rel } : undefined;
}

async function unstageSelected(core: Core): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const target = indexDocOf(core, editor);
  if (!editor || !target) {
    showInfo(
      vscode.l10n.t('Select the lines in the staged diff (HEAD ↔ Index) to unstage them.'),
    );
    return;
  }
  const { repo, rel } = target;
  const selections = selectionsOf(editor);
  const outcome = await repo.queue.enqueue({
    label: vscode.l10n.t('Unstage selected ranges in {0}', path.basename(rel)),
    kind: 'mutate',
    bypassHold: noConflictsLeft(repo.model.snapshot.statusEntries),
    run: (git, token) =>
      unstageIndexLines(git, repo.root, rel, (fresh) => selectChanges(fresh, selections), token),
  });
  reportStageOutcome(outcome, 'unstage');
}

async function revertSelected(core: Core): Promise<void> {
  const target = targetOf(core, vscode.window.activeTextEditor);
  if (!target) return;
  const { repo, rel, doc } = target;
  const originalText = await readRev(repo, rel, ':0');
  if (originalText === undefined) return;
  // Diffed on the blob's line endings, like the change bars; the editor puts
  // its own line endings back on the text it is given.
  const docText = doc.getText();
  const modifiedText = toBlobEol(originalText, docText).text;
  const changes = computeLineChanges(originalText, modifiedText);
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
  const applied = await repo.queue.enqueue({
    label: vscode.l10n.t('Revert selected ranges in {0}', path.basename(rel)),
    kind: 'mutate',
    isDestructive: true,
    snapshotLabel: SNAPSHOT_LABELS.rollback,
    snapshotPaths: [doc.uri.fsPath],
    run: async () => {
      // Typed into while the revert waited its turn: these changes no longer
      // describe the file, and replacing it would drop what was typed.
      if (doc.getText() !== docText) return false;
      const reverted = applyLineChanges(originalText, modifiedText, keep);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), reverted);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error('revert edit not applied');
      return true;
    },
  });
  if (!applied) {
    showInfo(vscode.l10n.t('The file changed while waiting. Select the lines again.'));
  }
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
    const changes = computeLineChanges(base, toBlobEol(base, doc.getText()).text);
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

  register('gittree.stage.selectedRanges', () => stageSelected(core));
  register('gittree.unstage.selectedRanges', () => unstageSelected(core));
  register('gittree.revert.selectedRanges', () => revertSelected(core));

  register('gittree.stageAll', async (repoRoot) => {
    const repo = (typeof repoRoot === 'string' ? core.getRepo(repoRoot) : undefined) ?? core.repos[0];
    if (!repo) return;
    await repo.queue.enqueue({
      label: vscode.l10n.t('Stage all changes'),
      kind: 'mutate',
      bypassHold: noConflictsLeft(repo.model.snapshot.statusEntries),
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
    const picked = change as LineChange;
    const outcome = await repo.queue.enqueue({
      label: vscode.l10n.t('Stage hunk in {0}', path.basename(rel)),
      kind: 'mutate',
      bypassHold: noConflictsLeft(repo.model.snapshot.statusEntries),
      run: (git, token) =>
        stageWorktreeLines(
          git,
          repo.root,
          rel,
          doc.getText(),
          (fresh) => correspondingChanges(fresh, picked),
          token,
        ),
    });
    reportStageOutcome(outcome);
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
    // Measured as the lens was: on the blob's line endings.
    const docText = doc.getText();
    const modifiedText = toBlobEol(base, docText).text;
    const changes = computeLineChanges(base, modifiedText);
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
        if (doc.getText() !== docText) return; // typed into meanwhile: the lens is stale
        const reverted = applyLineChanges(base, modifiedText, complementChanges(changes, [idx]));
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
