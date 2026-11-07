/**
 * Worktree management (P13-T6, gap analysis §3.10): list / add / remove / lock /
 * unlock / prune, plus the `gittree.worktrees` tree view and the New Worktree
 * dialog's host half.
 *
 * Before this, GitTree resolved worktree paths internally (`commondir`) but had
 * no management UI and no commands at all — which is also why the reference
 * branch submenu's `New Worktree from 'X'…` could not exist.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { chooseRepo, implicitRepo } from '../ui/chooseRepo';
import type { Core, RepoHandle } from '../core/core';
import { GitError } from '../core/git/errors';
import { parseWorktreeList, type WorktreeInfo } from '../core/git/parsers/worktreeList';
import { canonicalKey } from '../core/repoDiscovery';
import type { NewWorktreeDialogParamsDto, NewWorktreeDialogResultDto } from '../shared/protocol';
import { confirmModal } from '../ui/confirm';
import { openDialog } from '../ui/dialogHost';
import {
  buildWorktreeAddArgs,
  buildWorktreeListArgs,
  buildWorktreeLockArgs,
  buildWorktreePruneArgs,
  buildWorktreeRemoveArgs,
  buildWorktreeUnlockArgs,
  defaultWorktreePath,
  validateNewWorktree,
  type NewWorktreeOptions,
} from './worktreeArgs';
import { remoteNamesOf } from './newBranchArgs';

export interface WorktreeOutcome {
  ok: boolean;
  message: string;
  commands: string[][];
}

/**
 * `locked` and `prunable` only reached `worktree list --porcelain` in **git
 * 2.36**; on older builds the porcelain is silent about both, so the view would
 * never show a lock badge and prune's stale records would be invisible. Derive
 * them from git's own on-disk layout instead, which has been stable far longer:
 * a linked worktree's `.git` is a file pointing at its admin directory, and a
 * lock is a `locked` file there whose contents are the reason.
 *
 * Only ever *adds* information — a newer git that already reported the flags
 * keeps them, and the two agree.
 */
export function augmentFromDisk(info: WorktreeInfo): WorktreeInfo {
  if (info.isMain || info.bare) return info;
  const out = { ...info };
  if (!out.prunable && !fs.existsSync(out.path)) {
    out.prunable = true;
    out.prunableReason ??= 'the worktree directory is missing';
  }
  if (!out.locked) {
    const admin = adminDirOf(out.path);
    if (admin !== undefined) {
      const lockFile = path.join(admin, 'locked');
      if (fs.existsSync(lockFile)) {
        out.locked = true;
        try {
          const reason = fs.readFileSync(lockFile, 'utf8').trim();
          if (reason.length > 0) out.lockReason ??= reason;
        } catch {
          /* unreadable reason is not a reason to drop the lock flag */
        }
      }
    }
  }
  return out;
}

/** `<worktree>/.git` is a `gitdir: <admin dir>` pointer file for linked trees. */
function adminDirOf(worktreePath: string): string | undefined {
  try {
    const dotGit = path.join(worktreePath, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return undefined; // the main worktree
    const text = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/u.exec(text);
    const dir = match?.[1]?.trim();
    if (dir === undefined || dir.length === 0) return undefined;
    return path.isAbsolute(dir) ? dir : path.resolve(worktreePath, dir);
  } catch {
    return undefined;
  }
}

export class WorktreeService {
  constructor(
    private readonly core: Core,
    private readonly repo: RepoHandle,
  ) {}

  async list(): Promise<WorktreeInfo[]> {
    const res = await this.core.git.exec(this.repo.root, buildWorktreeListArgs(), {
      structured: true,
      noOptionalLocks: true,
    });
    return parseWorktreeList(res.stdout).map((info) => augmentFromDisk(info));
  }

  async add(options: NewWorktreeOptions): Promise<WorktreeOutcome> {
    const errors = validateNewWorktree(options);
    if (errors.length > 0) return { ok: false, message: errors.join(' '), commands: [] };
    const args = buildWorktreeAddArgs(options, remoteNamesOf(this.repo.model.snapshot.refs));
    return this.run(vscode.l10n.t('Add worktree'), [args], () =>
      vscode.l10n.t('Worktree created at {0}.', options.path.trim()),
    );
  }

  /**
   * Removal of a dirty worktree is git's refusal, not ours — the reason is
   * surfaced verbatim so "why did that not work" is answerable.
   */
  async remove(path: string, force = false): Promise<WorktreeOutcome> {
    const args = buildWorktreeRemoveArgs(path, force);
    return this.run(vscode.l10n.t('Remove worktree'), [args], () =>
      vscode.l10n.t('Worktree {0} removed.', path),
    );
  }

  async lock(path: string, reason: string): Promise<WorktreeOutcome> {
    return this.run(vscode.l10n.t('Lock worktree'), [buildWorktreeLockArgs(path, reason)], () =>
      vscode.l10n.t('Worktree {0} locked.', path),
    );
  }

  async unlock(path: string): Promise<WorktreeOutcome> {
    return this.run(vscode.l10n.t('Unlock worktree'), [buildWorktreeUnlockArgs(path)], () =>
      vscode.l10n.t('Worktree {0} unlocked.', path),
    );
  }

  async prune(): Promise<WorktreeOutcome> {
    return this.run(vscode.l10n.t('Prune worktrees'), [buildWorktreePruneArgs()], () =>
      vscode.l10n.t('Pruned stale worktree records.'),
    );
  }

  private async run(
    label: string,
    commands: string[][],
    success: () => string,
  ): Promise<WorktreeOutcome> {
    try {
      await this.repo.queue.enqueue({
        label,
        kind: 'mutate',
        run: async (git, token) => {
          for (const args of commands) await git.exec(this.repo.root, args, { token });
        },
      });
      await this.repo.refresher.refreshNow();
      return { ok: true, message: success(), commands };
    } catch (err) {
      const message =
        err instanceof GitError
          ? (err.stderr.split('\n').find((l) => l.trim().length > 0) ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, message, commands };
    }
  }
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

export interface WorktreeNode {
  readonly kind: 'worktree';
  readonly repo: RepoHandle;
  readonly info: WorktreeInfo;
}

export class WorktreesViewProvider implements vscode.TreeDataProvider<WorktreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly core: Core) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: WorktreeNode): vscode.TreeItem {
    const { info } = node;
    const label = info.bare
      ? vscode.l10n.t('(bare)')
      : (info.branch ?? vscode.l10n.t('detached at {0}', (info.head ?? '').slice(0, 7)));
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = info.path;
    item.resourceUri = vscode.Uri.file(info.path);
    item.iconPath = new vscode.ThemeIcon(
      info.isMain ? 'repo' : info.locked ? 'lock' : info.prunable ? 'warning' : 'git-branch',
    );
    const badges: string[] = [];
    if (info.isMain) badges.push(vscode.l10n.t('main'));
    if (info.locked) badges.push(info.lockReason ?? vscode.l10n.t('locked'));
    if (info.prunable) badges.push(info.prunableReason ?? vscode.l10n.t('prunable'));
    item.tooltip = [info.path, ...badges].join('\n');
    // Context values drive the row menu: the main worktree cannot be removed.
    item.contextValue = [
      'gittree.worktree',
      info.isMain ? 'main' : 'linked',
      info.locked ? 'locked' : 'unlocked',
      info.prunable ? 'prunable' : 'present',
    ].join('.');
    if (!info.bare) {
      item.command = {
        command: 'gittree.worktree.open',
        title: vscode.l10n.t('Open Worktree'),
        arguments: [node],
      };
    }
    return item;
  }

  async getChildren(node?: WorktreeNode): Promise<WorktreeNode[]> {
    if (node !== undefined) return [];
    const out: WorktreeNode[] = [];
    for (const repo of this.core.repos) {
      const list = await new WorktreeService(this.core, repo).list();
      for (const info of list) out.push({ kind: 'worktree', repo, info });
    }
    return out;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ---------------------------------------------------------------------------
// New Worktree dialog
// ---------------------------------------------------------------------------

export interface WorktreeDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
}

export function buildNewWorktreeParams(
  repo: RepoHandle,
  seedBranch?: string,
): NewWorktreeDialogParamsDto {
  const snap = repo.model.snapshot;
  const branch = seedBranch ?? snap.headRef ?? '';
  const branches = snap.refs
    .filter((r) => r.type === 'head')
    .map((r) => r.name)
    .sort((a, b) => a.localeCompare(b));
  // A seed that is not a local branch — `origin/topic` from the Tracked Branch
  // submenu or a remote row — is still a valid start point (`git worktree add`
  // DWIMs a remote ref into a new tracking branch), but it was missing from
  // the only list the dialog can show, so the seed silently became whichever
  // local branch sorted first.
  if (branch.length > 0 && !branches.includes(branch)) branches.unshift(branch);
  return {
    repoRoot: repo.root,
    repoLabel: repo.root.split(/[\\/]/u).pop() ?? repo.root,
    branches,
    remoteNames: remoteNamesOf(snap.refs),
    // Branches already checked out somewhere cannot be checked out again.
    seedBranch: branch,
    seedBranchIsHead: branch.length > 0 && branch === snap.headRef,
    defaultPath: defaultWorktreePath(repo.root, branch),
    showCommandLine: vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('dialogs.showCommandLine', true),
  };
}

export async function applyNewWorktreeResult(
  deps: WorktreeDialogDeps,
  repo: RepoHandle,
  result: NewWorktreeDialogResultDto,
): Promise<WorktreeOutcome> {
  const service = new WorktreeService(deps.core, repo);
  const outcome = await service.add(result.options);
  if (outcome.ok && result.openInNewWindow) {
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(result.options.path.trim()),
      { forceNewWindow: true },
    );
  }
  return outcome;
}

export async function showNewWorktreeDialog(
  deps: WorktreeDialogDeps,
  repo: RepoHandle,
  seedBranch?: string,
): Promise<WorktreeOutcome | undefined> {
  const params = buildNewWorktreeParams(repo, seedBranch);
  const result = await openDialog<NewWorktreeDialogParamsDto, NewWorktreeDialogResultDto>({
    app: 'dialogs',
    dialog: 'newWorktree',
    title: vscode.l10n.t('New Worktree — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const outcome = await applyNewWorktreeResult(deps, repo, result);
  if (outcome.ok) void vscode.window.showInformationMessage(outcome.message);
  else void vscode.window.showErrorMessage(outcome.message);
  return outcome;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface WorktreeRegistry {
  provider: WorktreesViewProvider;
  serviceFor: (repo: RepoHandle) => WorktreeService;
  buildNewWorktreeParams: typeof buildNewWorktreeParams;
  applyNewWorktreeResult: (
    repo: RepoHandle,
    result: NewWorktreeDialogResultDto,
  ) => Promise<WorktreeOutcome>;
}

export function registerWorktrees(
  context: vscode.ExtensionContext,
  core: Core,
  deps: WorktreeDialogDeps,
): WorktreeRegistry {
  const provider = new WorktreesViewProvider(core);
  const view = vscode.window.createTreeView('gittree.worktrees', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view, provider);

  const serviceFor = (repo: RepoHandle): WorktreeService => new WorktreeService(core, repo);
  const repoOf = (arg: unknown, repoRoot?: unknown): RepoHandle | undefined => {
    if (arg !== null && typeof arg === 'object' && 'repo' in arg) {
      return (arg as WorktreeNode).repo;
    }
    // `New Worktree from '<branch>'` sends a bare branch name, which says
    // nothing about which repository it belongs to. In a multi-root workspace
    // the old `repos[0]` fallback silently built the worktree from the first
    // repo's branch of the same name, so the caller now names its repo.
    if (typeof repoRoot === 'string') {
      const match = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(repoRoot));
      if (match) return match;
    }
    return implicitRepo(core);
  };
  /** As `repoOf`, asking when several repositories leave it open (POST-QA F6). */
  const chosenRepo = async (arg: unknown, repoRoot?: unknown): Promise<RepoHandle | undefined> =>
    repoOf(arg, repoRoot) ?? (await chooseRepo(core));
  const infoOf = (arg: unknown): WorktreeInfo | undefined =>
    arg !== null && typeof arg === 'object' && 'info' in arg
      ? (arg as WorktreeNode).info
      : undefined;

  const report = (outcome: WorktreeOutcome): void => {
    provider.refresh();
    if (outcome.ok) void vscode.window.showInformationMessage(outcome.message);
    else void vscode.window.showErrorMessage(outcome.message);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.worktree.add', async (arg?: unknown, repoRoot?: unknown) => {
      const repo = await chosenRepo(arg, repoRoot);
      if (!repo) return;
      const branch = typeof arg === 'string' ? arg : undefined;
      await showNewWorktreeDialog(deps, repo, branch);
      provider.refresh();
    }),
    vscode.commands.registerCommand('gittree.worktree.open', async (arg?: unknown) => {
      const info = infoOf(arg);
      if (!info) return;
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(info.path), {
        forceNewWindow: true,
      });
    }),
    vscode.commands.registerCommand('gittree.worktree.remove', async (arg?: unknown) => {
      const repo = repoOf(arg);
      const info = infoOf(arg);
      if (!repo || !info) return;
      if (info.isMain) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('The main worktree cannot be removed.'),
        );
        return;
      }
      const ok = await confirmModal(
        vscode.l10n.t('Remove the worktree at {0}?', info.path),
        vscode.l10n.t('Its directory is deleted. The branch itself is untouched.'),
        vscode.l10n.t('Remove'),
      );
      if (!ok) return;
      report(await serviceFor(repo).remove(info.path));
    }),
    vscode.commands.registerCommand('gittree.worktree.lock', async (arg?: unknown) => {
      const repo = repoOf(arg);
      const info = infoOf(arg);
      if (!repo || !info) return;
      const reason = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Reason for locking (optional)'),
        placeHolder: vscode.l10n.t('e.g. on a removable drive'),
      });
      if (reason === undefined) return;
      report(await serviceFor(repo).lock(info.path, reason));
    }),
    vscode.commands.registerCommand('gittree.worktree.unlock', async (arg?: unknown) => {
      const repo = repoOf(arg);
      const info = infoOf(arg);
      if (!repo || !info) return;
      report(await serviceFor(repo).unlock(info.path));
    }),
    vscode.commands.registerCommand('gittree.worktree.prune', async (arg?: unknown) => {
      const repo = await chosenRepo(arg);
      if (!repo) return;
      report(await serviceFor(repo).prune());
    }),
    vscode.commands.registerCommand('gittree.worktrees.refresh', () => provider.refresh()),
  );

  // Ref changes can create or retire a worktree's branch — keep the view honest.
  for (const repo of core.repos) {
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('refs')) provider.refresh();
      }),
    );
  }

  const registry: WorktreeRegistry = {
    provider,
    serviceFor,
    buildNewWorktreeParams,
    applyNewWorktreeResult: (repo, result) => applyNewWorktreeResult(deps, repo, result),
  };
  core.debugRegistry.set('worktrees', registry);
  return registry;
}
