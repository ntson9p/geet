/**
 * Compare with Current / Diff with Working Tree (P2-T5). Commits panel is a
 * TreeView (two left/right sections from `git log --left-right A...B`);
 * file diffs open in the multi-diff editor via `vscode.changes` with
 * gittree-rev pairs. P4-T5 upgrades the commits panel to the log webview —
 * command ids stay stable.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import { LEFT_RIGHT_FORMAT, parseLeftRight, parseNameStatusZ, type CompareCommit } from './parsing';

export interface CompareState {
  repo: RepoHandle;
  /** The selected branch (left side of A...B). */
  branch: string;
  /** The current branch/HEAD at invocation time. */
  current: string;
  commits: CompareCommit[];
}

type CompareNode =
  | { kind: 'section'; label: string; side: 'left' | 'right' }
  | { kind: 'commit'; commit: CompareCommit };

export class CompareViewProvider implements vscode.TreeDataProvider<CompareNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  state: CompareState | undefined;

  setState(state: CompareState): void {
    this.state = state;
    this._onDidChange.fire();
  }

  getTreeItem(node: CompareNode): vscode.TreeItem {
    if (node.kind === 'section') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.side === 'left' ? 'arrow-left' : 'arrow-right');
      item.contextValue = 'compare:section';
      return item;
    }
    const c = node.commit;
    const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.None);
    item.description = `${c.sha.slice(0, 7)} · ${c.author}`;
    item.tooltip = new Date(c.time * 1000).toLocaleString();
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'compare:commit';
    item.command = {
      command: 'gittree.compare.showCommit',
      title: vscode.l10n.t('Show Commit'),
      arguments: [c.sha],
    };
    return item;
  }

  getChildren(node?: CompareNode): CompareNode[] {
    if (!this.state) return [];
    if (!node) {
      return [
        {
          kind: 'section',
          side: 'left',
          label: vscode.l10n.t('Commits on {0} ({1})', this.state.branch, this.count('left')),
        },
        {
          kind: 'section',
          side: 'right',
          label: vscode.l10n.t('Commits on {0} ({1})', this.state.current, this.count('right')),
        },
      ];
    }
    if (node.kind === 'section') {
      return this.state.commits
        .filter((c) => c.side === node.side)
        .map((commit) => ({ kind: 'commit' as const, commit }));
    }
    return [];
  }

  private count(side: 'left' | 'right'): number {
    return this.state?.commits.filter((c) => c.side === side).length ?? 0;
  }
}

export class CompareService {
  readonly provider = new CompareViewProvider();
  private view: vscode.TreeView<CompareNode> | undefined;

  constructor(private readonly core: Core) {}

  register(context: vscode.ExtensionContext): void {
    this.view = vscode.window.createTreeView('gittree.compare', {
      treeDataProvider: this.provider,
      showCollapseAll: false,
    });
    context.subscriptions.push(this.view);

    context.subscriptions.push(
      vscode.commands.registerCommand('gittree.branches.compareWithCurrent', (repoRoot: unknown, branch: unknown) =>
        this.compareWithCurrent(String(repoRoot), String(branch)),
      ),
      vscode.commands.registerCommand('gittree.branches.diffWithWorkingTree', (repoRoot: unknown, branch: unknown) =>
        this.diffWithWorkingTree(String(repoRoot), String(branch)),
      ),
      vscode.commands.registerCommand('gittree.compare.showFileDiff', () => this.showFileDiff()),
      vscode.commands.registerCommand('gittree.compare.showCommit', (sha: unknown) =>
        this.showCommit(String(sha)),
      ),
    );
  }

  private repoOf(root: string): RepoHandle | undefined {
    return this.core.getRepo(root) ?? this.core.repos[0];
  }

  async compareWithCurrent(repoRoot: string, branch: string): Promise<void> {
    const repo = this.repoOf(repoRoot);
    if (!repo) return;
    const current = repo.model.snapshot.headRef ?? 'HEAD';
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Compare {0} with {1}', branch, current),
      kind: 'read',
      run: (git, token) =>
        git.exec(
          repo.root,
          ['log', '--left-right', `--format=${LEFT_RIGHT_FORMAT}`, `${branch}...HEAD`],
          { structured: true, noOptionalLocks: true, token },
        ),
    });
    this.provider.setState({ repo, branch, current, commits: parseLeftRight(result.stdout) });
    await vscode.commands.executeCommand('setContext', 'gittree.compare.active', true);
    if (this.view) {
      this.view.title = vscode.l10n.t('Compare: {0} ⟷ {1}', branch, current);
      await vscode.commands.executeCommand('gittree.compare.focus');
    }
  }

  /** Title action: tip-vs-tip multi-diff (IntelliJ file-diff semantics). */
  async showFileDiff(): Promise<void> {
    const state = this.provider.state;
    if (!state) return;
    const { repo, branch } = state;
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Diff {0}…HEAD', branch),
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['diff', '--name-status', '-z', '-M', branch, 'HEAD'], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const entries = parseNameStatusZ(result.stdout);
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = entries.map((e) => {
      const fileUri = vscode.Uri.file(path.join(repo.root, e.path));
      const left =
        e.status === 'A' ? undefined : makeRevUri(repo.root, e.origPath ?? e.path, branch);
      const right = e.status === 'D' ? undefined : makeRevUri(repo.root, e.path, 'HEAD');
      return [fileUri, left, right];
    });
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('{0} ⟷ {1}', branch, state.current),
      changes,
    );
  }

  async diffWithWorkingTree(repoRoot: string, branch: string): Promise<void> {
    const repo = this.repoOf(repoRoot);
    if (!repo) return;
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Diff {0} with working tree', branch),
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['diff', '--name-status', '-z', '-M', branch], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const entries = parseNameStatusZ(result.stdout);
    const changes: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = entries.map((e) => {
      const fileUri = vscode.Uri.file(path.join(repo.root, e.path));
      const left =
        e.status === 'A' ? undefined : makeRevUri(repo.root, e.origPath ?? e.path, branch);
      const right = e.status === 'D' ? undefined : fileUri;
      return [fileUri, left, right];
    });
    await vscode.commands.executeCommand(
      'vscode.changes',
      vscode.l10n.t('{0} ⟷ Working Tree', branch),
      changes,
    );
  }

  /** Interim commit details (P4 log webview replaces this). */
  private async showCommit(sha: string): Promise<void> {
    const repo = this.provider.state?.repo ?? this.core.repos[0];
    if (!repo) return;
    const result = await repo.queue.enqueue({
      label: vscode.l10n.t('Show {0}', sha.slice(0, 7)),
      kind: 'read',
      run: (git, token) =>
        git.exec(repo.root, ['show', '--stat', '--patch', '--format=medium', sha], {
          structured: true,
          noOptionalLocks: true,
          token,
        }),
    });
    const doc = await vscode.workspace.openTextDocument({
      language: 'diff',
      content: result.stdout,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}
