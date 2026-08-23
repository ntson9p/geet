/**
 * P6-T4 — chevrons and the Apply lifecycle: CodeLenses per conflict block on
 * all three panes plus the file-level accept-all / apply / abort commands.
 * Every action funnels into the T3 TriMergeEditor primitives so undo and
 * reconciliation behave identically no matter which surface triggered them.
 */
import * as vscode from 'vscode';
import { MERGE_SCHEME } from '../core/vdocs/mergeFs';
import { REV_SCHEME } from '../core/vdocs/revContentProvider';
import { confirmModal } from '../ui/confirm';
import {
  applyNonConflicting,
  countMerge,
  mergeStatusText,
  type ApplySide,
} from './applyNonConflicting';
import { resolveBlock, type WandOptions } from './resolver/autoResolver';
import type { TriEditorManager, TriMergeEditor } from './triEditor';

export function wandOptions(): WandOptions {
  return {
    whitespace: vscode.workspace
      .getConfiguration('gittree.merge')
      .get<boolean>('autoResolveWhitespace', true),
  };
}

/** CodeLens rows on the tri-editor panes: chevrons left/right, state center. */
export class MergeCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly manager: TriEditorManager) {
    this.sub = manager.onDidChangeState(() => this._onDidChangeCodeLenses.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const owned = this.manager.owner(document.uri);
    if (!owned) return [];
    const { editor, pane } = owned;
    const lenses: vscode.CodeLens[] = [];
    for (const t of editor.blocks) {
      const id = t.block.id;
      const args = [editor.repo.root, editor.rel, id];
      if (pane === 'left') {
        lenses.push(
          new vscode.CodeLens(this.lensRange(t.leftStart), {
            title: vscode.l10n.t('Accept Yours ≫'),
            command: 'gittree.merge.acceptYours',
            arguments: args,
          }),
        );
        continue;
      }
      if (pane === 'right') {
        lenses.push(
          new vscode.CodeLens(this.lensRange(t.rightStart), {
            title: vscode.l10n.t('≪ Accept Theirs'),
            command: 'gittree.merge.acceptTheirs',
            arguments: args,
          }),
        );
        continue;
      }
      const range = this.lensRange(t.startLine);
      if (t.block.resolution === undefined) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: vscode.l10n.t('Accept Both (Yours First)'),
            command: 'gittree.merge.acceptBoth',
            arguments: args,
          }),
          new vscode.CodeLens(range, {
            title: vscode.l10n.t('Ignore (Keep Base)'),
            command: 'gittree.merge.ignoreBlock',
            arguments: args,
          }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title: vscode.l10n.t('Revert Block ({0})', t.block.resolution),
            command: 'gittree.merge.revertBlock',
            arguments: args,
          }),
        );
      }
    }
    return lenses;
  }

  private lensRange(line: number): vscode.Range {
    const l = Math.max(0, line);
    return new vscode.Range(l, 0, l, 0);
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}

export function registerResolutionActions(
  context: vscode.ExtensionContext,
  manager: TriEditorManager,
): void {
  const provider = new MergeCodeLensProvider(manager);
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: REV_SCHEME }, { scheme: MERGE_SCHEME }, { scheme: 'file' }],
      provider,
    ),
  );

  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  /** Lens args are (repoRoot, rel, blockId); palette calls fall back to the active editor. */
  const target = (args: unknown[]): { editor: TriMergeEditor; blockId?: number } | undefined => {
    const [root, rel, blockId] = args;
    if (typeof root === 'string' && typeof rel === 'string') {
      const editor = manager.get(root, rel);
      if (editor) return { editor, blockId: typeof blockId === 'number' ? blockId : undefined };
    }
    const editor = manager.active();
    return editor ? { editor } : undefined;
  };

  register('gittree.merge.acceptYours', async (...args) => {
    const t = target(args);
    if (t?.blockId !== undefined) await t.editor.applyBlockResolution(t.blockId, 'ours');
  });
  register('gittree.merge.acceptTheirs', async (...args) => {
    const t = target(args);
    if (t?.blockId !== undefined) await t.editor.applyBlockResolution(t.blockId, 'theirs');
  });
  register('gittree.merge.acceptBoth', async (...args) => {
    const t = target(args);
    if (t?.blockId !== undefined) await t.editor.applyBlockResolution(t.blockId, 'both');
  });
  register('gittree.merge.ignoreBlock', (...args) => {
    const t = target(args);
    if (t?.blockId !== undefined) t.editor.ignoreBlock(t.blockId);
  });
  register('gittree.merge.revertBlock', async (...args) => {
    const t = target(args);
    if (t?.blockId !== undefined) await t.editor.revertBlock(t.blockId);
  });

  /** alt+enter: chevron for the block under the cursor, side from the pane. */
  register('gittree.merge.acceptFocusedSide', async () => {
    const active = vscode.window.activeTextEditor;
    if (!active) return;
    const owned = manager.owner(active.document.uri);
    if (!owned) return;
    const block = owned.editor.blockAt(owned.pane, active.selection.active.line);
    if (!block) return;
    const side = owned.pane === 'left' ? 'ours' : owned.pane === 'right' ? 'theirs' : 'both';
    await owned.editor.applyBlockResolution(block.block.id, side);
  });

  /** File-level accept-all (editor title on the result doc; confirm modal). */
  const acceptAllBlocks = async (side: 'ours' | 'theirs'): Promise<void> => {
    const editor = manager.active();
    if (!editor) return;
    const ok = await confirmModal(
      side === 'ours'
        ? vscode.l10n.t('Resolve every conflict in {0} with YOUR version?', editor.rel)
        : vscode.l10n.t('Resolve every conflict in {0} with THEIR version?', editor.rel),
      vscode.l10n.t('Each block stays individually undoable until Apply.'),
      side === 'ours' ? vscode.l10n.t('Accept All Yours') : vscode.l10n.t('Accept All Theirs'),
    );
    if (!ok) return;
    for (const t of editor.blocks) {
      if (t.block.resolution === undefined) await editor.applyBlockResolution(t.block.id, side);
    }
  };
  register('gittree.merge.acceptFileYours', () => acceptAllBlocks('ours'));
  register('gittree.merge.acceptFileTheirs', () => acceptAllBlocks('theirs'));

  /** Abort file: discard the partial result, keep the file unmerged. */
  register('gittree.merge.abortFile', async () => {
    await manager.active()?.close();
  });

  /** Magic Wand over the current file's unresolved blocks (toolbar $(wand)). */
  register('gittree.merge.magicWand', async () => {
    const editor = manager.active();
    if (!editor) return;
    const opts = wandOptions();
    const before = editor.unresolvedCount;
    for (const t of editor.blocks) {
      if (t.block.resolution !== undefined) continue;
      const outcome = resolveBlock(t.block, opts);
      if (outcome.resolved) await editor.applyAutoResolution(t.block.id, outcome.lines);
    }
    const resolved = before - editor.unresolvedCount;
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Resolved {0} of {1} conflicts automatically.', resolved, before),
    );
  });

  // ---- P13-T8 · §3.5 --------------------------------------------------------
  // `Apply non-conflicting changes:` is THREE actions in IntelliJ — Left, All,
  // Right. The wand above only ever implemented "All".

  /** Shared by the three toolbar buttons; returns the message it reported. */
  const applySide = async (
    editor: TriMergeEditor,
    side: ApplySide,
  ): Promise<string> => {
    const opts = wandOptions();
    const pending: Array<{ id: number; lines: string[] }> = [];
    const outcome = applyNonConflicting(
      editor.blocks.map((t) => t.block),
      side,
      opts,
      (block, lines) => {
        // Collect first: the editor's apply rewrites the document, and mutating
        // resolutions mid-iteration would shift the ranges under us.
        pending.push({ id: block.id, lines });
      },
    );
    for (const p of pending) await editor.applyAutoResolution(p.id, p.lines);
    const counts = countMerge(
      editor.blocks.map((t) => t.block),
      opts,
    );
    const message =
      outcome.applied === 0
        ? vscode.l10n.t('No non-conflicting changes to apply. {0}', mergeStatusText(counts))
        : vscode.l10n.t(
            'Applied {0} non-conflicting change(s). {1}',
            outcome.applied,
            mergeStatusText(counts),
          );
    void vscode.window.showInformationMessage(message);
    return message;
  };

  register('gittree.merge.applyNonConflicting.left', async () => {
    const editor = manager.active();
    if (editor) await applySide(editor, 'left');
  });
  register('gittree.merge.applyNonConflicting.all', async () => {
    const editor = manager.active();
    if (editor) await applySide(editor, 'all');
  });
  register('gittree.merge.applyNonConflicting.right', async () => {
    const editor = manager.active();
    if (editor) await applySide(editor, 'right');
  });

  /** §2A per-side `Show Details`: the revision behind each pane. */
  register('gittree.merge.showDetails', async (arg) => {
    const editor = manager.active();
    if (!editor) return;
    const side = arg === 'right' ? 'right' : 'left';
    const details = await editor.sideDetails(side);
    void vscode.window.showInformationMessage(details, { modal: false });
  });

  // Test seam: the toolbar strings are what the acceptance line asserts on.
  manager.applyNonConflictingForTest = (side) => {
    const editor = manager.active();
    return editor ? applySide(editor, side) : Promise.resolve('');
  };
}
