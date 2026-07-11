import * as vscode from 'vscode';
import { createCore, type Core } from './core/core';

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
}

export function activate(context: vscode.ExtensionContext): GitTreeApi {
  // -- Core bootstrap (P0-T7) ---------------------------------------------
  // Async on purpose: activation's sync path stays within budget; consumers
  // await the promise.
  corePromise = createCore(context).then((core) => {
    if (core) {
      registerPhases(context, core);
    }
    return core;
  });
  registerPhase00Debug(context);

  return {
    getCore: () => (process.env['GITTREE_TEST'] === '1' ? corePromise : undefined),
  };
}

function registerPhases(_context: vscode.ExtensionContext, _core: Core): void {
  // -- registerPhase01 (Core SCM) -----------------------------------------
  // -- registerPhase02 (Branches) -----------------------------------------
  // -- registerPhase03 (Commit lifecycle) ---------------------------------
  // -- registerPhase04 (Log, graph, blame) --------------------------------
  // -- registerPhase05 (History rewriting) --------------------------------
  // -- registerPhase06 (Merge engine) -------------------------------------
  // -- registerPhase07 (Stash & shelve) -----------------------------------
  // -- registerPhase08 (Provider integrations) ----------------------------
  // -- registerPhase09 (Local History) -------------------------------------
  // -- registerPhase10 (Hardening) -----------------------------------------
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
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
