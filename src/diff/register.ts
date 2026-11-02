/**
 * Phase 14-T7: GitTree's own controls on GitTree's diffs, and the cross-file
 * change navigation IntelliJ has and VS Code does not.
 *
 * This is Route A of `docs/deviations.md` D1: the native diff editor is kept —
 * it brings syntax highlighting, find, go-to-definition, the accessible diff
 * viewer and large-file performance that a webview renderer would lose — and
 * GitTree dresses it instead of replacing it.
 *
 * VS Code's own ↑ ↓ buttons and `Alt+F5` are the ones that do this. An extension
 * cannot remove a core menu item, but the button only runs a command, and the
 * registry hands a command to whoever registered it last. So GitTree registers
 * those two ids while one of its diffs is on screen, and only then: every other
 * diff in the window never comes through here.
 */
import * as vscode from 'vscode';
import type { Change } from '../scm/gutter/changeModel';
import { DiffSessionRegistry, type ActiveDiff, type DiffEntry } from './diffSession';
import {
  alreadyLanded,
  boundaryAction,
  expectedLanding,
  movedOn,
  needsAsking,
  nextStop,
  predict,
  predictedChanges,
  type BoundaryAction,
  type Direction,
} from './navigationStep';

const NATIVE: Readonly<Record<Direction, string>> = {
  next: 'workbench.action.compareEditor.nextChange',
  prev: 'workbench.action.compareEditor.previousChange',
};

const SETTING_SECTION = 'gittree.diff';
const SETTING_KEY = 'goToNextFileAfterLastChange';

/** How long the status bar repeats a hint, should the hover be gone. */
const HINT_STATUS_MS = 8000;
/** How long a diff can stay uncomputed before "did not move" is taken at its word. */
const COMPUTING_MS = 1500;
/** Waits between asks while a diff is being computed: short at first, it usually is. */
const LANDING_WAITS_MS = [0, 16, 32, 64, 128, 256, 512, 512];
const RETRY_WAITS_MS = [32, 64, 128, 256];
const EDITOR_WAIT_MS = 2000;
const MAX_PREDICTIONS = 16;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** VS Code's own two commands: taken over, and still reachable underneath. */
class NativeArrows implements vscode.Disposable {
  private readonly held = new Map<Direction, vscode.Disposable>();
  private wanted = false;

  constructor(private readonly onPress: (direction: Direction, args: unknown[]) => Promise<void>) {}

  setHeld(wanted: boolean): void {
    this.wanted = wanted;
    for (const direction of ['next', 'prev'] as const) {
      if (wanted) this.take(direction);
      else this.release(direction);
    }
  }

  private take(direction: Direction): void {
    if (this.held.has(direction)) return;
    this.held.set(
      direction,
      vscode.commands.registerCommand(NATIVE[direction], (...args: unknown[]) =>
        this.onPress(direction, args),
      ),
    );
  }

  private release(direction: Direction): void {
    this.held.get(direction)?.dispose();
    this.held.delete(direction);
  }

  /** Runs VS Code's command, not ours: while ours is registered, that is what the id means. */
  async run(direction: Direction, args: readonly unknown[] = []): Promise<void> {
    this.release(direction);
    try {
      await vscode.commands.executeCommand(NATIVE[direction], ...args);
    } finally {
      if (this.wanted) this.take(direction);
    }
  }

  dispose(): void {
    this.setHeld(false);
  }
}

/** The modified side: VS Code navigates by its cursor whichever side has focus. */
function modifiedEditorOf(active: ActiveDiff): vscode.TextEditor | undefined {
  const uri = active.entries[active.index]!.modified.toString();
  const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
  const candidates = vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === uri);
  return candidates.find((e) => e.viewColumn === column) ?? candidates[0];
}

function setCursor(editor: vscode.TextEditor, line: number): void {
  const at = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(at, at);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/gu, '\\$&');
}

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

  const takesOver = (): boolean =>
    vscode.workspace.getConfiguration(SETTING_SECTION).get<boolean>(SETTING_KEY, true);

  /** The spot a press stopped at, so that only a second press from there crosses. */
  let armed:
    | { spot: string; editor: vscode.TextEditor; line: number; confirmed: boolean }
    | undefined;

  // Presses run one at a time: a press that arrives during a crossing belongs
  // to the file it lands on.
  let pressQueue: Promise<void> = Promise.resolve();
  const inTurn = (work: () => Promise<void>): Promise<void> => {
    const run = pressQueue.then(work);
    pressQueue = run.catch((err: unknown) => {
      core.output.appendLine(`Diff navigation failed: ${String(err)}`);
    });
    return pressQueue;
  };

  const native = new NativeArrows((direction, args) => inTurn(() => press(direction, args)));
  context.subscriptions.push(native);

  // ---- The hint ------------------------------------------------------------

  /**
   * IntelliJ's hint is a tooltip at the change, gone at the next key or scroll,
   * and VS Code's hover behaves exactly like that. It reads what is on the line,
   * so a decoration carrying the message is all it takes, with no provider to
   * answer for every hover in the window.
   */
  const hintType = vscode.window.createTextEditorDecorationType({});
  context.subscriptions.push(hintType);
  let hinted: vscode.TextEditor | undefined;
  let hintStatus: vscode.Disposable | undefined;

  const clearHint = (): void => {
    armed = undefined;
    hintStatus?.dispose();
    hintStatus = undefined;
    if (!hinted) return;
    hinted.setDecorations(hintType, []);
    hinted = undefined;
    // VS Code 1.96 has no such command, and there the next scroll closes it.
    void vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => undefined);
  };

  const showHint = async (
    editor: vscode.TextEditor,
    message: string,
    detail: string | undefined,
  ): Promise<void> => {
    registry.lastHint = message;
    const md = new vscode.MarkdownString(`**${escapeMarkdown(message)}**`);
    if (detail !== undefined) md.appendMarkdown(`\n\n${detail}`);
    md.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
    const at = editor.selection.active;
    editor.setDecorations(hintType, [{ range: new vscode.Range(at, at), hoverMessage: md }]);
    hinted = editor;
    hintStatus = vscode.window.setStatusBarMessage(message, HINT_STATUS_MS);

    const focused = vscode.window.activeTextEditor;
    if (focused && focused.document.uri.toString() !== editor.document.uri.toString()) {
      // Focus on the left side: the hover would look for its message there.
      await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
    }
    await vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
  };

  /** The hint's second line, as markdown: where the second press goes, and how to turn this off. */
  const hintDetail = (active: ActiveDiff, toIndex: number): string => {
    const entry = active.entries[toIndex]!;
    const label = (entry.label ?? entry.title).replace(/`/gu, "'");
    const settings = encodeURIComponent(JSON.stringify([`${SETTING_SECTION}.${SETTING_KEY}`]));
    const position = vscode.l10n.t('file {0} of {1}', toIndex + 1, active.entries.length);
    const link = `[${vscode.l10n.t('Settings')}](command:workbench.action.openSettings?${settings})`;
    return `\`${label}\` · ${position} · ${link}`;
  };

  // ---- What the two sides hold ----------------------------------------------

  /**
   * GitTree's own idea of the changes, which only ever predicts: VS Code decides
   * where they are, and it is asked before anything irreversible. The prediction
   * spares the view a wrap to the top of the file just to learn there is nothing
   * further. Presses stay on a few files for a while, so a few are kept.
   */
  const predictions = new Map<string, readonly Change[] | undefined>();
  const changesOf = async (entry: DiffEntry): Promise<readonly Change[] | undefined> => {
    try {
      const [left, right] = await Promise.all([
        vscode.workspace.openTextDocument(entry.original),
        vscode.workspace.openTextDocument(entry.modified),
      ]);
      const ignoreTrim = vscode.workspace
        .getConfiguration('diffEditor', right.uri)
        .get<boolean>('ignoreTrimWhitespace', true);
      const key = `${left.uri.toString()} ${left.version} ${right.uri.toString()} ${right.version} ${ignoreTrim}`;
      if (predictions.has(key)) return predictions.get(key);
      const changes = predictedChanges(left.getText(), right.getText(), ignoreTrim);
      if (predictions.size >= MAX_PREDICTIONS) predictions.clear();
      predictions.set(key, changes);
      return changes;
    } catch {
      return undefined;
    }
  };

  /** Where Next and Previous Change go from this file, if anywhere. */
  const stopFrom = (active: ActiveDiff, direction: Direction): Promise<number | undefined> =>
    nextStop(active.index, active.entries.length, direction, async (i) => {
      const entry = active.entries[i]!;
      if (entry.identical === true) return false;
      // Undefined is a file too big to tell: stop there, and let VS Code show it.
      const changes = await changesOf(entry);
      return changes === undefined || changes.length > 0;
    });

  // ---- A press ---------------------------------------------------------------

  /**
   * VS Code's navigation, and the line it left the cursor on. A diff it has not
   * finished computing answers every press by not moving, so a press that was
   * expected to go somewhere gets a little longer to do it.
   */
  const ask = async (
    editor: vscode.TextEditor,
    direction: Direction,
    args: readonly unknown[],
    expectsMore: boolean,
  ): Promise<number> => {
    const before = editor.selection.active.line;
    await native.run(direction, args);
    if (expectsMore) {
      for (const wait of RETRY_WAITS_MS) {
        if (editor.selection.active.line !== before || sessions.msSinceShown() > COMPUTING_MS) break;
        await sleep(wait);
        await native.run(direction, args);
      }
    }
    return editor.selection.active.line;
  };

  /** Puts back what a wrap took away: the same reveal VS Code gave this change. */
  const restore = (
    editor: vscode.TextEditor,
    selection: vscode.Selection,
    changes: readonly Change[] | undefined,
  ): void => {
    const line = selection.active.line;
    const change = changes?.find((c) => c.startLine <= line && line <= c.endLine);
    editor.selection = selection;
    editor.revealRange(
      change
        ? new vscode.Range(change.startLine, 0, change.endLine + 1, 0)
        : new vscode.Range(line, 0, line, 0),
      vscode.TextEditorRevealType.InCenter,
    );
  };

  const spotOf = (editor: vscode.TextEditor, direction: Direction, line: number): string =>
    `${editor.document.uri.toString()} ${direction} ${line}`;

  async function act(
    action: BoundaryAction,
    active: ActiveDiff,
    editor: vscode.TextEditor,
    direction: Direction,
    confirmed: boolean,
  ): Promise<void> {
    switch (action.kind) {
      case 'cross':
        await cross(active, action.toIndex, action.landOn);
        return;
      case 'arm':
        await showHint(
          editor,
          direction === 'next'
            ? vscode.l10n.t('Press again to go to the next file')
            : vscode.l10n.t('Press again to go to the previous file'),
          hintDetail(active, action.toIndex),
        );
        break;
      case 'end':
        await showHint(
          editor,
          direction === 'next'
            ? vscode.l10n.t('This is the last change')
            : vscode.l10n.t('This is the first change'),
          active.entries.length > 1
            ? vscode.l10n.t('file {0} of {1}', active.index + 1, active.entries.length)
            : undefined,
        );
        break;
    }
    const line = editor.selection.active.line;
    armed = { spot: spotOf(editor, direction, line), editor, line, confirmed };
  }

  async function press(direction: Direction, args: readonly unknown[]): Promise<void> {
    const active = sessions.active();
    const editor = active && modifiedEditorOf(active);
    // The toolbar names the editor it belongs to. It can be a diff in another
    // group, which this press has nothing to say about.
    const resource = args[0];
    const elsewhere =
      resource instanceof vscode.Uri && resource.toString() !== editor?.document.uri.toString();
    if (!active || !editor || elsewhere || !takesOver()) {
      await native.run(direction, args);
      return;
    }

    const selection = editor.selection;
    const line = selection.active.line;
    const wasArmed = armed?.spot === spotOf(editor, direction, line);
    const wasConfirmed = wasArmed && armed?.confirmed === true;
    const changes = await changesOf(active.entries[active.index]!);
    const prediction = predict(changes, line, direction, editor.document.lineCount - 1);
    const asking = needsAsking({ armed: wasArmed, confirmed: wasConfirmed, prediction });
    clearHint();

    if (asking) {
      const after = await ask(editor, direction, args, prediction !== 'none');
      if (movedOn(direction, line, after)) return;
      const action = boundaryAction(direction, wasArmed, await stopFrom(active, direction));
      // Leaving for another file, there is nothing to put back.
      if (action.kind !== 'cross' && after !== line) restore(editor, selection, changes);
      await act(action, active, editor, direction, true);
      return;
    }
    const action = boundaryAction(direction, wasArmed, await stopFrom(active, direction));
    await act(action, active, editor, direction, wasConfirmed);
  }

  // ---- Another file ----------------------------------------------------------

  const stillShowing = (active: ActiveDiff, index: number): boolean => {
    const now = sessions.active();
    return now !== undefined && now.entries === active.entries && now.index === index;
  };

  const editorAt = async (active: ActiveDiff, index: number): Promise<vscode.TextEditor | undefined> => {
    const deadline = Date.now() + EDITOR_WAIT_MS;
    for (;;) {
      if (stillShowing(active, index)) {
        const editor = modifiedEditorOf({ ...active, index });
        if (editor) return editor;
      }
      if (Date.now() > deadline) return undefined;
      await sleep(16);
    }
  };

  /**
   * Lands where VS Code's navigation says, which cannot be asked for by number:
   * from the last line "next" wraps onto the first change, and from the first
   * line "previous" wraps onto the last. A file whose only change is on the last
   * line stays put there, and "next" from the top finds it.
   */
  const land = async (
    active: ActiveDiff,
    index: number,
    editor: vscode.TextEditor,
    landOn: 'first' | 'last',
  ): Promise<void> => {
    if (alreadyLanded(await changesOf(active.entries[index]!), landOn)) return;
    for (const wait of LANDING_WAITS_MS) {
      if (wait > 0) await sleep(wait);
      if (!stillShowing(active, index)) return;
      if (landOn === 'last') {
        setCursor(editor, 0);
        await native.run('prev');
        if (editor.selection.active.line !== 0) return;
        continue;
      }
      const lastLine = editor.document.lineCount - 1;
      setCursor(editor, lastLine);
      await native.run('next');
      if (editor.selection.active.line !== lastLine) return;
      setCursor(editor, 0);
      await native.run('next');
      if (editor.selection.active.line !== 0) return;
    }
  };

  async function cross(active: ActiveDiff, toIndex: number, landOn: 'first' | 'last'): Promise<void> {
    const changes = await changesOf(active.entries[toIndex]!);
    await sessions.moveTo(active, toIndex, expectedLanding(changes, landOn));
    const editor = await editorAt(active, toIndex);
    if (editor) await land(active, toIndex, editor, landOn);
  }

  const toFile = async (delta: number): Promise<void> => {
    const active = sessions.active();
    if (!active || !active.entries[active.index + delta]) return;
    clearHint();
    await cross(active, active.index + delta, 'first');
  };

  // ---- Keeping it all current ------------------------------------------------

  const hold = (): void => native.setHeld(takesOver() && sessions.active() !== undefined);
  context.subscriptions.push(
    sessions.onDidChangeActive(() => {
      clearHint();
      hold();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTING_SECTION}.${SETTING_KEY}`)) hold();
    }),
    // The gesture is two presses from one spot, not "the next press whenever".
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (armed?.editor === e.textEditor && e.selections[0]?.active.line !== armed.line) clearHint();
    }),
  );
  hold();

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
  register('gittree.diff.nextChange', () => inTurn(() => press('next', [])));
  register('gittree.diff.prevChange', () => inTurn(() => press('prev', [])));
  register('gittree.diff.nextFile', () => inTurn(() => toFile(1)));
  register('gittree.diff.prevFile', () => inTurn(() => toFile(-1)));
  register('gittree.diff.toggleSideBySide', () => toggle('renderSideBySide'));
  register('gittree.diff.toggleIgnoreWhitespace', () => toggle('ignoreTrimWhitespace'));
  register('gittree.diff.toggleCollapseUnchanged', () => toggle('hideUnchangedRegions.enabled'));

  core.debugRegistry.set('phase14', registry);
  return registry;
}
