/**
 * Commit tool window (P11-T2): the webview that replaces the SCM sidebar's
 * commit surface — file tree with folder rows and tri-state inclusion, the
 * message editor, amend, and the action buttons, all in one panel
 * (gap analysis S1, S11, S12, S13; layout in the analysis §2A).
 *
 * Why a webview at all: `TreeItemCheckboxState` has no partial state and a
 * TreeView cannot render folder rows for a flat changelist, so IntelliJ's
 * tick-what-you-commit model is unreachable natively. This reverses the master
 * §6 "webview commit dialog: rejected" decision; the escape hatch is
 * `gittree.commit.window: 'native'`, which restores the P3 surface intact.
 *
 * The host owns all state. The webview renders what it is given and posts
 * intents back; every handler is idempotent so a rehydrate can re-send.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { filesCount } from '../../ui/counts';
import type { Core, RepoHandle } from '../../core/core';
import { isUntracked, noConflictsLeft, shortCode, type StatusEntry } from '../../core/model/statusEntry';
import { canonicalKey } from '../../core/repoDiscovery';
import { repoLabels, sortRootsByLabel } from '../../core/util/repoLabels';
import { diffTitle, makeRevUri } from '../../core/vdocs/revContentProvider';
import { rootColorIndices } from '../../log/graphLayout/colors';
import { revealRow, setTreeFocus } from '../../scm/revealInOS';
import type { DiffEntry, DiffSessionRegistry } from '../../diff/diffSession';
import { nextMark } from '../../diff/onScreen';
import { settleWorktreeSide } from '../../diff/worktreeSide';
import {
  COMMIT_METHODS,
  CONFLICTS_GROUP_ID,
  type CommitChangeDto,
  type CommitDiffFileDto,
  type CommitDiffOnScreenDto,
  type CommitFileDiffDto,
  type CommitMessageFocusParamsDto,
  type CommitOpenDiffParamsDto,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitRunParamsDto,
  type CommitSetCheckedParamsDto,
  type CommitSetGroupByParamsDto,
  type CommitSetIncludedParamsDto,
  type CommitSetOptionParamsDto,
  type CommitStageParamsDto,
  type CommitStateDto,
  type CommitTreeFocusParamsDto,
  type StagingSide,
} from '../../shared/protocol';
import { statusColorOverrides } from '../../ui/statusColors';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../../ui/webviewHost';
import { ChangelistService, UNVERSIONED_ID } from '../changelists/changelistService';
import { hasCommittableChanges } from '../commitFlow';
import type { CommitService } from '../commitService';
import type { CommitMessageBox } from '../messageBox';
import { recentCommitMessages, type MessageHistory } from '../messageHistory';
import type { ParadigmManager } from '../paradigmManager';
import { stageFiles, unstageFiles } from '../staging/stageFiles';
import { setMessageFocus } from './commitKey';
import { failureText } from './failureText';
import { computeFileDiff, computeStagingDiff } from './fileDiff';
import { stagingGroups } from './stagingGroups';
import {
  readCommitGroupBy,
  readCommitGroupByDirectory,
  writeCommitGroupBy,
  writeCommitGroupByDirectory,
} from './groupBy';
import { signChanges, type InclusionModel } from './inclusion';
import { localDiffSides } from './localDiffSides';
import { applyOption, readOptions, type CommitOptionsStore } from './options';
import { repoHeadOf } from './repoHead';
import type { ShelfBridge } from './shelfBridge';
import type { StashBridge } from './stashBridge';
import type {
  CommitShelfActionParamsDto,
  CommitStashActionParamsDto,
} from '../../shared/protocol';

export interface CommitWindowDeps {
  context: vscode.ExtensionContext;
  core: Core;
  changelistsFor(repo: RepoHandle): ChangelistService;
  commitService: CommitService;
  history: MessageHistory;
  paradigm: ParadigmManager;
  /** P11-T3 — per-change inclusion, shared with the commit flow. */
  inclusion: InclusionModel;
  /** P11-T5 — author/sign-off/checks state behind the gear popup. */
  options: CommitOptionsStore;
  /** Runs the shared P3 commit flow — the webview never commits by itself. */
  runCommit(repo: RepoHandle, options: { andPush?: boolean }): Promise<boolean>;
}

const MESSAGE_KEY_PREFIX = 'gittree.commit.message.';

/** The one walk over this window's list: opening another replaces it. */
const DIFF_SEQUENCE_ID = 'commit-window';

function classify(entry: StatusEntry | undefined): CommitChangeDto['kind'] {
  if (!entry) return 'modified';
  if (entry.kind === 'unmerged') return 'conflicted';
  if (isUntracked(entry)) return 'untracked';
  const code = entry.x !== '.' ? entry.x : entry.y;
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

export class CommitWindowViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'gittree.commit';

  private view: vscode.WebviewView | undefined;
  private rpc: WebviewRpcHost | undefined;
  private busy = 0;
  private lastError: string | undefined;
  private shelfBridge: ShelfBridge | undefined;
  /** POST-P14l: the Stash tab data source, attached by the same layer. */
  private stashBridge: StashBridge | undefined;
  private readonly subs: vscode.Disposable[] = [];
  /** The file a diff opened from this list is showing, which the tree marks. */
  private diffOnScreen: CommitDiffFileDto | undefined;
  /** Test observability, mirroring the RebaseViewController convention. */
  readonly debugTrail: string[] = [];

  constructor(private readonly deps: CommitWindowDeps) {
    const { core } = deps;
    const watch = (repo: RepoHandle): void => {
      repo.disposables.add(deps.changelistsFor(repo).onDidChange(() => this.push()));
      repo.disposables.add(repo.model.onDidChange(() => this.push()));
    };
    for (const repo of core.repos) watch(repo);
    this.subs.push(
      core.onDidAddRepo((repo) => {
        watch(repo);
        this.push();
      }),
      core.onDidRemoveRepo(() => this.push()),
      deps.paradigm.onDidChange(() => this.push()),
      deps.commitService.onDidCommit(() => this.push()),
      // P11-T8: a changed color override must repaint without a reload; so must
      // the palette the repositories' colours come from, and the grouping,
      // which the palette commands and the settings file change too.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('gittree.colors') ||
          e.affectsConfiguration('gittree.log.graphPalette') ||
          e.affectsConfiguration('gittree.log.dateFormat') ||
          e.affectsConfiguration('gittree.commit.groupBy') ||
          e.affectsConfiguration('gittree.commit.groupByDirectory')
        ) {
          this.push();
        }
      }),
    );
  }

  // ---- message storage ------------------------------------------------------

  private messageKey(repo: RepoHandle): string {
    return `${MESSAGE_KEY_PREFIX}${canonicalKey(repo.root)}`;
  }

  getMessage(repo: RepoHandle): string {
    return this.deps.context.workspaceState.get<string>(this.messageKey(repo)) ?? '';
  }

  private setMessage(repo: RepoHandle, value: string, echo: boolean): void {
    void this.deps.context.workspaceState.update(this.messageKey(repo), value);
    if (echo) {
      // Programmatic writes travel on their own event, not on a state push —
      // the editor ignores `CommitStateDto.message` after init because a push
      // can be built from a snapshot older than the user's latest keystrokes
      // (the webview persists on a 250 ms debounce). See COMMIT_METHODS.evtMessage.
      this.rpc?.notify(COMMIT_METHODS.evtMessage, { repoRoot: repo.root, message: value });
      this.push();
    }
  }

  /**
   * The message box `commitFlow` and `messageHistory` read through when the
   * commit window owns the message. Programmatic writes (history pick, amend
   * prefill, post-commit clear) echo back to the webview.
   */
  messageBoxFor(repo: RepoHandle): CommitMessageBox {
    const read = (): string => this.getMessage(repo);
    const write = (next: string): void => this.setMessage(repo, next, true);
    return {
      get value(): string {
        return read();
      },
      set value(next: string) {
        write(next);
      },
    };
  }

  // ---- state ----------------------------------------------------------------

  private activeRepo(): RepoHandle | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && this.deps.core.repoForUri(uri)) ?? this.deps.core.repos[0];
  }

  private groupsFor(repo: RepoHandle): CommitGroupDto[] {
    // POST-QA F5: with staging, IntelliJ's staging-area nodes, not changelists.
    if (this.deps.paradigm.paradigm === 'staging') {
      return stagingGroups(repo.model.snapshot.statusEntries, {
        conflicts: vscode.l10n.t('Merge Conflicts'),
        staged: vscode.l10n.t('Staged'),
        unstaged: vscode.l10n.t('Unstaged'),
        unversioned: vscode.l10n.t('Unversioned Files'),
      });
    }
    const service = this.deps.changelistsFor(repo);
    // Per-change selections are keyed by canonical root, and only a handful of
    // files ever have one — a lookup table beats a diff per row.
    const selections = new Map(this.deps.inclusion.entries(canonicalKey(repo.root)));
    const change = (relPath: string, checked: boolean): CommitChangeDto => {
      const entry = service.statusEntry(relPath);
      const selection = selections.get(relPath);
      return {
        path: relPath.replace(/\\/g, '/'),
        code: entry ? shortCode(entry) : 'M.',
        kind: classify(entry),
        checked,
        ...(entry?.origPath !== undefined ? { origPath: entry.origPath } : {}),
        ...(selection !== undefined
          ? { partial: { total: selection.total, included: selection.included.length } }
          : {}),
      };
    };

    const groups: CommitGroupDto[] = service.getLists().map((list) => {
      const checked = new Set(list.checked);
      return {
        id: list.id,
        name: list.name,
        ...(list.comment !== undefined ? { comment: list.comment } : {}),
        isActive: list.isActive,
        isDefault: list.isDefault,
        checkable: true,
        changes: list.files.map((f) => change(f, checked.has(f))),
      };
    });

    // POST-QA: IntelliJ's Merge Conflicts node, first, with changelists too —
    // the lists hold no unmerged file, so a conflict was nowhere in the
    // window, though a commit is refused while one is left.
    const conflicted = repo.model.snapshot.statusEntries.filter((e) => e.kind === 'unmerged');
    if (conflicted.length > 0) {
      groups.unshift({
        id: CONFLICTS_GROUP_ID,
        name: vscode.l10n.t('Merge Conflicts'),
        isActive: false,
        isDefault: false,
        checkable: false,
        changes: conflicted.map((e) => ({
          path: e.path.replace(/\\/g, '/'),
          code: shortCode(e),
          kind: 'conflicted',
          checked: false,
        })),
      });
    }

    const unversioned = service.unversioned();
    if (unversioned.length > 0) {
      // P11-T3: untracked files are tickable. They start unticked, as in
      // IntelliJ — a new file joins a commit only when you say so.
      const ticked = new Set(service.unversionedCheckedPaths());
      groups.push({
        id: UNVERSIONED_ID,
        name: vscode.l10n.t('Unversioned Files'),
        isActive: false,
        isDefault: false,
        checkable: true,
        changes: unversioned.map((f) => change(f, ticked.has(f))),
      });
    }
    return groups;
  }

  buildState(): CommitStateDto {
    // Every snapshot starts from a pruned model, so no badge can outlive the
    // file it describes — the state push is the only place that needs to know.
    this.pruneInclusion();
    // Each repository named, ordered and coloured as the Repositories panel and
    // the log's Roots show it, so its rows here are the same repository at a glance.
    const byRoot = new Map(this.deps.core.repos.map((repo) => [repo.root, repo]));
    const roots = sortRootsByLabel([...byRoot.keys()]);
    const labels = repoLabels(roots);
    const colors = rootColorIndices(roots);
    const handles = roots.flatMap((root) => {
      const repo = byRoot.get(root);
      return repo !== undefined ? [repo] : [];
    });
    const repos: CommitRepoDto[] = handles.map((repo) => {
      const head = repoHeadOf(repo.model.snapshot);
      return {
        root: repo.root,
        label: labels.get(repo.root) ?? path.basename(repo.root),
        colorIdx: colors.get(repo.root) ?? 0,
        ...(head !== undefined ? { head } : {}),
        groups: this.groupsFor(repo),
      };
    });
    const active = this.activeRepo();
    // The tree renders every repository's groups, so the `N of M` counter has
    // to describe everything on screen — not just the repo the message box
    // happens to target.
    const changes = repos.flatMap((r) => r.groups.flatMap((g) => g.changes));
    // Asked through the commit path's own predicate rather than recomputed
    // from `changes`, so the button cannot promise a repo the flow skips. Named
    // as the tree's rows name them.
    const targets = handles
      .filter((repo) => hasCommittableChanges(this.deps, repo))
      .map((repo) => labels.get(repo.root) ?? path.basename(repo.root));
    return {
      repos,
      targets,
      ...(active !== undefined ? { activeRepo: active.root } : {}),
      message: active ? this.getMessage(active) : '',
      amend: active ? this.deps.commitService.isAmend(active) : false,
      signing: false,
      busy: this.busy > 0,
      // Files, not rows: with staging a file staged in part is two rows.
      modifiedCount: new Set(repos.flatMap((r) => r.groups.flatMap((g) => g.changes.map((c) => `${r.root}\n${c.path}`)))).size,
      checkedCount: changes.filter((c) => c.checked).length,
      paradigm: this.deps.paradigm.paradigm,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      colors: statusColorOverrides(),
      palette:
        vscode.workspace.getConfiguration('gittree.log').get<string>('graphPalette') === 'colorBlind'
          ? 'colorBlind'
          : 'default',
      groupBy: readCommitGroupBy(),
      groupByDirectory: readCommitGroupByDirectory(),
      dateFormat:
        vscode.workspace.getConfiguration('gittree.log').get<string>('dateFormat') === 'locale'
          ? 'locale'
          : 'YYYY/MM/DD HH:mm',
      ...(this.diffOnScreen !== undefined ? { diffOnScreen: this.diffOnScreen } : {}),
    };
  }

  /**
   * One file's diff for the preview pane, with the live inclusion set. A
   * selection whose change list has been renumbered is dropped here rather than
   * carried to commit time, so the pane never shows ticks that would not be
   * honoured.
   */
  private async fileDiff(repo: RepoHandle, relPath: string, side?: StagingSide): Promise<CommitFileDiffDto> {
    if (this.deps.paradigm.paradigm === 'staging' && side !== undefined) {
      // POST-QA F5: the row's half, read-only — nothing is ticked with staging.
      const entry = repo.model.snapshot.statusEntries.find((e) => e.path === relPath.replace(/\\/g, '/'));
      const diff = await computeStagingDiff(repo, relPath, side, entry?.origPath);
      return {
        repoRoot: repo.root,
        path: relPath,
        originalText: diff.originalText,
        modifiedText: diff.modifiedText,
        changes: diff.changes,
        included: null,
        checked: side === 'staged',
        wholeFileOnly: diff.wholeFileOnly,
        signature: signChanges(diff.changes),
      };
    }
    const key = canonicalKey(repo.root);
    const diff = await computeFileDiff(repo, relPath);
    const signature = signChanges(diff.changes);
    const selection = this.deps.inclusion.get(key, relPath);
    const stale = selection !== undefined && selection.signature !== signature;
    if (stale) {
      this.deps.inclusion.clear(key, relPath);
      this.push(); // the row's `M of N changes` badge just became wrong
    }
    return {
      repoRoot: repo.root,
      path: relPath,
      originalText: diff.originalText,
      modifiedText: diff.modifiedText,
      changes: diff.changes,
      included: selection === undefined || stale ? null : [...selection.included],
      checked: this.deps.changelistsFor(repo).isChecked(relPath),
      wholeFileOnly: diff.wholeFileOnly,
      signature,
    };
  }

  /**
   * Selections only mean something while their file is still pending. Pruning
   * on every status tick keeps a committed or reverted file from carrying a
   * ghost selection into its next appearance.
   */
  private pruneInclusion(): void {
    for (const repo of this.deps.core.repos) {
      const key = canonicalKey(repo.root);
      if (this.deps.inclusion.count(key) === 0) continue; // the usual case, for free
      const service = this.deps.changelistsFor(repo);
      const live = [...service.getLists().flatMap((l) => l.files), ...service.unversioned()];
      this.deps.inclusion.prune(key, live);
    }
  }

  /**
   * POST-QA F5: Stage or Unstage whole files from the staging-mode tree. A
   * staged rename is one row: unstaging it takes its old path back too.
   */
  async stagePaths(repo: RepoHandle, paths: readonly string[], how: 'stage' | 'unstage'): Promise<void> {
    const entries = repo.model.snapshot.statusEntries;
    const all = new Set(paths);
    if (how === 'unstage') {
      for (const p of paths) {
        const e = entries.find((x) => x.path === p);
        if (e?.origPath !== undefined && e.x === 'R') all.add(e.origPath);
      }
    }
    await this.guard(how, () =>
      repo.queue.enqueue({
        label:
          how === 'stage'
            ? vscode.l10n.t('Stage {0}', filesCount(paths.length))
            : vscode.l10n.t('Unstage {0}', filesCount(paths.length)),
        kind: 'mutate',
        bypassHold: noConflictsLeft(entries),
        run: (git, token) =>
          how === 'stage' ? stageFiles(git, repo.root, [...all], token) : unstageFiles(git, repo.root, [...all], token),
      }),
    );
  }

  // ---- diffs (POST-P14au) ----------------------------------------------------

  /** A row's diff, walkable through `files`, the way the tree shows them. */
  async openDiff(params: CommitOpenDiffParamsDto): Promise<void> {
    // A conflicted file opens where it is resolved, as IntelliJ's Merge
    // Conflicts node does, not as a diff of its conflict markers (POST-QA).
    if (await this.openMerge(params)) return;
    const entries = this.diffEntries(params.files);
    const wanted = this.diffEntries([params])[0];
    if (!wanted) return;
    const index = Math.max(
      0,
      entries.findIndex((e) => e.key === wanted.key),
    );
    await this.diffSessions()?.open(entries.length > 0 ? entries : [wanted], index, {
      id: DIFF_SEQUENCE_ID,
    });
  }

  /** The merge editor for a file still unmerged, when its conflict session has it. */
  private async openMerge(file: CommitDiffFileDto): Promise<boolean> {
    const repo = this.repoFor(file.repoRoot);
    if (!repo) return false;
    const unmerged = repo.model.snapshot.statusEntries.some(
      (e) => e.kind === 'unmerged' && e.path.replace(/\\/g, '/') === file.path,
    );
    if (!unmerged) return false;
    const p6 = this.deps.core.debugRegistry.get('phase06') as
      | { getSession?: (root: string) => { files(): { path: string; kind: string }[] } | undefined }
      | undefined;
    const session = p6?.getSession?.(repo.root);
    const node = session?.files().find((f) => f.path.replace(/\\/g, '/') === file.path);
    if (session === undefined || node === undefined) return false;
    await vscode.commands.executeCommand('gittree.merge.open', { session, path: node.path, kind: node.kind });
    return true;
  }

  /** The list changed under a walk over all of it. */
  followDiffList(files: readonly CommitDiffFileDto[]): void {
    this.diffSessions()?.update(DIFF_SEQUENCE_ID, this.diffEntries(files));
  }

  /** `Open Changes` from a row's menu: only the webview knows the order and the selection. */
  openDiffAt(file: CommitDiffFileDto): void {
    this.rpc?.notify(COMMIT_METHODS.evtOpenDiff, file);
  }

  /**
   * POST-P14bq: the reveal shortcut, pressed in this window. Only the webview
   * knows which row the keyboard is on; it answers with `reveal`.
   */
  revealKeyboardRow(): void {
    this.rpc?.notify(COMMIT_METHODS.evtRevealRow, {});
  }

  /**
   * POST-P14bs: the commit key, pressed in the message box. The window commits
   * as its Commit button does, with the message as typed this instant; the
   * host's copy may still be inside the box's persist debounce (`commitKey.ts`).
   */
  commitFromMessageBox(): void {
    // Bounded — this is test observability, not a log.
    if (this.debugTrail.length > 50) this.debugTrail.shift();
    this.debugTrail.push('commit key → webview');
    this.rpc?.notify(COMMIT_METHODS.evtCommitKey, {});
  }

  private diffSessions(): DiffSessionRegistry | undefined {
    return (this.deps.core.debugRegistry.get('phase14') as { sessions: DiffSessionRegistry } | undefined)?.sessions;
  }

  private diffEntries(files: readonly CommitDiffFileDto[]): DiffEntry[] {
    const multiRepo = this.deps.core.repos.length > 1;
    const out: DiffEntry[] = [];
    for (const file of files) {
      const repo = this.repoFor(file.repoRoot);
      if (repo) out.push(this.diffEntry(repo, file.path, multiRepo, file.side));
    }
    return out;
  }

  private diffEntry(repo: RepoHandle, relPath: string, multiRepo: boolean, side?: StagingSide): DiffEntry {
    const sides = localDiffSides(
      relPath,
      this.deps.changelistsFor(repo).statusEntry(relPath),
      this.deps.paradigm.paradigm,
      side,
    );
    const worktree = vscode.Uri.file(path.join(repo.root, relPath));
    // With staging one file can be two stops of a walk, its staged and its
    // unstaged half: the side keeps them apart (POST-QA F5).
    const file: CommitDiffFileDto = { repoRoot: repo.root, path: relPath, ...(side !== undefined ? { side } : {}) };
    const entry: DiffEntry = {
      key: `${repo.root}\n${relPath}${side !== undefined ? `\n${side}` : ''}`,
      original: makeRevUri(repo.root, sides.left.relPath, sides.left.ref),
      modified: sides.right === 'worktree' ? worktree : makeRevUri(repo.root, relPath, ':0'),
      title: diffTitle(relPath, sides.titleKind),
      label: multiRepo ? `${path.basename(repo.root)}/${relPath}` : relPath,
      onShown: () => {
        this.rpc?.notify(COMMIT_METHODS.evtDiffFile, file);
      },
      onScreen: (showing) => this.markDiffOnScreen(file, showing),
      ...(sides.right === 'worktree' ? { settle: () => settleWorktreeSide(entry, repo.root, relPath) } : {}),
    };
    return entry;
  }

  /** A diff opened from this list came on screen or left it: the tree marks the file it shows. */
  private markDiffOnScreen(file: CommitDiffFileDto, showing: boolean): void {
    const next = nextMark(
      this.diffOnScreen,
      file,
      showing,
      (a, b) => a.repoRoot === b.repoRoot && a.path === b.path,
    );
    if (next === 'unchanged') return;
    this.diffOnScreen = next.mark;
    const dto: CommitDiffOnScreenDto = next.mark !== undefined ? { file: next.mark } : {};
    this.rpc?.notify(COMMIT_METHODS.evtDiffOnScreen, dto);
  }

  /** Test seam: the file the tree marks as on screen. */
  get diffOnScreenFile(): CommitDiffFileDto | undefined {
    return this.diffOnScreen;
  }

  /** True once the view has been made visible and the webview exists. */
  get isResolved(): boolean {
    return this.view !== undefined;
  }

  /** Test seam: whether the host answers this webview→host method as a request. */
  hasHandler(method: string): boolean {
    return this.rpc?.hasHandler(method) ?? false;
  }

  /**
   * P11-T6: the Shelf tab's data source, attached by the phase-07 register
   * layer once the stores exist (phase 03 builds this view first). Handlers
   * are registered unconditionally and answer empty until this lands.
   */
  attachShelf(bridge: ShelfBridge): void {
    this.shelfBridge = bridge;
    this.subs.push(bridge.onDidChange(() => this.pushShelf()));
    this.pushShelf();
  }

  /** POST-P14l: same contract as `attachShelf`, for the `Stash` tab. */
  attachStash(bridge: StashBridge): void {
    this.stashBridge = bridge;
    this.subs.push(bridge.onDidChange(() => this.pushStash()));
    this.pushStash();
  }

  /** P14-T4 test seam: what the view badge currently shows. */
  get badgeValue(): number | undefined {
    return this.view?.badge?.value;
  }

  private pushShelf(): void {
    if (!this.view || !this.shelfBridge) return;
    this.rpc?.notify(COMMIT_METHODS.evtShelf, this.shelfBridge.buildState());
  }

  private pushStash(): void {
    if (!this.view || !this.stashBridge) return;
    this.rpc?.notify(COMMIT_METHODS.evtStash, this.stashBridge.buildState());
  }

  push(): void {
    if (!this.view) return;
    const state = this.buildState();
    // P14-T4: the pending-change count used to be `SourceControl.count`. With
    // no SourceControl left, the view carries its own badge.
    this.view.badge =
      state.modifiedCount > 0
        ? {
            value: state.modifiedCount,
            tooltip:
              state.modifiedCount === 1
                ? vscode.l10n.t('1 pending change')
                : vscode.l10n.t('{0} pending changes', state.modifiedCount),
          }
        : undefined;
    this.rpc?.notify(COMMIT_METHODS.evtState, state);
    // Bounded — this is test observability, not a log.
    if (this.debugTrail.length > 50) this.debugTrail.shift();
    this.debugTrail.push(`push ${state.repos.length} repo(s), ${state.checkedCount} checked`);
  }

  private repoFor(root: string): RepoHandle | undefined {
    return this.deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
  }

  /**
   * Runs a mutation with the busy flag raised and errors surfaced in-panel.
   *
   * Re-entry is refused, not queued. Intents arrive as RPC *requests*, and
   * `RpcClient` re-posts in-flight requests after a rehydrate — so hiding and
   * re-showing the view mid-commit would otherwise start a second one.
   */
  /**
   * Runs one mutation at a time. A failure stays on screen as the window's
   * banner, in full (`failureText`), naming the repository it happened in when
   * the workspace has several.
   */
  private async guard(label: string, run: () => Promise<void>, repo?: RepoHandle): Promise<void> {
    if (this.busy > 0) {
      this.debugTrail.push(`${label} refused: a mutation is already running`);
      return;
    }
    this.busy++;
    this.lastError = undefined;
    this.push();
    try {
      await run();
    } catch (err) {
      const several = this.deps.core.repos.length > 1;
      this.lastError = failureText(err, several && repo !== undefined ? path.basename(repo.root) : undefined);
      this.debugTrail.push(`${label} failed: ${this.lastError}`);
    } finally {
      this.busy--;
      this.push();
    }
  }

  // ---- view -----------------------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.deps.context.extensionUri),
    };
    view.webview.html = buildWebviewHtml({
      app: 'commit',
      webview: view.webview,
      extensionUri: this.deps.context.extensionUri,
      title: vscode.l10n.t('Commit'),
    });

    const rpc = new WebviewRpcHost(view.webview, (l) =>
      this.deps.core.output.appendLine(`[commit-window] ${l}`),
    );
    this.rpc = rpc;
    this.wire(rpc);

    view.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.view = undefined;
      setTreeFocus(false);
      setMessageFocus(false);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        rpc.rehydrate();
        this.push();
        this.pushShelf();
      } else {
        // A hidden tree or box has no keyboard, whatever its last word was:
        // the reveal and commit keys must not keep VS Code's own from the next
        // view, Ctrl+Enter in an editor least of all.
        setTreeFocus(false);
        setMessageFocus(false);
      }
    });
  }

  private wire(rpc: WebviewRpcHost): void {
    rpc.on(COMMIT_METHODS.init, () => this.buildState());
    rpc.on(COMMIT_METHODS.refresh, async () => {
      await vscode.commands.executeCommand('gittree.refresh');
      this.push();
    });

    rpc.on(COMMIT_METHODS.setChecked, (raw) => {
      const p = raw as CommitSetCheckedParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      this.deps.changelistsFor(repo).setChecked(p.paths, p.checked);
      if (!p.checked) {
        // Unticking a file discards its per-change selection, so ticking it
        // again means the whole file — never a set the user forgot they made.
        const key = canonicalKey(repo.root);
        for (const relPath of p.paths) this.deps.inclusion.clear(key, relPath);
      }
      this.push();
    });

    rpc.on(COMMIT_METHODS.fileDiff, async (raw) => {
      const p = raw as { repoRoot: string; path: string; side?: StagingSide };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return undefined;
      return this.fileDiff(repo, p.path, p.side);
    });

    // The banner's Show Output: the full command and stderr behind a failure.
    rpc.on(COMMIT_METHODS.showOutput, () => {
      this.deps.core.output.show(true);
    });
    // The banner's ✕: the failure was read.
    rpc.on(COMMIT_METHODS.dismissError, () => {
      this.lastError = undefined;
      this.push();
    });

    rpc.on(COMMIT_METHODS.stage, async (raw) => {
      const p = raw as CommitStageParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (repo && p.paths.length > 0) await this.stagePaths(repo, p.paths, 'stage');
    });
    rpc.on(COMMIT_METHODS.unstage, async (raw) => {
      const p = raw as CommitStageParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (repo && p.paths.length > 0) await this.stagePaths(repo, p.paths, 'unstage');
    });
    // The Merge Conflicts row's Resolve: IntelliJ's link on that node.
    rpc.on(COMMIT_METHODS.resolveConflicts, async (raw) => {
      const p = (raw ?? {}) as { repoRoot?: string };
      await vscode.commands.executeCommand('gittree.conflicts.resolve', p.repoRoot);
    });
    // POST-P14bq: the keyboard's row, in the file manager (`revealKeyboardRow`).
    rpc.on(COMMIT_METHODS.reveal, async (raw) => {
      await revealRow(this.deps.core, [raw]);
    });
    // POST-P14bq: the reveal key's `when`, from the only side that knows.
    rpc.on(COMMIT_METHODS.treeFocus, (raw) => {
      setTreeFocus((raw as Partial<CommitTreeFocusParamsDto> | undefined)?.focused === true);
    });
    // POST-P14bs: the commit key's `when`, likewise (`commitFromMessageBox`).
    rpc.on(COMMIT_METHODS.messageFocus, (raw) => {
      setMessageFocus((raw as Partial<CommitMessageFocusParamsDto> | undefined)?.focused === true);
    });

    rpc.on(COMMIT_METHODS.setIncluded, async (raw) => {
      const p = raw as CommitSetIncludedParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      const key = canonicalKey(repo.root);
      const diff = await computeFileDiff(repo, p.path);
      // A status refresh may have landed between the render and the click.
      // Applying indices to a renumbered change list is the one failure this
      // whole model exists to prevent, so drop the toggle and re-push instead.
      if (diff.wholeFileOnly || signChanges(diff.changes) !== p.signature) {
        this.push();
        return;
      }
      if (p.included.length === 0) {
        // Excluding the last change means the file is out of the commit; two
        // ways to say "nothing from this file" would be one way too many.
        this.deps.inclusion.clear(key, p.path);
        this.deps.changelistsFor(repo).setChecked([p.path], false);
      } else {
        this.deps.inclusion.set(key, p.path, diff.changes, p.included);
        this.deps.changelistsFor(repo).setChecked([p.path], true);
      }
      this.push();
    });

    rpc.on(COMMIT_METHODS.setMessage, (raw) => {
      const p = raw as { repoRoot: string; message: string };
      const repo = this.repoFor(p.repoRoot);
      // No echo: the webview already holds this text, and pushing it back
      // while the user types would fight the editor's own undo stack.
      if (repo) this.setMessage(repo, p.message, false);
    });

    rpc.on(COMMIT_METHODS.commit, async (raw) => {
      const p = raw as CommitRunParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      await this.guard(
        'commit',
        async () => {
          await this.deps.runCommit(repo, { andPush: p.andPush });
        },
        repo,
      );
    });

    rpc.on(COMMIT_METHODS.toggleAmend, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      const result = await this.deps.commitService.toggleAmend(repo);
      if (
        result.amend &&
        result.previousMessage !== undefined &&
        this.getMessage(repo).trim().length === 0
      ) {
        // echo=true: the prefill must reach the editor as a programmatic write
        // (setRangeText → lands on the undo stack) — a state push would not.
        this.setMessage(repo, result.previousMessage, true);
      }
      this.push();
    });

    rpc.on(COMMIT_METHODS.openDiff, (raw) => this.openDiff(raw as CommitOpenDiffParamsDto));
    rpc.on(COMMIT_METHODS.diffChain, (raw) => {
      this.followDiffList((raw as { files: CommitDiffFileDto[] }).files);
    });

    rpc.on(COMMIT_METHODS.rollback, async (raw) => {
      const p = raw as { repoRoot: string; paths: string[] };
      const repo = this.repoFor(p.repoRoot);
      if (!repo || p.paths.length === 0) return;
      await this.guard('rollback', async () => {
        for (const rel of p.paths) {
          await vscode.commands.executeCommand(
            'gittree.rollbackFile',
            vscode.Uri.file(path.join(repo.root, rel)),
          );
        }
      });
    });

    rpc.on(COMMIT_METHODS.shelve, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      // P11-T7: opens the Shelve Changes dialog. (Until T7 this executed
      // 'gittree.shelve' — a command id that has never existed, so the
      // toolbar button errored since T2. The dialog is also the fix.)
      await this.guard('shelve', async () => {
        await vscode.commands.executeCommand('gittree.shelve.dialog', repo.root);
      });
    });

    // P11-T4: the clock and Amend ▾ dropdowns render inside the webview; the
    // host only serves their data. The native QuickPick stays reachable via
    // the `gittree.commit.showMessageHistory` command in both modes.
    rpc.on(COMMIT_METHODS.messageHistory, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return { entries: [] };
      return { entries: await this.deps.history.entries(repo) };
    });

    rpc.on(COMMIT_METHODS.recentCommits, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return { commits: [] };
      return { commits: await recentCommitMessages(repo, 20) };
    });

    // P11-T5: the gear popup renders inside the webview; the host serves and
    // applies its state. The `gittree.commit.configureChecks` QuickPick stays
    // registered for native mode and the palette.
    rpc.on(COMMIT_METHODS.options, async (raw) => {
      const p = raw as { repoRoot: string };
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return undefined;
      return readOptions(this.deps.options, repo);
    });

    rpc.on(COMMIT_METHODS.setOption, async (raw) => {
      const p = raw as CommitSetOptionParamsDto;
      const repo = this.repoFor(p.repoRoot);
      if (!repo) return;
      // Throws on an invalid author; the RPC error reaches the popup inline.
      await applyOption(this.deps.options, repo, p.option);
      this.push();
    });

    // P11-T6: the Shelf tab. Empty until phase 07 attaches the bridge.
    rpc.on(COMMIT_METHODS.shelfState, () =>
      this.shelfBridge?.buildState() ?? { repos: [], showUnshelved: false },
    );

    rpc.on(COMMIT_METHODS.stashState, () =>
      this.stashBridge?.buildState() ?? { repos: [], combined: false },
    );
    rpc.on(COMMIT_METHODS.stashFiles, async (raw) => {
      const { repoRoot, sha } = raw as { repoRoot?: string; sha?: string };
      if (!this.stashBridge || repoRoot === undefined || sha === undefined) return { files: [] };
      return { files: await this.stashBridge.filesFor(repoRoot, sha) };
    });
    rpc.on(COMMIT_METHODS.stashAction, async (raw) => {
      if (!this.stashBridge) return { ok: false };
      await this.stashBridge.dispatch(raw as CommitStashActionParamsDto);
      return { ok: true };
    });
    rpc.on(COMMIT_METHODS.shelfAction, async (raw) => {
      if (!this.shelfBridge) return;
      await this.shelfBridge.dispatch(raw as CommitShelfActionParamsDto);
    });

    // View Options › Group By. The settings are the one place the choice lives:
    // the push it causes reaches every view of this window, and a reload.
    rpc.on(COMMIT_METHODS.setGroupBy, async (raw) => {
      const params = (raw ?? {}) as Partial<CommitSetGroupByParamsDto>;
      const value = params.groupBy;
      const grouping = value === 'none' || value === 'changelist' || value === 'repository' ? value : undefined;
      // POST-P14cb: Group By › Directory, the folder rows.
      const directory = typeof params.directory === 'boolean' ? params.directory : undefined;
      if (grouping === undefined && directory === undefined) return;
      if (grouping !== undefined) await writeCommitGroupBy(grouping);
      if (directory !== undefined) await writeCommitGroupByDirectory(directory);
      this.push();
    });
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this.rpc?.dispose();
  }
}
