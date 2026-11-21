/**
 * The change popup (P14-T3) — what replaces the native dirty-diff peek widget.
 *
 * VS Code exposes no click handler for a `TextEditorDecorationType` and no API
 * to open a diff peek at a location, so the bar itself cannot be the trigger
 * (deviation D19). Two invocations stand in, and between them they cover the
 * mouse and the keyboard:
 *   - `geet.change.showActions`, keybound, acting at the cursor — always on;
 *   - a `HoverProvider` scoped to changed lines only, rendering the previous
 *     text plus actions — IntelliJ's popup reproduced in content. **Opt-in**
 *     (`geet.changeBars.hoverActions`, POST-P14aa): IntelliJ shows nothing
 *     on hover, and a widget that opens whenever the pointer crosses an edited
 *     line stacks on top of the language server's own hover on exactly the
 *     lines being worked on.
 *
 * A `CodeLens` variant was rejected: it costs a text line per change, which
 * IntelliJ's marker does not.
 */
import * as vscode from 'vscode';
import type { Core } from '../../core/core';
import { CHANGE_ACTIONS } from './changeActionOrder';
import type { ChangeBarsController } from './changeBars';
import { changeAt, nextChange, originalLinesOf, prevChange, type Change } from './changeModel';

/** Payload for the popup's own commands. A Uri does not survive a command URI. */
interface ChangeRef {
  uri: string;
  index: number;
}

function label(change: Change): string {
  const n = change.endLine - change.startLine + 1;
  switch (change.kind) {
    case 'added':
      return n === 1 ? vscode.l10n.t('1 line added') : vscode.l10n.t('{0} lines added', n);
    case 'deleted':
      return vscode.l10n.t('Lines removed');
    case 'modified':
      return n === 1 ? vscode.l10n.t('1 line changed') : vscode.l10n.t('{0} lines changed', n);
  }
}

/**
 * A fence longer than any backtick run in the body, so file content containing
 * ``` cannot break out of the block and into the trusted markdown around it.
 */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function link(title: string, command: string, ref: ChangeRef): string {
  return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(ref))})`;
}

/** The setting that turns the hover on, relative to the `geet` section. */
export const HOVER_ACTIONS_SETTING = 'changeBars.hoverActions';

function hoverActionsEnabled(): boolean {
  return vscode.workspace.getConfiguration('geet').get<boolean>(HOVER_ACTIONS_SETTING, false);
}

export function registerChangePopup(
  context: vscode.ExtensionContext,
  core: Core,
  bars: ChangeBarsController,
): void {
  /** Resolve a ref back to (document, changes, change). */
  const resolve = (
    ref: unknown,
  ): { uri: vscode.Uri; doc: DocumentLike; index: number } | undefined => {
    if (typeof ref !== 'object' || ref === null) return undefined;
    const r = ref as Partial<ChangeRef>;
    if (typeof r.uri !== 'string' || typeof r.index !== 'number') return undefined;
    const uri = vscode.Uri.parse(r.uri);
    const doc = bars.changesFor(uri);
    if (!doc || r.index < 0 || r.index >= doc.changes.length) return undefined;
    return { uri, doc, index: r.index };
  };

  /**
   * The three hunk actions already exist and take the peek widget's argument
   * shape. Re-dispatch rather than duplicate them: a real `vscode.Uri` cannot
   * travel through a `command:` URI, but it can travel through executeCommand.
   */
  const dispatch = async (command: string, ref: unknown): Promise<void> => {
    const r = resolve(ref);
    if (!r) return;
    await vscode.commands.executeCommand(
      command,
      r.uri,
      r.doc.changes.map((c) => c.source),
      r.index,
    );
  };

  const reveal = (ref: unknown, direction: 'next' | 'prev'): void => {
    const r = resolve(ref);
    if (!r) return;
    const from = r.doc.changes[r.index]!;
    const target =
      direction === 'next'
        ? nextChange(r.doc.changes, from.endLine)
        : prevChange(r.doc.changes, from.startLine);
    if (!target) return;
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === r.uri.toString(),
    );
    if (!editor) return;
    const pos = new vscode.Position(target.startLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('geet.change.rollback', (ref) =>
      dispatch('geet.hunk.rollback', ref),
    ),
    vscode.commands.registerCommand('geet.change.stage', (ref) =>
      dispatch('geet.hunk.stage', ref),
    ),
    vscode.commands.registerCommand('geet.change.openCommitView', (ref) =>
      dispatch('geet.hunk.openCommitView', ref),
    ),
    vscode.commands.registerCommand('geet.change.next', (ref) => reveal(ref, 'next')),
    vscode.commands.registerCommand('geet.change.prev', (ref) => reveal(ref, 'prev')),

    // Keyboard entry point: act on the change under the cursor.
    vscode.commands.registerCommand('geet.change.showActions', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = bars.changesFor(editor.document.uri);
      if (!doc) return;
      const line = editor.selection.active.line;
      const change = changeAt(doc.changes, line);
      if (!change) {
        void vscode.window.setStatusBarMessage(vscode.l10n.t('No change at the cursor.'), 3000);
        return;
      }
      const index = doc.changes.indexOf(change);
      // Rollback last, set apart: Enter takes the first (CHANGE_ACTIONS).
      const titles = {
        stage: vscode.l10n.t('$(add) Stage'),
        commitView: vscode.l10n.t('$(git-commit) Open in Commit View'),
        rollback: vscode.l10n.t('$(discard) Rollback'),
      };
      const items: Array<vscode.QuickPickItem & { command?: string }> = CHANGE_ACTIONS.map((a) =>
        a.kind === 'separator'
          ? { label: '', kind: vscode.QuickPickItemKind.Separator }
          : { label: titles[a.id], command: a.command },
      );
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: label(change),
        title: vscode.l10n.t('Change actions'),
      });
      if (picked?.command === undefined) return;
      await vscode.commands.executeCommand(
        picked.command,
        editor.document.uri,
        doc.changes.map((c) => c.source),
        index,
      );
    }),
  );

  const hoverProvider: vscode.HoverProvider = {
    provideHover(document, position) {
      const doc = bars.changesFor(document.uri);
      if (!doc) return undefined;
      const change = changeAt(doc.changes, position.line);
      // Scoped to changed lines only: a hover on every line of every file
      // would be noise, and would fight the language server's own hovers.
      if (!change) return undefined;
      const index = doc.changes.indexOf(change);
      const ref: ChangeRef = { uri: document.uri.toString(), index };

      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.supportThemeIcons = true;
      md.appendMarkdown(`**${label(change)}**\n\n`);

      const original = originalLinesOf(doc.baseText, change);
      if (original.length > 0) {
        const body = original.join('\n');
        const fence = fenceFor(body);
        md.appendMarkdown(`${fence}${document.languageId}\n${body}\n${fence}\n`);
      }

      const actions = [
        link(vscode.l10n.t('$(discard) Rollback'), 'geet.change.rollback', ref),
        link(vscode.l10n.t('$(add) Stage'), 'geet.change.stage', ref),
        link(vscode.l10n.t('$(git-commit) Commit View'), 'geet.change.openCommitView', ref),
      ];
      if (prevChange(doc.changes, change.startLine)) {
        actions.push(link('$(arrow-up)', 'geet.change.prev', ref));
      }
      if (nextChange(doc.changes, change.endLine)) {
        actions.push(link('$(arrow-down)', 'geet.change.next', ref));
      }
      md.appendMarkdown(actions.join(' · '));

      const range = new vscode.Range(change.startLine, 0, change.endLine, 0);
      return new vscode.Hover(md, range);
    },
  };

  /**
   * POST-P14aa: the provider exists only while the setting is on. Registered
   * and disposed rather than consulted inside `provideHover`, so "off" means
   * VS Code never calls Geet on a hover at all — not a call per hover that
   * answers nothing. The listener makes the toggle live: no reload, and the
   * very next hover reflects it.
   */
  let hoverRegistration: vscode.Disposable | undefined;
  const syncHover = (): void => {
    const want = hoverActionsEnabled();
    if (want && hoverRegistration === undefined) {
      hoverRegistration = vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider);
    } else if (!want && hoverRegistration !== undefined) {
      hoverRegistration.dispose();
      hoverRegistration = undefined;
    }
  };
  syncHover();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`geet.${HOVER_ACTIONS_SETTING}`)) syncHover();
    }),
    // Whatever is registered at deactivation goes with the extension.
    {
      dispose: () => {
        hoverRegistration?.dispose();
      },
    },
  );
  void core;
}

/** Structural slice of what the controller hands back, to keep the import light. */
interface DocumentLike {
  readonly changes: readonly Change[];
  readonly baseText: string;
}
