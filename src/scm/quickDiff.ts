/**
 * QuickDiffProvider (P1-T2): serves the "original" side for the native
 * gutter bars + click-to-peek. Base is the index by default (IntelliJ
 * behavior: bars show unstaged edits), configurable to HEAD. Registration is
 * skipped in companion mode — the built-in git extension already provides
 * bars, and doubling them is the §3 anti-goal.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { repoRelative } from '../core/util/paths';
import { makeRevUri } from '../core/vdocs/revContentProvider';

export type QuickDiffBase = 'index' | 'head';

export function quickDiffBase(): QuickDiffBase {
  const v = vscode.workspace.getConfiguration('gittree').get<string>('quickDiff.base', 'index');
  return v === 'head' ? 'head' : 'index';
}

export class GitTreeQuickDiffProvider implements vscode.QuickDiffProvider {
  constructor(private readonly core: Core) {}

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    const repo = this.core.repoForUri(uri);
    if (!repo) return undefined;
    const rel = repoRelative(repo.root, uri.fsPath);
    if (rel === undefined) return undefined;

    const entry = repo.model.snapshot.statusEntries.find((e) => e.path === rel);
    // Untracked/ignored files have no original — no bars.
    if (entry && (entry.kind === 'untracked' || entry.kind === 'ignored')) return undefined;

    const base = quickDiffBase();
    if (base === 'head') {
      // Follow staged renames back to the HEAD-side name.
      const headRel = entry?.origPath ?? rel;
      return makeRevUri(repo.root, headRel, 'HEAD');
    }
    // Index base: stage 0 (falls back to empty for files not in the index —
    // the provider serves '' which renders as all-added, which is correct).
    return makeRevUri(repo.root, rel, ':0');
  }
}

/**
 * Attaches/detaches the provider per ModeManager (§3): takeover gets bars
 * from us; companion leaves them to the built-in extension.
 */
export function wireQuickDiff(
  core: Core,
  scFor: (repo: RepoHandle) => vscode.SourceControl | undefined,
): vscode.Disposable {
  const provider = new GitTreeQuickDiffProvider(core);

  const apply = (): void => {
    const enable = core.mode.effectiveMode === 'takeover';
    for (const repo of core.repos) {
      const sc = scFor(repo);
      if (sc) sc.quickDiffProvider = enable ? provider : undefined;
    }
  };

  apply();
  const modeSub = core.mode.onDidChangeMode(() => apply());
  const addSub = core.onDidAddRepo(() => apply());
  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('gittree.quickDiff.base')) apply();
  });
  return vscode.Disposable.from(
    new vscode.Disposable(() => modeSub.dispose()),
    new vscode.Disposable(() => addSub.dispose()),
    cfgSub,
  );
}
