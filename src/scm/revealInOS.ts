/**
 * POST-P14bq — a Commit-window row shown in the OS file manager, its file or
 * folder selected: **Reveal in File Explorer** on Windows, **Reveal in Finder**
 * on macOS, **Open Containing Folder** on Linux. Those are VS Code's own names
 * for the item in its Explorer, editor tabs and Git view, and its own shortcut
 * (Shift+Alt+R, ⌥⌘R, Ctrl+Alt+R) works on the keyboard's row.
 *
 * Three commands, one per platform, because a menu item's title is fixed: the
 * menus and keys show only the platform's own (`isWindows`, `isMac`,
 * `isLinux`), as VS Code's Git extension does with `git.revealFileInOS.*`.
 * All three run the same thing: VS Code's `revealFileInOS` (see
 * `revealTarget.ts` for what it does on each system).
 *
 * The menus hide the item where it cannot work: on a deleted row (nothing on
 * disk to select) and in a remote window (`gittree.canRevealInOS`). A row whose
 * file went since the last refresh says so rather than doing nothing, which is
 * what the OS would do with it.
 *
 * The keys: VS Code resolves ⌥⌘R and Ctrl+Alt+R (while `gittree.commitTreeFocus`)
 * and the command, given no row, asks the window for the keyboard's row.
 * Windows' Shift+Alt+R is answered inside the webview and never reaches VS Code,
 * which would also open its Run menu (`webview-ui/src/commit/revealKey.ts`); its
 * keybinding stays for the menu's label and for rebinding.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { showInfo } from '../ui/notices';
import { canRevealInOS, REPOSITORY_FOLDER, revealPath, revealTargetOf } from '../ui/revealTarget';

/** Set once at start-up: whether this window's files are on this computer. */
export const REVEAL_CONTEXT_KEY = 'gittree.canRevealInOS';

/**
 * Whether the Commit window's change tree has the keyboard: the reveal key's
 * `when`. VS Code's own `focusedView` cannot say it: a webview's iframe lives in
 * an overlay outside its view pane, so the pane's focus tracker clears
 * `focusedView` the moment focus goes into the webview. The webview says it
 * itself (`commit/treeFocus`).
 */
export const TREE_FOCUS_CONTEXT_KEY = 'gittree.commitTreeFocus';

let treeFocused = false;

/** Sets `gittree.commitTreeFocus`; a repeat of the last value sends nothing. */
export function setTreeFocus(focused: boolean): void {
  if (treeFocused === focused) return;
  treeFocused = focused;
  void vscode.commands.executeCommand('setContext', TREE_FOCUS_CONTEXT_KEY, focused);
}

/** One command per platform, each titled as VS Code titles the item there. */
export const REVEAL_COMMANDS = [
  'gittree.revealFileInOS.windows',
  'gittree.revealFileInOS.mac',
  'gittree.revealFileInOS.linux',
] as const;

/** What a reveal did. Integration tests read it: under `GITTREE_TEST` nothing opens. */
export interface RevealRecord {
  readonly outcome: 'revealed' | 'missing' | 'unsupported';
  /** The file or folder, absolute; absent for `unsupported`. */
  readonly path?: string;
}

/** The `revealInOS` debug registry. */
export interface RevealRegistry {
  readonly supported: boolean;
  recent(): readonly RevealRecord[];
  clear(): void;
}

const RECENT_LIMIT = 50;
const recent: RevealRecord[] = [];

function record(entry: RevealRecord): void {
  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
}

let supported = false;

/** Whether the file or folder is there: a dangling link counts, the file manager shows it. */
async function onDisk(fullPath: string): Promise<boolean> {
  try {
    await fsp.lstat(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shows the row the arguments name (`revealTargetOf`): its file selected in the
 * folder holding it, or a folder row's folder selected in its parent, as VS
 * Code's Explorer reveals a folder.
 */
export async function revealRow(core: Core, args: readonly unknown[]): Promise<void> {
  const target = revealTargetOf(args);
  if (target === undefined) return;
  const repo = core.getRepo(target.repoRoot);
  if (!repo) return;
  if (!supported) {
    // The menus and keys are hidden here; only another caller gets this far.
    record({ outcome: 'unsupported' });
    showInfo(vscode.l10n.t("This window's files are not on this computer."));
    return;
  }
  const full = revealPath(repo.root, target);
  if (!(await onDisk(full))) {
    // Deleted since the tree was drawn, or a deleted row reached by the key.
    // VS Code would open nothing and say nothing.
    record({ outcome: 'missing', path: full });
    // A repository row's target is its folder, `.`: say the repository's name.
    const shown = target.relPath === REPOSITORY_FOLDER ? path.basename(repo.root) : target.relPath;
    showInfo(vscode.l10n.t('{0} is no longer on disk.', shown));
    return;
  }
  record({ outcome: 'revealed', path: full });
  if (process.env['GITTREE_TEST'] === '1') return;
  try {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(full));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.output.appendLine(`[reveal] ${full}: ${message}`);
    void vscode.window.showWarningMessage(vscode.l10n.t("Couldn't open the file manager: {0}", message));
  }
}

/**
 * Registers the three commands. Called from a row's menu they get the row's
 * context; from the key they get nothing, and `keyboardRow` asks the Commit
 * window for the row the keyboard is on, which answers through `revealRow`.
 */
export function registerRevealInOS(
  context: vscode.ExtensionContext,
  core: Core,
  keyboardRow: () => void,
): RevealRegistry {
  supported = canRevealInOS({
    desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
    remoteName: vscode.env.remoteName,
    version: vscode.version,
  });
  void vscode.commands.executeCommand('setContext', REVEAL_CONTEXT_KEY, supported);
  for (const id of REVEAL_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        if (revealTargetOf(args) !== undefined) await revealRow(core, args);
        else keyboardRow();
      }),
    );
  }
  const registry: RevealRegistry = {
    supported,
    recent: () => [...recent],
    clear: () => {
      recent.length = 0;
    },
  };
  core.debugRegistry.set('revealInOS', registry);
  return registry;
}
