import * as vscode from 'vscode';
import { registerPhase02 } from './branches/register';
import { registerPhase03 } from './commit/register';
import { createCore, type Core } from './core/core';
import { registerPhase04 } from './log/register';
import { registerPhase06MergeEngine } from './merge/register';
import { registerPhase09LocalHistory } from './localHistory/register';
import { registerPhase05HistoryRewriting } from './rewrite/register';
import { registerPhase10Hardening } from './hardening/register';
import { registerPhase01 } from './scm/register';
import { registerPhase13Dialogs } from './scm/dialogs/register';
import { registerPhase07StashShelve } from './stash/register';
import { DEMO_METHODS } from './shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from './ui/webviewHost';

/**
 * GitTree entry point. Kept intentionally thin (master plan §7): P0-T7 builds
 * the Core (executor, model, queue, watchers, mode manager) and every later
 * phase appends exactly one `registerPhaseXX(context, core)` call below its
 * marker — this file is append-only (§0.6).
 */

let corePromise: Promise<Core | undefined> | undefined;

export interface GitTreeApi {
  /** Test-only hook (P0-T10): resolves once discovery completed. */
  getCore(): Promise<Core | undefined> | undefined;
  /** P10-T1: duration of activate()'s synchronous path, for the perf harness. */
  perf?: { activationSyncMs: number };
}

export function activate(context: vscode.ExtensionContext): GitTreeApi {
  const activationStart = performance.now();
  // P10-T4: shared with registerPhases (async, runs after the sync path) so
  // the activation telemetry event reports the real sync-path duration.
  const perf = { activationSyncMs: 0 };
  // -- Core bootstrap (P0-T7) ---------------------------------------------
  // Async on purpose: activation's sync path stays within budget; consumers
  // await the promise.
  corePromise = createCore(context).then((core) => {
    if (core) {
      registerPhases(context, core, perf);
    }
    return core;
  });
  registerPhase00Debug(context);

  perf.activationSyncMs = performance.now() - activationStart;
  return {
    getCore: () => (process.env['GITTREE_TEST'] === '1' ? corePromise : undefined),
    perf,
  };
}

function registerPhases(
  context: vscode.ExtensionContext,
  core: Core,
  perf: { activationSyncMs: number },
): void {
  // -- registerPhase01 (Core SCM) -----------------------------------------
  registerPhase01(context, core);
  // -- registerPhase02 (Branches) -----------------------------------------
  registerPhase02(context, core);
  // -- registerPhase03 (Commit lifecycle) ---------------------------------
  registerPhase03(context, core);
  // -- registerPhase04 (Log, graph, blame) --------------------------------
  registerPhase04(context, core);
  // -- registerPhase05 (History rewriting) --------------------------------
  registerPhase05HistoryRewriting(context, core);
  // -- registerPhase06 (Merge engine) -------------------------------------
  registerPhase06MergeEngine(context, core);
  // -- registerPhase07 (Stash & shelve) -----------------------------------
  registerPhase07StashShelve(context, core);
  // -- registerPhase08 (Provider integrations) ----------------------------
  // -- registerPhase09 (Local History) -------------------------------------
  registerPhase09LocalHistory(context, core);
  // -- registerPhase10 (Hardening) -----------------------------------------
  registerPhase10Hardening(context, core, perf);
  // -- registerPhase11/12 (Commit + Git tool windows) ----------------------
  // Registered inside Phase 03 / Phase 04: both rebuild an existing surface
  // rather than adding one, so their views hang off the phase that owns them.
  // -- registerPhase13 (Dialogs, popups, action hub) -----------------------
  registerPhase13Dialogs(context, core);
}

/** P0 contribution: `gittree.debug.showState` dumps model JSON to an untitled doc. */
function registerPhase00Debug(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.debug.showState', async () => {
      const core = await corePromise;
      const state = core
        ? core.repos.map((r) => ({
            root: r.root,
            gitDir: r.dirs.gitDir,
            workdirGeneration: r.model.workdirGeneration,
            mode: core.mode.mode,
            snapshot: r.model.snapshot,
          }))
        : { error: 'core not available (git not found?)' };
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(state, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  // P0-T9 webview platform kit demo (theme + RPC + VirtualList showcase).
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.debug.webviewDemo', () => {
      const panel = vscode.window.createWebviewPanel(
        'gittree.demo',
        vscode.l10n.t('GitTree Webview Demo'),
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: webviewResourceRoots(context.extensionUri),
        },
      );
      const rpc = new WebviewRpcHost(panel.webview);
      rpc.on(DEMO_METHODS.echo, (params) => {
        const text =
          typeof params === 'object' && params !== null && 'text' in params
            ? String(params.text)
            : '';
        return { echoed: text };
      });
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) rpc.rehydrate();
      });
      panel.onDidDispose(() => rpc.dispose());
      panel.webview.html = buildWebviewHtml({
        app: 'demo',
        webview: panel.webview,
        extensionUri: context.extensionUri,
        title: vscode.l10n.t('GitTree Webview Demo'),
      });
    }),
  );
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
