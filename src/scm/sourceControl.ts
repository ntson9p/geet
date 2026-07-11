/**
 * SourceControl registration & resource groups (P1-T1). One SourceControl per
 * repository, four baseline groups (P3 refines): merge / staged / changes /
 * untracked. All state flows from RepositoryModel — this class never runs
 * git.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import {
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  type StatusEntry,
} from '../core/model/statusEntry';
import { contextValueFor, decorationsFor, type GroupId } from './resourceDecorations';

export class GitTreeResourceState implements vscode.SourceControlResourceState {
  readonly resourceUri: vscode.Uri;
  readonly decorations: vscode.SourceControlResourceDecorations;
  readonly contextValue: string;
  readonly command: vscode.Command;

  constructor(
    readonly repoRoot: string,
    readonly entry: StatusEntry,
    readonly group: GroupId,
  ) {
    this.resourceUri = vscode.Uri.file(path.join(repoRoot, entry.path));
    this.decorations = decorationsFor(entry, group);
    this.contextValue = contextValueFor(entry, group);
    this.command = {
      command: 'gittree.openDiff',
      title: vscode.l10n.t('Open Changes'),
      arguments: [this],
    };
  }
}

export class GitTreeSourceControl implements vscode.Disposable {
  readonly sc: vscode.SourceControl;
  readonly mergeGroup: vscode.SourceControlResourceGroup;
  readonly stagedGroup: vscode.SourceControlResourceGroup;
  readonly changesGroup: vscode.SourceControlResourceGroup;
  readonly untrackedGroup: vscode.SourceControlResourceGroup;
  private readonly subs: Array<{ dispose(): void }> = [];

  constructor(readonly repo: RepoHandle) {
    this.sc = vscode.scm.createSourceControl('gittree', 'GitTree', vscode.Uri.file(repo.root));
    // acceptInputCommand is attached by the commit registration (P1-T7).

    this.mergeGroup = this.sc.createResourceGroup('merge', vscode.l10n.t('Merge Changes'));
    this.mergeGroup.hideWhenEmpty = true;
    this.stagedGroup = this.sc.createResourceGroup('staged', vscode.l10n.t('Staged Changes'));
    this.stagedGroup.hideWhenEmpty = true;
    this.changesGroup = this.sc.createResourceGroup('changes', vscode.l10n.t('Changes'));
    this.untrackedGroup = this.sc.createResourceGroup('untracked', vscode.l10n.t('Untracked'));
    this.untrackedGroup.hideWhenEmpty = true;

    this.subs.push(
      repo.model.onDidChange((sections) => {
        if (sections.has('status') || sections.has('head') || sections.has('op')) this.update();
      }),
    );
    this.update();
  }

  update(): void {
    const snap = this.repo.model.snapshot;

    const merge: GitTreeResourceState[] = [];
    const staged: GitTreeResourceState[] = [];
    const changes: GitTreeResourceState[] = [];
    const untracked: GitTreeResourceState[] = [];

    for (const entry of snap.statusEntries) {
      if (entry.kind === 'ignored') continue;
      if (isConflicted(entry)) {
        merge.push(new GitTreeResourceState(this.repo.root, entry, 'merge'));
        continue;
      }
      if (isUntracked(entry)) {
        untracked.push(new GitTreeResourceState(this.repo.root, entry, 'untracked'));
        continue;
      }
      // A file can be both staged and worktree-modified (e.g. "MM").
      if (isStaged(entry)) staged.push(new GitTreeResourceState(this.repo.root, entry, 'staged'));
      if (isUnstaged(entry)) changes.push(new GitTreeResourceState(this.repo.root, entry, 'changes'));
    }

    this.mergeGroup.resourceStates = merge;
    this.stagedGroup.resourceStates = staged;
    this.changesGroup.resourceStates = changes;
    this.untrackedGroup.resourceStates = untracked;

    this.sc.count = merge.length + staged.length + changes.length + untracked.length;

    const branch = snap.detached
      ? (snap.headSha ?? '').slice(0, 7)
      : (snap.headRef ?? vscode.l10n.t('no branch'));
    this.sc.inputBox.placeholder = vscode.l10n.t(
      'Message (press {0} to commit on "{1}")',
      process.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter',
      branch,
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.sc.dispose();
  }
}
