import * as vscode from 'vscode';

/**
 * GitTree entry point. Kept intentionally thin (master plan §7): P0-T7 builds
 * the Core (executor, model, queue, watchers, mode manager) and every later
 * phase appends exactly one `registerPhaseXX(context, core)` call below its
 * marker — this file is append-only (§0.6).
 */
export function activate(_context: vscode.ExtensionContext): void {
  // -- Core bootstrap (P0-T7) ---------------------------------------------
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

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
