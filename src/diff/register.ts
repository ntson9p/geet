/**
 * Phase 14-T7: GitTree's own controls on GitTree's diffs, and the cross-file
 * change navigation IntelliJ has and VS Code does not.
 *
 * This is Route A of `docs/deviations.md` D1: the native diff editor is kept —
 * it brings syntax highlighting, find, go-to-definition, the accessible diff
 * viewer and large-file performance that a webview renderer would lose — and
 * GitTree dresses it instead of replacing it.
 *
 * VS Code's own next/prev-change buttons stay visible beside ours: an
 * extension cannot unregister a core menu item (deviation D20). Ours sort
 * first, and the keyboard is entirely ours.
 */
import * as vscode from 'vscode';
import { computeChanges } from '../scm/gutter/changeModel';
import { DiffSessionRegistry, type ActiveDiff } from './diffSession';
import { landingLine, navigationStep } from './navigationStep';

/** How long an armed boundary stays armed. IntelliJ's hint is transient too. */
const ARM_MS = 3000;

export interface Phase14DiffRegistry {
  sessions: DiffSessionRegistry;
  /** Test seam: the last hint shown, so the two-stage gesture is observable. */
  lastHint?: string;
}

export function registerDiffControls(
  context: vscode.ExtensionContext,
  core: { output: vscode.OutputChannel; debugRegistry: Map<string, unknown> },
): Phase14DiffRegistry {
  const sessions = new DiffSessionRegistry();
  context.subscriptions.push(sessions);
  const registry: Phase14DiffRegistry = { sessions };

  /** The armed boundary, if any: which sequence position and which direction. */
  let armed: { index: number; direction: 'next' | 'prev'; at: number } | undefined;
  const isArmed = (index: number, direction: 'next' | 'prev'): boolean =>
    armed !== undefined &&
    armed.index === index &&
    armed.direction === direction &&
    Date.now() - armed.at < ARM_MS;

  /** A transient in-editor note, the way IntelliJ's popup reads. */
  const hintType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
  });
  context.subscriptions.push(hintType);
  let hintTimer: NodeJS.Timeout | undefined;

  const showHint = (editor: vscode.TextEditor, message: string): void => {
    registry.lastHint = message;
    const line = editor.selection.active.line;
    editor.setDecorations(hintType, [
      {
        range: new vscode.Range(line, 0, line, 0),
        renderOptions: { after: { contentText: `  ${message}` } },
      },
    ]);
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      editor.setDecorations(hintType, []);
    }, ARM_MS);
  };
  const clearHint = (editor: vscode.TextEditor | undefined): void => {
    if (hintTimer) clearTimeout(hintTimer);
    editor?.setDecorations(hintType, []);
  };

  /** The changes between the two sides of the open diff. */
  async function changesOf(active: ActiveDiff): Promise<ReturnType<typeof computeChanges>> {
    const entry = active.entries[active.index]!;
    const [left, right] = await Promise.all([
      vscode.workspace.openTextDocument(entry.original),
      vscode.workspace.openTextDocument(entry.modified),
    ]);
    return computeChanges(left.getText(), right.getText());
  }

  async function navigate(direction: 'next' | 'prev'): Promise<void> {
    const active = sessions.active();
    const editor = vscode.window.activeTextEditor;
    if (!active || !editor) return;
    clearHint(editor);

    const action = navigationStep({
      changes: await changesOf(active),
      line: editor.selection.active.line,
      direction,
      index: active.index,
      total: active.entries.length,
      armed: isArmed(active.index, direction),
    });

    switch (action.kind) {
      case 'reveal': {
        armed = undefined;
        const pos = new vscode.Position(action.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        return;
      }
      case 'arm': {
        armed = { index: active.index, direction, at: Date.now() };
        const next = active.entries[action.toIndex]!;
        showHint(
          editor,
          direction === 'next'
            ? vscode.l10n.t('Press again to go to {0}', next.title)
            : vscode.l10n.t('Press again to go back to {0}', next.title),
        );
        return;
      }
      case 'cross': {
        armed = undefined;
        await sessions.open(active.entries, action.toIndex);
        const landed = sessions.active();
        const target = vscode.window.activeTextEditor;
        if (!landed || !target) return;
        const line = landingLine(await changesOf(landed), action.landOn);
        if (line === undefined) return; // e.g. a rename with no content edit
        const pos = new vscode.Position(line, 0);
        target.selection = new vscode.Selection(pos, pos);
        target.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        return;
      }
      case 'end': {
        armed = undefined;
        showHint(
          editor,
          direction === 'next'
            ? vscode.l10n.t('Last change')
            : vscode.l10n.t('First change'),
        );
        return;
      }
    }
  }

  /**
   * Route A's view options. These are real VS Code settings, written at
   * workspace scope so they behave like view state rather than a preference
   * the user has to hunt for — which is how IntelliJ's Differences Viewer
   * dropdowns read.
   */
  const toggle = async (key: string): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('diffEditor');
    const current = cfg.get<boolean>(key);
    await cfg.update(key, !(current ?? true), vscode.ConfigurationTarget.Workspace);
  };

  const register = (id: string, fn: () => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  register('gittree.diff.nextChange', () => navigate('next'));
  register('gittree.diff.prevChange', () => navigate('prev'));
  register('gittree.diff.toggleSideBySide', () => toggle('renderSideBySide'));
  register('gittree.diff.toggleIgnoreWhitespace', () => toggle('ignoreTrimWhitespace'));
  register('gittree.diff.toggleCollapseUnchanged', () => toggle('hideUnchangedRegions.enabled'));

  // Moving the cursor by hand disarms: the gesture is two presses of the same
  // key, not "the next press whenever it happens".
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (armed !== undefined && e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
        armed = undefined;
        clearHint(e.textEditor);
      }
    }),
  );

  core.debugRegistry.set('phase14', registry);
  return registry;
}
