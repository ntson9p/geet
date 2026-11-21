/**
 * dialogHost (P11-T1): the one place a Geet "dialog" is opened. P11-P13
 * route Push, Merge, Rebase, Reset, Rollback, Shelve, Cherry-pick, Apply
 * Patch, Clone and Manage Remotes through here, replacing the QuickPick/InputBox
 * chains that stand in for IntelliJ's option-bearing dialogs today (gap
 * analysis S4). Update Project left in POST-P14ab: one two-way choice is a
 * native modal message box, not a tab (D30).
 *
 * Deviation D2 (docs/deviations.md): VS Code has no modal webview, so this is
 * an editor-area panel that behaves modally within itself — focus-trapped,
 * `aria-modal`, Escape cancels. The rest of the window stays interactive, and
 * that is not fixable through the extension API.
 *
 * Contract with the webview (`src/shared/protocol.ts` DIALOG_METHODS):
 *   webview → host   `dialog/init`    request  → the params passed to openDialog
 *   webview → host   `dialog/accept`  event    → resolves the promise with the result
 *   webview → host   `dialog/cancel`  event    → resolves undefined
 *   webview → host   `dialog/help`    event    → runs `onHelp`
 * Disposing the panel (tab closed, window reloaded) resolves undefined too, so
 * a caller can always `await` exactly once.
 */
import * as vscode from 'vscode';
import { DIALOG_METHODS } from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from './webviewHost';

export interface DialogOptions<TParams> {
  /** Webview app folder under `dist/webviews/<app>/`. */
  app: string;
  /** Dialog id inside that app — one bundle can host several dialogs. */
  dialog: string;
  title: string;
  /** Served to the webview from `dialog/init`; must be JSON-serializable. */
  params: TParams;
  extensionUri: vscode.Uri;
  /**
   * P11-T7: extra request handlers for data too large or too lazy for the init
   * payload — the Shelve dialog's per-file diffs, the Push dialog's per-branch
   * commit lists (P13). Registered on the dialog's RPC host verbatim.
   */
  handlers?: Record<string, (params: unknown) => unknown>;
  /** Optional docs target for the footer's `?`. */
  onHelp?: () => void;
  /** Diagnostics sink — wired to the Geet output channel by callers. */
  trace?: (line: string) => void;
  viewColumn?: vscode.ViewColumn;
}

export interface DialogHandle<TResult> {
  /** Resolves with the accepted result, or `undefined` when cancelled/closed. */
  readonly result: Promise<TResult | undefined>;
  /** Closes the dialog; a pending `result` resolves `undefined`. */
  close(): void;
  readonly panel: vscode.WebviewPanel;
}

const VIEW_TYPE = 'geet.dialog';

/**
 * Opens a dialog and returns a handle. Prefer `openDialog` unless you need to
 * close the panel from the outside (e.g. the operation it configures was
 * cancelled elsewhere).
 */
export function createDialog<TParams, TResult>(
  options: DialogOptions<TParams>,
): DialogHandle<TResult> {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    options.title,
    options.viewColumn ?? vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Dialogs hold unsaved user intent (ticked files, a typed message);
      // rebuilding them on tab switch would throw it away.
      retainContextWhenHidden: true,
      localResourceRoots: webviewResourceRoots(options.extensionUri),
    },
  );

  panel.webview.html = buildWebviewHtml({
    app: options.app,
    webview: panel.webview,
    extensionUri: options.extensionUri,
    title: options.title,
    initialState: { dialog: options.dialog },
  });

  let settle: ((value: TResult | undefined) => void) | undefined;
  const result = new Promise<TResult | undefined>((resolve) => {
    settle = resolve;
  });

  /** Exactly-once resolution: whichever of accept/cancel/dispose lands first. */
  const finish = (value: TResult | undefined): void => {
    const resolve = settle;
    settle = undefined;
    resolve?.(value);
  };

  const rpc = new WebviewRpcHost(panel.webview, options.trace);
  rpc.on(DIALOG_METHODS.init, () => ({ dialog: options.dialog, params: options.params }));
  for (const [method, handler] of Object.entries(options.handlers ?? {})) {
    rpc.on(method, handler);
  }
  const subs = [
    rpc.onEvent(DIALOG_METHODS.accept, (params) => {
      finish(params as TResult);
      panel.dispose();
    }),
    rpc.onEvent(DIALOG_METHODS.cancel, () => {
      finish(undefined);
      panel.dispose();
    }),
    rpc.onEvent(DIALOG_METHODS.help, () => options.onHelp?.()),
    // A retained panel that becomes visible again may have pending requests.
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) rpc.rehydrate();
    }),
  ];

  panel.onDidDispose(() => {
    finish(undefined);
    for (const s of subs) s.dispose();
    rpc.dispose();
  });

  return {
    result,
    panel,
    // Braced on purpose: `Disposable.dispose()` is typed `any`.
    close: () => {
      panel.dispose();
    },
  };
}

/** The common case: open, await the user's answer, forget the panel. */
export function openDialog<TParams, TResult>(
  options: DialogOptions<TParams>,
): Promise<TResult | undefined> {
  return createDialog<TParams, TResult>(options).result;
}
