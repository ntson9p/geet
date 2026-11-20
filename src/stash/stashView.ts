/**
 * P7-T2 — Stash UI: TreeView `gittree.stashes` in the SCM container. Stash
 * rows (`stash@{0} · message · 2h ago · from main`) expand to file children;
 * clicking a file diffs the stashed content against the current working-tree
 * file when it exists (IntelliJ "diff stash against working tree"), falling
 * back to the pre-stash pair for deletions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { StashInfo } from '../core/git/parsers/stashList';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import { rowUri } from '../ui/rowDecorations';
import type { StashFile, StashService } from './stashService';

export type StashNode =
  | { kind: 'stash'; repo: RepoHandle; service: StashService; info: StashInfo }
  | { kind: 'file'; repo: RepoHandle; info: StashInfo; file: StashFile };

export function relativeTime(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (s < 60) return vscode.l10n.t('just now');
  const m = Math.floor(s / 60);
  if (m < 60) return vscode.l10n.t('{0}m ago', m);
  const h = Math.floor(m / 60);
  if (h < 24) return vscode.l10n.t('{0}h ago', h);
  const d = Math.floor(h / 24);
  if (d < 30) return vscode.l10n.t('{0}d ago', d);
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

/** Diff a stashed file against the live working tree (or pre-stash base). */
export function stashDiffSides(
  repo: RepoHandle,
  file: StashFile,
): { left: vscode.Uri; right: vscode.Uri; title: string } {
  const base = path.posix.basename(file.path);
  const stashed = makeRevUri(repo.root, file.right.rel, file.right.ref);
  const worktree = vscode.Uri.file(path.join(repo.root, file.path));
  if (file.status === 'deleted') {
    // The stash records a deletion — show what was deleted vs its base.
    return {
      left: makeRevUri(repo.root, file.left?.rel ?? file.path, file.left?.ref ?? `${file.right.ref}^`),
      right: stashed,
      title: vscode.l10n.t('{0} (deleted in {1})', base, file.right.ref.replace(/\^3$/u, '')),
    };
  }
  if (!fs.existsSync(worktree.fsPath)) {
    // Stashed-away untracked file: nothing in the worktree — HEAD has no
    // version of it either, so the rev provider serves an empty right side.
    return {
      left: stashed,
      right: makeRevUri(repo.root, file.path, 'HEAD'),
      title: vscode.l10n.t(
        '{0} ({1} ↔ not in working tree)',
        base,
        file.right.ref.replace(/\^3$/u, ''),
      ),
    };
  }
  return {
    left: stashed,
    right: worktree,
    title: vscode.l10n.t('{0} ({1} ↔ Working Tree)', base, file.right.ref.replace(/\^3$/u, '')),
  };
}

export class StashViewProvider implements vscode.TreeDataProvider<StashNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private repos: Array<{ repo: RepoHandle; service: StashService }> = [];

  setRepos(repos: Array<{ repo: RepoHandle; service: StashService }>): void {
    this.repos = repos;
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  async getChildren(node?: StashNode): Promise<StashNode[]> {
    if (!node) {
      const rows: StashNode[] = [];
      for (const { repo, service } of this.repos) {
        for (const info of service.list()) {
          rows.push({ kind: 'stash', repo, service, info });
        }
      }
      return rows;
    }
    if (node.kind === 'stash') {
      const files = await node.service.getStashFiles(node.info.index);
      return files.map((file) => ({ kind: 'file', repo: node.repo, info: node.info, file }));
    }
    return [];
  }

  getTreeItem(node: StashNode): vscode.TreeItem {
    if (node.kind === 'stash') {
      const item = new vscode.TreeItem(
        `${node.info.selector} · ${node.info.message}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      const from = node.info.branch !== undefined ? ` · ${vscode.l10n.t('from {0}', node.info.branch)}` : '';
      item.description = `${relativeTime(node.info.time)}${from}`;
      item.tooltip = `${node.info.message}\n${node.info.sha}`;
      item.iconPath = new vscode.ThemeIcon('archive');
      item.contextValue = 'stash:entry';
      item.id = `${node.repo.root}#${node.info.sha}`;
      return item;
    }
    const name = path.posix.basename(node.file.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(node.file.path);
    const description = dir === '.' ? node.file.status : `${dir} · ${node.file.status}`;
    item.description = description;
    // POST-P14cd: Geet's own address, marked with what the stash did to the
    // file. A `file:` one let VS Code's Git mark the row with the file's status
    // now, which says nothing about the stash.
    const fullPath = path.join(node.repo.root, node.file.path);
    item.resourceUri = rowUri('stash', fullPath, node.file.status);
    // The hover a `file:` address gave the row; under another scheme it would be
    // the address. VS Code reads a text tooltip out as the row's name, so the
    // name a screen reader hears is set as it was: the label and description.
    item.tooltip = fullPath;
    item.accessibilityInformation = { label: `${name} ${description}` };
    item.iconPath = new vscode.ThemeIcon(
      node.file.status === 'deleted' ? 'diff-removed' : node.file.status === 'untracked' ? 'diff-added' : 'diff-modified',
    );
    item.contextValue = 'stash:file';
    const sides = stashDiffSides(node.repo, node.file);
    item.command = {
      command: 'vscode.diff',
      title: vscode.l10n.t('Diff Against Working Tree'),
      arguments: [sides.left, sides.right, sides.title],
    };
    return item;
  }
}
