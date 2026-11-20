/**
 * Error UX final pass (P10-T4): one presenter for classified git failures —
 * actionable copy per GitError.kind, a Help button deep-linking the shipped
 * docs, and a Report Issue button that pre-fills a fully sanitized issue
 * (versions, capability map, hashed-path trace tail — never repo content).
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { ERROR_DOCS, newIssueUrl, type IssueInfo } from '../core/errorUx';
import { GitError, type GitErrorKind } from '../core/git/errors';

/** Actionable copy — every kind tells the user what to DO next. */
export function errorCopy(kind: GitErrorKind): string {
  switch (kind) {
    case 'index-lock':
      return vscode.l10n.t(
        'Git\'s index is locked by another process. Geet retries automatically — if this persists, close other git tools or remove .git/index.lock.',
      );
    case 'would-overwrite-checkout':
      return vscode.l10n.t(
        'Checkout would overwrite your local changes. Use Smart Checkout to stash and re-apply them automatically, or commit first.',
      );
    case 'merge-conflict':
      return vscode.l10n.t(
        'The operation stopped on merge conflicts. Resolve them in the merge editor (F7 jumps between conflicts), then continue the operation.',
      );
    case 'auth':
      return vscode.l10n.t(
        'Git could not authenticate. VS Code should prompt for credentials; if it keeps failing, check the remote URL and your credential helper.',
      );
    case 'not-fast-forward':
      return vscode.l10n.t(
        'The remote has commits you do not have yet. Pull (or fetch and rebase) before pushing.',
      );
    case 'no-upstream':
      return vscode.l10n.t(
        'The current branch has no upstream. Push and set the upstream, or configure one with "git branch --set-upstream-to".',
      );
    case 'unknown':
      return vscode.l10n.t(
        'A git operation failed. The Geet output channel has the full command and error text.',
      );
  }
}

export function collectIssueInfo(
  context: vscode.ExtensionContext,
  core: Core,
  errorKind?: GitErrorKind,
): IssueInfo {
  const capabilities: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(core.git.caps)) {
    if (typeof v === 'boolean') capabilities[k] = v;
  }
  const info: IssueInfo = {
    extensionVersion: (context.extension.packageJSON as { version: string }).version,
    vscodeVersion: vscode.version,
    os: `${os.platform()} ${os.release()}`,
    gitVersion: core.git.version,
    capabilities,
    traceTail: core.getTraceTail(),
  };
  if (errorKind !== undefined) info.errorKind = errorKind;
  return info;
}

/**
 * Shows the classified-error dialog. Feature code with a richer flow (smart
 * checkout, conflict sessions) keeps its own UX; this is the generic path.
 */
export async function presentGitError(
  context: vscode.ExtensionContext,
  core: Core,
  err: unknown,
): Promise<void> {
  const kind: GitErrorKind = err instanceof GitError ? err.kind : 'unknown';
  const help = vscode.l10n.t('Help');
  const report = vscode.l10n.t('Report Issue');
  const choice = await vscode.window.showErrorMessage(errorCopy(kind), help, report);
  if (choice === help) {
    await vscode.env.openExternal(vscode.Uri.parse(ERROR_DOCS[kind]));
  } else if (choice === report) {
    await vscode.commands.executeCommand('gittree.reportIssue', kind);
  }
}

export function registerErrorReporting(context: vscode.ExtensionContext, core: Core): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.reportIssue', async (kind?: unknown) => {
      const errorKind =
        typeof kind === 'string' && kind in ERROR_DOCS ? (kind as GitErrorKind) : undefined;
      const url = newIssueUrl(collectIssueInfo(context, core, errorKind));
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );
}
