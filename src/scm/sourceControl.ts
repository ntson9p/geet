/**
 * SourceControl registration (P1-T1, gutted by P14-T2).
 *
 * The four resource groups and their 31 `scm/*` menu entries are gone: the
 * commit tool window is the only commit surface now, so nothing was rendering
 * them. What remains is the shell the P1 quick-diff provider, status bar and
 * count badge still hang off; P14-T4 removes that too and with it the last
 * `vscode.scm` reference in the codebase.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import { isConflicted, isStaged, isUnstaged, isUntracked, type StatusEntry } from '../core/model/statusEntry';

/** Which side of a status entry a consumer is looking at. */
export type GroupId = 'merge' | 'staged' | 'changes' | 'untracked';

/**
 * A file + the side of it being acted on. Once implemented
 * `vscode.SourceControlResourceState`; now a plain value object that the diff
 * and file-op commands pass around.
 */
export class GitTreeResourceState {
  constructor(
    readonly repoRoot: string,
    readonly entry: StatusEntry,
    readonly group: GroupId,
  ) {}

  get resourceUri(): vscode.Uri {
    return vscode.Uri.file(path.join(this.repoRoot, this.entry.path));
  }
}

export class GitTreeSourceControl implements vscode.Disposable {
  readonly sc: vscode.SourceControl;
  private readonly subs: Array<{ dispose(): void }> = [];

  constructor(readonly repo: RepoHandle) {
    this.sc = vscode.scm.createSourceControl('gittree', 'GitTree', vscode.Uri.file(repo.root));
    // P14-T2: the commit window owns the message; leaving a second input box on
    // screen would give the user two places to type.
    this.sc.inputBox.visible = false;

    this.subs.push(
      repo.model.onDidChange((sections) => {
        if (sections.has('status') || sections.has('head') || sections.has('op')) this.update();
      }),
    );
    this.update();
  }

  update(): void {
    const snap = this.repo.model.snapshot;
    let count = 0;
    for (const entry of snap.statusEntries) {
      if (entry.kind === 'ignored') continue;
      if (isConflicted(entry) || isUntracked(entry)) {
        count += 1;
        continue;
      }
      // A file can be both staged and worktree-modified (e.g. "MM").
      if (isStaged(entry)) count += 1;
      if (isUnstaged(entry)) count += 1;
    }
    this.sc.count = count;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.sc.dispose();
  }
}
