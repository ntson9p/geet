/**
 * Phase 14-T7: Geet's own controls on Geet's diffs, and the cross-file
 * change navigation IntelliJ has and VS Code does not.
 *
 * This is Route A of `docs/deviations.md` D1: the native diff editor is kept —
 * it brings syntax highlighting, find, go-to-definition, the accessible diff
 * viewer and large-file performance that a webview renderer would lose — and
 * Geet dresses it instead of replacing it.
 *
 * VS Code's own ↑ ↓ buttons and `Alt+F5` are the ones that do this. An extension
 * cannot remove a core menu item, but the button only runs a command, and the
 * registry hands a command to whoever registered it last. So Geet registers
 * those two ids while one of its diffs is on screen, and only then: every other
 * diff in the window never comes through here.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../ui/writeSetting';
import type { Change } from '../scm/gutter/changeModel';
import { DiffSessionRegistry, entryAt, uriKey, type ActiveDiff, type DiffEntry } from './diffSession';
import {
  alreadyLanded,
  boundaryAction,
  expectedLanding,
  movedOn,
  hoverWouldCoverToolbar,
  needsAsking,
  nextStop,
  nothingHiddenAhead,
  predict,
  predictedChanges,
  type BoundaryAction,
  type Direction,
} from './navigationStep';

const NATIVE: Readonly<Record<Direction, string>> = {
  next: 'workbench.action.compareEditor.nextChange',
  prev: 'workbench.action.compareEditor.previousChange',
};

const SETTING_SECTION = 'geet.diff';
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

/**
 * The modified side: VS Code navigates by its cursor whichever side has focus.
 * A working-tree file can also be open on its own in another group, and only the
 * editors inside a diff have no column of their own.
 */
function modifiedEditorOf(active: ActiveDiff): vscode.TextEditor | undefined {
  const uri = uriKey(entryAt(active).modified);
  const candidates = vscode.window.visibleTextEditors.filter((e) => uriKey(e.document.uri) === uri);
  return candidates.find((e) => e.viewColumn === undefined) ?? candidates[0];
}

function visibleLines(editor: vscode.TextEditor): { first: number; last: number } | undefined {
  const first = editor.visibleRanges[0];
  const last = editor.visibleRanges[editor.visibleRanges.length - 1];
  return first && last ? { first: first.start.line, last: last.end.line } : undefined;
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
    | { spot: string; editor: vscode.TextEditor; at: vscode.Position; confirmed: boolean }
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
   * and VS Code's hover behaves exactly like that. The provider exists only while
   * the hint does, and answers only at the cursor. On a working-tree file a language
   * server may answer there as well, and the hover cannot be made to leave it out;
   * the newest of equally matching providers goes first, so the hint at least does.
   *
   * Near the top of a file a hover would cover the toolbar, so the hint is drawn the
   * same way at the end of the line instead.
   */
  const hintLabel = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      fontWeight: 'bold',
      color: new vscode.ThemeColor('editorHoverWidget.foreground'),
      backgroundColor: new vscode.ThemeColor('editorHoverWidget.background'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorHoverWidget.border'),
    },
  });
  let hint: vscode.Disposable | undefined;
  context.subscriptions.push(
    hintLabel,
    new vscode.Disposable(() => {
      hint?.dispose();
    }),
  );

  const clearHint = (): void => {
    armed = undefined;
    if (!hint) return;
    hint.dispose();
    hint = undefined;
    // VS Code 1.96 has no such command, and there the next scroll closes it.
    void vscode.commands.executeCommand('editor.action.hideHover').then(undefined, () => undefined);
  };

  const showHint = async (
    editor: vscode.TextEditor,
    message: string,
    detail: { readonly markdown: string; readonly text: string } | undefined,
  ): Promise<void> => {
    registry.lastHint = message;
    const at = editor.selection.active;
    const status = vscode.window.setStatusBarMessage(message, HINT_STATUS_MS);

    const firstVisible = visibleLines(editor)?.first;
    if (firstVisible !== undefined && hoverWouldCoverToolbar(at.line, firstVisible)) {
      const end = editor.document.lineAt(at.line).range.end;
      const contentText = detail === undefined ? ` ${message} ` : ` ${message}  ·  ${detail.text} `;
      editor.setDecorations(hintLabel, [
        { range: new vscode.Range(end, end), renderOptions: { after: { contentText } } },
      ]);
      hint = vscode.Disposable.from(
        status,
        new vscode.Disposable(() => editor.setDecorations(hintLabel, [])),
      );
      return;
    }

    const md = new vscode.MarkdownString(`**${escapeMarkdown(message)}**`);
    if (detail !== undefined) md.appendMarkdown(`\n\n${detail.markdown}`);
    md.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
    const uri = uriKey(editor.document.uri);
    hint = vscode.Disposable.from(
      status,
      vscode.languages.registerHoverProvider(
        { scheme: editor.document.uri.scheme },
        {
          provideHover: (document, position) =>
            uriKey(document.uri) === uri && position.isEqual(at)
              ? new vscode.Hover(md, new vscode.Range(at, at))
              : undefined,
        },
      ),
    );

    const focused = vscode.window.activeTextEditor;
    if (focused && uriKey(focused.document.uri) !== uriKey(editor.document.uri)) {
      // Focus on the left side: the hover would look for its message there.
      await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
    }
    await vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
  };

  /** The hint's second line: where the second press goes, and how to turn this off. */
  const hintDetail = (
    active: ActiveDiff,
    toIndex: number,
  ): { readonly markdown: string; readonly text: string } => {
    const entry = active.entries[toIndex]!;
    const label = entry.label ?? entry.title;
    const settings = encodeURIComponent(JSON.stringify([`${SETTING_SECTION}.${SETTING_KEY}`]));
    const position = vscode.l10n.t('file {0} of {1}', toIndex + 1, active.entries.length);
    const link = `[${vscode.l10n.t('Settings')}](command:workbench.action.openSettings?${settings})`;
    return {
      markdown: `\`${label.replace(/`/gu, "'")}\` · ${position} · ${link}`,
      // On one line in what may be half a window, the name of the file will do.
      text: `${label.slice(label.lastIndexOf('/') + 1)} (${position})`,
    };
  };

  // ---- What the two sides hold ----------------------------------------------

  /**
   * Geet's own idea of the changes, which only ever predicts: VS Code decides
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
      const entry = await sessions.settled(active.sequence, active.entries[i]!);
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

  /** An edit makes it another spot, cursor or no cursor: a working-tree file can change under a hint. */
  const endDetail = (active: ActiveDiff): { markdown: string; text: string } | undefined => {
    if (active.entries.length < 2) return undefined;
    const position = vscode.l10n.t('file {0} of {1}', active.index + 1, active.entries.length);
    return { markdown: position, text: position };
  };

  const spotOf = (editor: vscode.TextEditor, direction: Direction): string =>
    `${editor.document.uri.toString()} ${editor.document.version} ${direction} ${editor.selection.active.line}`;

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
          endDetail(active),
        );
        break;
    }
    armed = { spot: spotOf(editor, direction), editor, at: editor.selection.active, confirmed };
  }

  async function press(direction: Direction, args: readonly unknown[]): Promise<void> {
    const active = sessions.active();
    const editor = active && modifiedEditorOf(active);
    // The toolbar names the editor it belongs to. It can be a diff in another
    // group, which this press has nothing to say about.
    const resource = args[0];
    const elsewhere =
      resource instanceof vscode.Uri && editor !== undefined && uriKey(resource) !== uriKey(editor.document.uri);
    if (!active || !editor || elsewhere || !takesOver()) {
      await native.run(direction, args);
      return;
    }

    const selection = editor.selection;
    const line = selection.active.line;
    const wasArmed = armed?.spot === spotOf(editor, direction);
    const wasConfirmed = wasArmed && armed?.confirmed === true;
    const changes = await changesOf(entryAt(active));
    const prediction = predict(changes, line, direction, editor.document.lineCount - 1);
    const asking = needsAsking({ armed: wasArmed, confirmed: wasConfirmed, prediction });
    clearHint();

    if (asking) {
      // On a second press the view is about to go, so nothing may stand between
      // VS Code's wrap and the next file: it would show.
      const stopAhead = wasArmed ? await stopFrom(active, direction) : undefined;
      const after = await ask(editor, direction, args, prediction !== 'none');
      if (movedOn(direction, line, after)) return;
      const stop = wasArmed ? stopAhead : await stopFrom(active, direction);
      const action = boundaryAction(direction, wasArmed, stop);
      // Leaving for another file, there is nothing to put back.
      if (action.kind !== 'cross' && after !== line) restore(editor, selection, changes);
      await act(action, active, editor, direction, true);
      return;
    }
    const action = boundaryAction(direction, wasArmed, await stopFrom(active, direction));
    const sure = nothingHiddenAhead(changes, direction, visibleLines(editor));
    await act(action, active, editor, direction, wasConfirmed || sure);
  }

  // ---- Another file ----------------------------------------------------------

  /** The diff on screen, if it is this one. The list may have changed since it was asked for. */
  const showing = (entry: DiffEntry): ActiveDiff | undefined => {
    const now = sessions.active();
    if (!now) return undefined;
    const shown = entryAt(now);
    return uriKey(shown.original) === uriKey(entry.original) && uriKey(shown.modified) === uriKey(entry.modified)
      ? now
      : undefined;
  };

  const editorFor = async (entry: DiffEntry): Promise<vscode.TextEditor | undefined> => {
    const deadline = Date.now() + EDITOR_WAIT_MS;
    for (;;) {
      const now = showing(entry);
      const editor = now && modifiedEditorOf(now);
      if (editor) return editor;
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
    entry: DiffEntry,
    editor: vscode.TextEditor,
    changes: readonly Change[] | undefined,
    landOn: 'first' | 'last',
  ): Promise<void> => {
    if (alreadyLanded(changes, landOn)) return;
    for (const wait of LANDING_WAITS_MS) {
      if (wait > 0) await sleep(wait);
      if (!showing(entry)) return;
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
    const entry = await sessions.settled(active.sequence, active.entries[toIndex]!);
    const changes = await changesOf(entry);
    await sessions.moveTo(active, entry, toIndex, expectedLanding(changes, landOn));
    const editor = await editorFor(entry);
    if (editor) await land(entry, editor, changes, landOn);
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
      if (armed?.editor === e.textEditor && e.selections[0]?.active.isEqual(armed.at) !== true) clearHint();
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
    const current = vscode.workspace.getConfiguration('diffEditor').get<boolean>(key);
    // POST-QA: where VS Code's own diff toggles write — the user's settings,
    // or the workspace when that is where the user keeps it.
    await writeSetting('diffEditor', key, !(current ?? true));
  };

  const register = (id: string, fn: () => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  register('geet.diff.nextChange', () => inTurn(() => press('next', [])));
  register('geet.diff.prevChange', () => inTurn(() => press('prev', [])));
  register('geet.diff.nextFile', () => inTurn(() => toFile(1)));
  register('geet.diff.prevFile', () => inTurn(() => toFile(-1)));
  register('geet.diff.toggleSideBySide', () => toggle('renderSideBySide'));
  register('geet.diff.toggleIgnoreWhitespace', () => toggle('ignoreTrimWhitespace'));
  register('geet.diff.toggleCollapseUnchanged', () => toggle('hideUnchangedRegions.enabled'));

  core.debugRegistry.set('phase14', registry);
  return registry;
}
