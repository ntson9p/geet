/**
 * Phase 13 registration: the option-bearing dialogs that replace the
 * QuickPick/InputBox chains standing in for IntelliJ's dialogs (gap analysis
 * S4), plus the popups and the action hub that follow in T5–T7.
 *
 * Own entry point rather than an addition to `registerPhase01`: P13 spans SCM,
 * branches and merge surfaces, so hanging it off any single earlier phase would
 * misfile it. `extension.ts` stays append-only per master §0.6.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import {
  applyPushResult,
  buildPushParams,
  pushDialogHandlers,
  showPushDialog,
  type PushDialogDeps,
} from './pushDialog';

export interface Phase13Registry {
  /** Test seam: the params the dialog would open with. */
  buildPushParams: typeof buildPushParams;
  /** Test seam: the accept half, driven with the payload the webview posts. */
  applyPushResult: (result: Parameters<typeof applyPushResult>[1]) => Promise<string[]>;
  /** Test seam: the request handlers the dialog registers, verbatim. */
  pushHandlers: () => Record<string, (params: unknown) => unknown>;
}

/** The repo a dialog acts on: an explicit argument, else the active editor's, else the only one. */
export function resolveRepo(core: Core, arg?: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    const byArg = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
    if (byArg) return byArg;
  }
  if (arg instanceof vscode.Uri) {
    const byUri = core.repoForPath(arg.fsPath);
    if (byUri) return byUri;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file') {
    const byEditor = core.repoForPath(doc.uri.fsPath);
    if (byEditor) return byEditor;
  }
  return core.repos.length === 1 ? core.repos[0] : undefined;
}

export function registerPhase13Dialogs(
  context: vscode.ExtensionContext,
  core: Core,
): Phase13Registry {
  const trace = (line: string): void => core.output.appendLine(`[dialogs] ${line}`);
  const deps: PushDialogDeps = { core, extensionUri: context.extensionUri, trace };

  // P13-T1: Push. `gittree.sync.push` (P1) stays as the no-questions path; this
  // is the dialog that exposes the flags behind it.
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.push.dialog', async (arg?: unknown) => {
      const one = resolveRepo(core, arg);
      // No unambiguous repo: offer every pushable repo at once, which is also
      // the multi-repo shape the dialog is built for.
      await showPushDialog(deps, one ? [one] : core.repos);
    }),
  );

  const registry: Phase13Registry = {
    buildPushParams,
    applyPushResult: (result) => applyPushResult(deps, result),
    pushHandlers: () => pushDialogHandlers(deps),
  };
  core.debugRegistry.set('phase13', registry);
  return registry;
}
