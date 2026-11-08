/**
 * Which repository a command means (POST-QA F6).
 *
 * In a multi-root workspace, commands run from the palette used either to
 * refuse ("Open a repository first." with three repositories open) or to act
 * on the first repository found, silently: GitTree: Push could push a
 * repository the user was not looking at. IntelliJ's Merge, Rebase, Reset,
 * Pull and Stash dialogs carry a *Git Root* chooser for this; GitTree's
 * dialogs do not, so the choice is asked first.
 *
 * The order is the one every caller already used — the repository the command
 * names, else the active editor's — and only when neither says, and there is
 * more than one, a quick pick asks.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { showInfo } from './notices';

/** The repository an argument names: a root path, a Uri, or an object carrying either. */
export function repoNamedBy(core: Core, arg: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    return core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
  }
  if (arg instanceof vscode.Uri) return core.repoForPath(arg.fsPath);
  if (typeof arg === 'object' && arg !== null) {
    const o = arg as { repo?: unknown; repoRoot?: unknown; root?: unknown };
    if (typeof o.repo === 'object' && o.repo !== null && 'root' in o.repo) {
      const root = (o.repo as { root?: unknown }).root;
      if (typeof root === 'string') return repoNamedBy(core, root);
    }
    if (typeof o.repoRoot === 'string') return repoNamedBy(core, o.repoRoot);
    if (typeof o.root === 'string') return repoNamedBy(core, o.root);
  }
  return undefined;
}

/** Named by the argument, else the active editor's, else the only one — no asking. */
export function implicitRepo(core: Core, arg?: unknown): RepoHandle | undefined {
  const named = repoNamedBy(core, arg);
  if (named) return named;
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.scheme === 'file') {
    const byEditor = core.repoForPath(doc.uri.fsPath);
    if (byEditor) return byEditor;
  }
  return core.repos.length === 1 ? core.repos[0] : undefined;
}

/**
 * The repository the command acts on, asking when it is not clear. Undefined
 * when there is none, or the pick was dismissed — the command then does
 * nothing, which is what Escape means.
 */
export async function chooseRepo(core: Core, arg?: unknown, placeHolder?: string): Promise<RepoHandle | undefined> {
  const known = implicitRepo(core, arg);
  if (known) return known;
  if (core.repos.length === 0) {
    showInfo(vscode.l10n.t('Open a repository first.'));
    return undefined;
  }
  const items = core.repos.map((repo) => {
    const snap = repo.model.snapshot;
    const branch = snap.detached ? vscode.l10n.t('detached HEAD') : snap.headRef ?? '';
    return { label: path.basename(repo.root), description: branch, detail: repo.root, repo };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeHolder ?? vscode.l10n.t('Select a repository'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.repo;
}
