/**
 * Compare with Current, Show Files Diff and Show Diff with Working Tree (P2-T5),
 * split the way IntelliJ splits them:
 *
 * - `Compare with 'X'` is a log: a Log tab over `X...current`, whose Changed Files
 *   pane walks a commit. IntelliJ's `GitCompareBranchesUi` is two logs in one tab.
 * - The other two are a list of files: the `gittree.compare` pane, after IntelliJ's
 *   `ChangesBrowserToolWindow`, which each request replaces. A file opens a diff
 *   that walks the whole list, or the rows selected when there are several.
 *
 * The pane's Show All Files in Multi-Diff still gives VS Code's page of all of them.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { makeRevUri } from '../core/vdocs/revContentProvider';
import type { DiffEntry, DiffSessionRegistry } from '../diff/diffSession';
import { hasIdenticalSides } from '../diff/navigationStep';
import { nextMark } from '../diff/onScreen';
import { settleWorktreeSide } from '../diff/worktreeSide';
import {
  allFiles,
  buildTree,
  diffWalk,
  selectedFiles,
  selectionFollowing,
  type TreeDirNode,
  type TreeFileNode,
  type TreeNode,
} from '../shared/treeModel';
import {
  comparisonFrom,
  diffArgs,
  goesIntoDiff,
  revParseArgs,
  sidesOf,
  STATUS_BADGE,
  STATUS_COLOR,
  statusKind,
  type Comparison,
  type CompareStatusKind,
} from './compareModel';
import { parseNameStatusZ, type NameStatusEntry } from './parsing';

const VIEW_ID = 'gittree.compare';
/** A row's URI. It names a file for VS Code's icon theme, and carries its status for the decoration. */
const ROW_SCHEME = 'gittree-compare';
const SEQUENCE_ID = 'compare';

export interface CompareState {
  readonly repo: RepoHandle;
  readonly comparison: Comparison;
  readonly files: readonly NameStatusEntry[];
  readonly nodes: readonly TreeNode[];
}

/** The colours and letters of the rows, which VS Code only takes from a decoration. */
class CompareRowDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ROW_SCHEME || uri.query.length === 0) return undefined;
    const kind = statusKind(uri.query);
    return new vscode.FileDecoration(
      STATUS_BADGE[kind],
      statusWord(kind),
      new vscode.ThemeColor(STATUS_COLOR[kind]),
    );
  }
}

function statusWord(kind: CompareStatusKind): string {
  switch (kind) {
    case 'added':
      return vscode.l10n.t('Added');
    case 'modified':
      return vscode.l10n.t('Modified');
    case 'deleted':
      return vscode.l10n.t('Deleted');
    case 'renamed':
      return vscode.l10n.t('Renamed');
    case 'conflicted':
      return vscode.l10n.t('Conflicted');
  }
}

function rowUri(rowPath: string, status?: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ROW_SCHEME, path: `/${rowPath}`, query: status ?? '' });
}

export class CompareViewProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  state: CompareState | undefined;
  /** The file whose diff, opened from this list, is on screen. */
  showing: string | undefined;
  private files = new Map<string, NameStatusEntry>();
  private fileNodes = new Map<string, TreeFileNode>();
  private parents = new Map<TreeNode, TreeDirNode>();

  /** Marks the row of the file on screen, and only that one. */
  setShowing(filePath: string | undefined): void {
    if (filePath === this.showing) return;
    const before = this.showing;
    this.showing = filePath;
    for (const p of [before, filePath]) {
      const node = p !== undefined ? this.fileNodes.get(p) : undefined;
      if (node) this.changed.fire(node);
    }
  }

  setState(state: CompareState | undefined): void {
    this.state = state;
    this.files = new Map(state?.files.map((f) => [f.path, f]));
    this.fileNodes = new Map();
    this.parents = new Map();
    const index = (nodes: readonly TreeNode[], parent: TreeDirNode | undefined): void => {
      for (const node of nodes) {
        if (parent) this.parents.set(node, parent);
        if (node.kind === 'dir') index(node.children, node);
        else this.fileNodes.set(node.path, node);
      }
    };
    index(state?.nodes ?? [], undefined);
    this.changed.fire(undefined);
  }

  file(filePath: string): NameStatusEntry | undefined {
    return this.files.get(filePath);
  }

  fileNode(filePath: string): TreeFileNode | undefined {
    return this.fileNodes.get(filePath);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'dir') {
      // Open on every new list, as IntelliJ's trees are. The id keeps what the
      // user closed when the same list is read again.
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.path;
      item.resourceUri = rowUri(node.path);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description =
        node.fileCount === 1
          ? vscode.l10n.t('1 file')
          : vscode.l10n.t('{0} files', node.fileCount);
      item.tooltip = node.path;
      item.contextValue = 'compare:dir';
      return item;
    }
    const file = this.files.get(node.path);
    // The file on screen is lit the way VS Code lights a name it found: the
    // label's highlight, which a tree view's own API can draw.
    const label: string | vscode.TreeItemLabel =
      node.path === this.showing ? { label: node.name, highlights: [[0, node.name.length]] } : node.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = node.path;
    item.resourceUri = rowUri(node.path, file?.status);
    item.iconPath = vscode.ThemeIcon.File;
    if (file?.origPath !== undefined) item.description = `← ${file.origPath}`;
    item.tooltip = node.path;
    item.contextValue = 'compare:file';
    item.command = {
      command: 'gittree.compare.openFile',
      title: vscode.l10n.t('Show Diff'),
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return [...(this.state?.nodes ?? [])];
    return node.kind === 'dir' ? [...node.children] : [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node);
  }
}

interface CompareRequest {
  readonly repo: RepoHandle;
  readonly left: string;
  /** None: the working tree. */
  readonly right: string | undefined;
}

export class CompareService {
  readonly provider = new CompareViewProvider();
  private view: vscode.TreeView<TreeNode> | undefined;
  /** What the pane shows, to read it again. */
  private request: CompareRequest | undefined;
  /** Bumped by each read, so a slow one never overwrites what was asked for since. */
  private generation = 0;
  private lastClick: { readonly path: string; readonly at: number } | undefined;
  /** The diff on screen walks all of the list, rather than the rows that were selected. */
  private walksWholeList = false;

  constructor(private readonly core: Core) {}

  register(context: vscode.ExtensionContext): void {
    this.view = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.provider,
      showCollapseAll: true,
      canSelectMany: true,
    });
    context.subscriptions.push(
      this.view,
      vscode.window.registerFileDecorationProvider(new CompareRowDecorations()),
      vscode.commands.registerCommand('gittree.branches.compareWithCurrent', (repoRoot: unknown, branch: unknown) =>
        this.compareWithCurrent(String(repoRoot), String(branch)),
      ),
      vscode.commands.registerCommand('gittree.branches.diffWithWorkingTree', (repoRoot: unknown, branch: unknown) =>
        this.diffWithWorkingTree(String(repoRoot), String(branch)),
      ),
      vscode.commands.registerCommand('gittree.compare.showFilesDiff', (repoRoot: unknown, a: unknown, b: unknown) =>
        this.showFilesDiff(String(repoRoot), String(a), String(b)),
      ),
      vscode.commands.registerCommand('gittree.compare.openFile', (node: TreeFileNode) => this.onRowClicked(node)),
      vscode.commands.registerCommand(
        'gittree.compare.openChanges',
        (node: TreeNode | undefined, selected: readonly TreeNode[] | undefined) => this.showDiff(node, selected),
      ),
      vscode.commands.registerCommand('gittree.compare.openAll', () => this.openAll()),
      vscode.commands.registerCommand('gittree.compare.refresh', () => this.read()),
      vscode.commands.registerCommand('gittree.compare.close', () => this.close()),
    );
  }

  private repoOf(root: string): RepoHandle | undefined {
    return this.core.getRepo(root) ?? this.core.repos[0];
  }

  private sessions(): Pick<DiffSessionRegistry, 'open' | 'update'> | undefined {
    return (this.core.debugRegistry.get('phase14') as { sessions: DiffSessionRegistry } | undefined)?.sessions;
  }

  /** The two branches' commits, each commit with its files: a log, like IntelliJ's. */
  async compareWithCurrent(repoRoot: string, branch: string): Promise<void> {
    const repo = this.repoOf(repoRoot);
    if (repo) await vscode.commands.executeCommand('gittree.branches.compareInLog', repo.root, branch);
  }

  /** Every file that differs between two revisions, tip against tip. */
  async showFilesDiff(repoRoot: string, left: string, right: string): Promise<void> {
    const repo = this.repoOf(repoRoot);
    if (repo) await this.show({ repo, left, right });
  }

  async diffWithWorkingTree(repoRoot: string, branch: string): Promise<void> {
    const repo = this.repoOf(repoRoot);
    if (repo) await this.show({ repo, left: branch, right: undefined });
  }

  private async show(request: CompareRequest): Promise<void> {
    this.request = request;
    this.walksWholeList = false;
    // A diff of the comparison this one replaces may stay up, but not in this list.
    this.provider.setShowing(undefined);
    this.provider.setState(undefined);
    if (this.view) {
      this.view.description = undefined;
      this.view.message = vscode.l10n.t('Loading…');
    }
    await vscode.commands.executeCommand('setContext', 'gittree.compare.active', true);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.read();
  }

  /** Reads the list. Everything in it stays as it was on screen until the answer is in. */
  private async read(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const generation = ++this.generation;
    let state: CompareState | undefined;
    try {
      state = await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () => this.load(request));
    } catch (err) {
      if (generation !== this.generation) return;
      this.provider.setState(undefined);
      if (this.view) this.view.message = vscode.l10n.t('Could not load the changes.');
      const reason = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not load the changes: {0}', reason));
      return;
    }
    if (generation !== this.generation) return;
    this.provider.setState(state);
    this.describe(state);
    if (state && this.walksWholeList) {
      this.sessions()?.update(
        SEQUENCE_ID,
        allFiles(state.nodes).flatMap((p) => this.entriesOf(state, [p])),
      );
    }
  }

  private async load(request: CompareRequest): Promise<CompareState | undefined> {
    const { repo, left, right } = request;
    return repo.queue.enqueue({
      label: vscode.l10n.t('Diff {0} with {1}', left, right ?? vscode.l10n.t('working tree')),
      kind: 'read',
      run: async (git, token) => {
        const options = { structured: true, noOptionalLocks: true, token };
        const resolved = await git.exec(repo.root, revParseArgs(left, right), options);
        const comparison = comparisonFrom(left, right, resolved.stdout);
        if (!comparison) return undefined;
        const listed = await git.exec(repo.root, diffArgs(comparison), options);
        const files = parseNameStatusZ(listed.stdout);
        return { repo, comparison, files, nodes: buildTree(files.map((f) => f.path)) };
      },
    });
  }

  private describe(state: CompareState | undefined): void {
    if (!this.view) return;
    if (!state) {
      this.view.description = undefined;
      this.view.message = vscode.l10n.t('Could not load the changes.');
      return;
    }
    const count = state.files.length;
    this.view.description =
      count === 1 ? vscode.l10n.t('1 file') : vscode.l10n.t('{0} files', count);
    // Words in the message, where a branch keeps its case. VS Code capitalizes a
    // view's title, which turned `feature/compare` into `Feature/Compare`.
    const { left, right } = state.comparison;
    const other = right === 'worktree' ? vscode.l10n.t('current working tree') : right.name;
    this.view.message =
      count === 0
        ? vscode.l10n.t('No differences between {0} and {1}', left.name, other)
        : vscode.l10n.t('Changes between {0} and {1}', left.name, other);
  }

  /** A click on a file. VS Code only runs a row's command when it is the one row selected. */
  private async onRowClicked(node: TreeFileNode): Promise<void> {
    const at = Date.now();
    const into = goesIntoDiff(
      this.lastClick,
      node.path,
      at,
      vscode.workspace.getConfiguration('workbench.list').get('openMode') === 'doubleClick',
    );
    this.lastClick = { path: node.path, at };
    await this.open(node.path, new Set([node.path]), !into);
  }

  /** The row menu's Show Diff: the rows selected, a folder standing for its files. */
  private async showDiff(node: TreeNode | undefined, selected: readonly TreeNode[] | undefined): Promise<void> {
    const state = this.provider.state;
    if (!state) return;
    const rows = selected ?? (node ? [node] : (this.view?.selection ?? []));
    const chosen = new Set(rows.map((row) => row.path));
    const target = node?.kind === 'file' ? node.path : selectedFiles(state.nodes, chosen)[0];
    if (target !== undefined) await this.open(target, chosen, false);
  }

  private async open(target: string, selection: ReadonlySet<string>, preserveFocus: boolean): Promise<void> {
    const state = this.provider.state;
    if (!state) return;
    const walk = diffWalk(state.nodes, selection, target);
    this.walksWholeList = !walk.explicit;
    const index = walk.files.indexOf(target);
    await this.sessions()?.open(this.entriesOf(state, walk.files), index, { id: SEQUENCE_ID, preserveFocus });
  }

  private entriesOf(state: CompareState, paths: readonly string[]): DiffEntry[] {
    return paths.flatMap((p) => {
      const file = this.provider.file(p);
      return file ? [this.entryOf(state, file)] : [];
    });
  }

  private entryOf(state: CompareState, file: NameStatusEntry): DiffEntry {
    const { repo, comparison } = state;
    const sides = sidesOf(comparison, file);
    const request = this.request;
    const common = {
      // A file keeps its place when the list is read again and its sides have moved.
      key: `${repo.root}\n${file.path}`,
      original: makeRevUri(repo.root, sides.left.path, sides.left.ref),
      title: `${path.posix.basename(file.path)} (${pairTitle(comparison)})`,
      label: file.path,
      onShown: () => {
        this.follow(file.path);
      },
      onScreen: (showing: boolean) => {
        // Refresh reads the same comparison again; another one is another list.
        if (request !== this.request) return;
        const next = nextMark(this.provider.showing, file.path, showing, (a, b) => a === b);
        if (next !== 'unchanged') this.provider.setShowing(next.mark);
      },
    };
    if (sides.right !== 'worktree') {
      return {
        ...common,
        modified: makeRevUri(repo.root, sides.right.path, sides.right.ref),
        identical: hasIdenticalSides(file.status),
      };
    }
    const entry: DiffEntry = {
      ...common,
      modified: vscode.Uri.file(path.join(repo.root, file.path)),
      settle: () => settleWorktreeSide(entry, repo.root, file.path),
    };
    return entry;
  }

  /** The diff moved on: the list's selection goes with it, without showing a pane the user closed. */
  private follow(filePath: string): void {
    const view = this.view;
    const state = this.provider.state;
    const node = this.provider.fileNode(filePath);
    if (!view?.visible || !state || !node) return;
    const selection = new Set(view.selection.map((row) => row.path));
    if (selectionFollowing(state.nodes, selection, filePath) !== selection) {
      void view.reveal(node, { select: true, focus: false });
    }
  }

  private async openAll(): Promise<void> {
    const state = this.provider.state;
    if (!state || state.files.length === 0) return;
    const { repo, comparison } = state;
    const changes = allFiles(state.nodes).flatMap((p) => {
      const file = this.provider.file(p);
      if (!file) return [];
      const sides = sidesOf(comparison, file);
      const kind = statusKind(file.status);
      const fileUri = vscode.Uri.file(path.join(repo.root, file.path));
      const left = kind === 'added' ? undefined : makeRevUri(repo.root, sides.left.path, sides.left.ref);
      const right =
        kind === 'deleted'
          ? undefined
          : sides.right === 'worktree'
            ? fileUri
            : makeRevUri(repo.root, sides.right.path, sides.right.ref);
      return [[fileUri, left, right] as [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined]];
    });
    await vscode.commands.executeCommand('vscode.changes', pairTitle(comparison), changes);
  }

  private async close(): Promise<void> {
    this.generation++;
    this.request = undefined;
    this.walksWholeList = false;
    this.provider.setShowing(undefined);
    this.provider.setState(undefined);
    await vscode.commands.executeCommand('setContext', 'gittree.compare.active', false);
  }
}

function pairTitle(comparison: Comparison): string {
  const { left, right } = comparison;
  return vscode.l10n.t('{0} ⟷ {1}', left.name, right === 'worktree' ? vscode.l10n.t('Working Tree') : right.name);
}
