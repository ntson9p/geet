/**
 * Conflicts view (P6-T1): the IntelliJ "Conflicts" dialog as a TreeView in
 * the SCM container — file rows with classification badges, per-row Accept
 * Yours / Accept Theirs / Merge…, title-level Accept All / Continue / Abort.
 * Auto-revealed (plus a one-shot toast) when a session starts.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { rowUri } from '../ui/rowDecorations';
import { isSpecialConflict, type ConflictKind, type ConflictSession } from './conflictSession';

export interface ConflictNode {
  session: ConflictSession;
  path: string;
  kind: ConflictKind;
}

function kindLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'both-modified':
      return vscode.l10n.t('both modified');
    case 'added-by-both':
      return vscode.l10n.t('added by both');
    case 'deleted-by-us':
      return vscode.l10n.t('deleted by you');
    case 'deleted-by-them':
      return vscode.l10n.t('deleted by them');
    case 'both-deleted':
      return vscode.l10n.t('deleted by both');
    case 'mode':
      return vscode.l10n.t('mode conflict');
  }
}

export class ConflictsViewProvider implements vscode.TreeDataProvider<ConflictNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private sessions: ConflictSession[] = [];

  setSessions(sessions: ConflictSession[]): void {
    this.sessions = sessions;
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getChildren(node?: ConflictNode): ConflictNode[] {
    if (node) return [];
    const nodes: ConflictNode[] = [];
    for (const session of this.sessions) {
      for (const f of session.files()) {
        nodes.push({ session, path: f.path, kind: f.kind });
      }
    }
    return nodes;
  }

  getTreeItem(node: ConflictNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.posix.basename(node.path),
      vscode.TreeItemCollapsibleState.None,
    );
    const dir = path.posix.dirname(node.path);
    item.description = dir === '.' ? kindLabel(node.kind) : `${dir} · ${kindLabel(node.kind)}`;
    item.tooltip = vscode.l10n.t('{0} — {1} ({2})', node.path, kindLabel(node.kind), node.session.source);
    // POST-P14cd: Geet's own address, marked `!` by Geet rather than by
    // whichever extension marks files on disk.
    item.resourceUri = rowUri('conflict', path.join(node.session.repo.root, node.path), 'conflicted');
    item.iconPath = new vscode.ThemeIcon(
      node.kind === 'both-modified' || node.kind === 'added-by-both' ? 'git-merge' : 'warning',
      new vscode.ThemeColor('gittree.color.conflicted'),
    );
    item.contextValue = isSpecialConflict(node.kind) ? 'conflict:special' : 'conflict:file';
    item.command = {
      command: 'gittree.merge.open',
      title: vscode.l10n.t('Merge…'),
      arguments: [node],
    };
    return item;
  }
}
