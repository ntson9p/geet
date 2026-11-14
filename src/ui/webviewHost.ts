/**
 * Host-side webview platform (P0-T9): HTML factory with strict CSP nonce and
 * the Msg router. Every webview app (log, rebase, compare, pr, demo) goes
 * through these two pieces; no webview ever loads remote resources.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EVT_REHYDRATE, isMsg, PROTOCOL_VERSION, type Msg, type RpcError } from '../shared/protocol';
import { loadSystemDates, systemDatesNow } from './systemDates';

export interface WebviewHtmlOptions {
  /** App folder under dist/webviews/<app>/. */
  app: string;
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  /** Serialized onto window.__gittreeInitialState before the bundle loads. */
  initialState?: unknown;
}

export function webviewResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')];
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const { app, webview, extensionUri, title } = options;
  const nonce = crypto.randomBytes(16).toString('base64');
  const webviewsRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webviews');
  const appRoot = vscode.Uri.joinPath(webviewsRoot, app);
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(appRoot, 'index.js'));
  // Vite may hoist shared imports (base.css) into hashed chunk assets —
  // link every stylesheet that actually exists: the app's own + shared ones.
  const styleUris: vscode.Uri[] = [];
  const appCss = path.join(webviewsRoot.fsPath, app, 'index.css');
  if (fs.existsSync(appCss)) {
    styleUris.push(webview.asWebviewUri(vscode.Uri.joinPath(appRoot, 'index.css')));
  }
  const assetsDir = path.join(webviewsRoot.fsPath, 'assets');
  try {
    for (const name of fs.readdirSync(assetsDir)) {
      if (name.endsWith('.css')) {
        styleUris.push(webview.asWebviewUri(vscode.Uri.joinPath(webviewsRoot, 'assets', name)));
      }
    }
  } catch {
    // no shared assets
  }
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    // The entry script carries the nonce; its module-graph imports (shared
    // vite chunks) load from the extension's webview origin — still no
    // remote code, the origin only serves localResourceRoots.
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    // React needs inline style attributes (virtual list transforms).
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const state =
    options.initialState === undefined
      ? 'undefined'
      : JSON.stringify(options.initialState).replace(/</g, '\\u003c');
  // POST-P14cg: the system's short date and time, as IntelliJ writes dates
  // (`systemDates.ts`); a page without them writes the display language's.
  // The first page of the session starts the one read, for the pages after it;
  // the views that show dates at startup wait for it (`whenSystemDatesKnown`).
  void loadSystemDates();
  const dates = systemDatesNow();
  const systemDates = dates === undefined ? 'undefined' : JSON.stringify(dates).replace(/</g, '\\u003c');

  const styleLinks = styleUris
    .map((u) => `  <link rel="stylesheet" href="${u.toString()}">`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
${styleLinks}
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gittreeInitialState = ${state}; window.__gittreeSystemDates = ${systemDates};</script>
  <script nonce="${nonce}" type="module" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** May return a plain value or a promise — the router awaits either. */
export type RpcHandler = (params: unknown) => unknown;

/**
 * Msg router (host side). Register request handlers with on(); push events
 * with notify(). Call rehydrate() when a retained/deserialized view becomes
 * visible again — clients re-send their pending requests (handlers must be
 * idempotent per master §8).
 */
export class WebviewRpcHost implements vscode.Disposable {
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly sub: vscode.Disposable;
  private seq = 0;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly trace: (line: string) => void = () => undefined,
  ) {
    this.sub = webview.onDidReceiveMessage((raw: unknown) => {
      void this.dispatch(raw);
    });
  }

  on(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /**
   * Whether a **request** handler exists. `on()` and `onEvent()` feed different
   * routers, so a webview that posts `kind: 'evt'` where the host registered
   * `on()` is answered by nobody and fails silently — this lets a test assert
   * the two halves of a view's protocol actually meet.
   */
  hasHandler(method: string): boolean {
    return this.handlers.has(method);
  }

  onEvent(method: string, listener: (params: unknown) => void): vscode.Disposable {
    let set = this.eventListeners.get(method);
    if (!set) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
    return new vscode.Disposable(() => set.delete(listener));
  }

  notify(method: string, params: unknown = undefined): void {
    const msg: Msg = { v: PROTOCOL_VERSION, id: `h${++this.seq}`, kind: 'evt', method, params };
    void this.webview.postMessage(msg);
  }

  /** Signals a restored view; clients re-send pending requests. */
  rehydrate(): void {
    this.notify(EVT_REHYDRATE);
  }

  private async dispatch(raw: unknown): Promise<void> {
    if (!isMsg(raw)) return;
    if (raw.kind === 'evt') {
      const listeners = this.eventListeners.get(raw.method);
      if (listeners) {
        for (const l of [...listeners]) l(raw.params);
      }
      return;
    }
    if (raw.kind !== 'req') return;
    const handler = this.handlers.get(raw.method);
    let response: Msg;
    if (!handler) {
      response = {
        v: PROTOCOL_VERSION,
        id: raw.id,
        kind: 'res',
        error: { code: 'unknown-method', message: `No handler for ${raw.method}` },
      };
    } else {
      try {
        const result = await handler(raw.params);
        response = { v: PROTOCOL_VERSION, id: raw.id, kind: 'res', result };
      } catch (err) {
        const rpcError: RpcError = {
          code: 'handler-failed',
          message: err instanceof Error ? err.message : String(err),
        };
        this.trace(`webview rpc ${raw.method} failed: ${rpcError.message}`);
        response = { v: PROTOCOL_VERSION, id: raw.id, kind: 'res', error: rpcError };
      }
    }
    void this.webview.postMessage(response);
  }

  dispose(): void {
    this.sub.dispose();
    this.handlers.clear();
    this.eventListeners.clear();
  }
}
