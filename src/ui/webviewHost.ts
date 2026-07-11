/**
 * Host-side webview platform (P0-T9): HTML factory with strict CSP nonce and
 * the Msg router. Every webview app (log, rebase, compare, pr, demo) goes
 * through these two pieces; no webview ever loads remote resources.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { EVT_REHYDRATE, isMsg, PROTOCOL_VERSION, type Msg, type RpcError } from '../shared/protocol';

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
  const appRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', app);
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(appRoot, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(appRoot, 'index.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    // React needs inline style attributes (virtual list transforms).
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  const state =
    options.initialState === undefined
      ? 'undefined'
      : JSON.stringify(options.initialState).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__gittreeInitialState = ${state};</script>
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
