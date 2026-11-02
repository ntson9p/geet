/**
 * Host ⇄ webview RPC protocol (master §8). Single source of truth compiled
 * into both the extension host and every webview bundle. No `any` (lint-
 * enforced). Every request must be idempotent or guarded — webviews reload
 * and re-send pending requests on rehydrate.
 */

// The P13 dialogs' option shapes live with their argv builders (which are
// vscode-free and unit-tested); importing the types here keeps one definition
// instead of a hand-mirrored copy that can drift from what actually runs.
import type { CherryPickOptions } from '../scm/dialogs/cherryPickArgs';
import type { CloneOptions } from '../scm/dialogs/cloneArgs';
import type { MergeOptions } from '../scm/dialogs/mergeArgs';
import type { RebaseOptions } from '../scm/dialogs/rebaseArgs';
import type { ResetMode } from '../scm/dialogs/resetArgs';
import type { RollbackKind } from '../scm/dialogs/rollbackPlan';
import type { StashPushArgsOptions } from '../scm/dialogs/stashArgs';
import type { NewWorktreeOptions } from '../branches/worktreeArgs';

export type {
  CherryPickOptions,
  CloneOptions,
  MergeOptions,
  NewWorktreeOptions,
  RebaseOptions,
  ResetMode,
  RollbackKind,
  StashPushArgsOptions,
};

export const PROTOCOL_VERSION = 1 as const;

export interface RpcError {
  code: string;
  message: string;
}

export type Msg =
  | { v: 1; id: string; kind: 'req'; method: string; params: unknown }
  | { v: 1; id: string; kind: 'res'; result?: unknown; error?: RpcError }
  | { v: 1; id: string; kind: 'evt'; method: string; params: unknown };

export function isMsg(x: unknown): x is Msg {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m['v'] !== PROTOCOL_VERSION) return false;
  if (m['kind'] === 'req' || m['kind'] === 'evt') {
    return typeof m['id'] === 'string' && typeof m['method'] === 'string';
  }
  if (m['kind'] === 'res') {
    return typeof m['id'] === 'string';
  }
  return false;
}

/** Host→webview event fired when a hidden/restored view should rehydrate. */
export const EVT_REHYDRATE = '$rehydrate';

/** Built-in demo methods (P0-T9 acceptance surface). */
export const DEMO_METHODS = {
  echo: 'demo/echo',
  rows: 'demo/rows',
} as const;

// ---------------------------------------------------------------------------
// Webview dialogs (P11-T1) — the frame contract every P11-P13 dialog speaks
// ---------------------------------------------------------------------------

/**
 * Structurally identical to `core/patch/patchBuilder.LineChange`, so a change
 * list crosses the RPC boundary without mapping. Kept declared here because
 * webviews may not import from `src/core`. 1-based; `originalEndLineNumber`
 * of 0 marks an insertion, `modifiedEndLineNumber` of 0 a deletion.
 */
export interface LineChangeDto {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

// ---------------------------------------------------------------------------
// Commit tool window (P11-T2) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

export interface CommitChangeDto {
  /** Repo-relative, forward slashes — the identity for checked/selected sets. */
  path: string;
  /** Two-char porcelain code (`M.`, `.M`, `??`, `R.`, `UU`). */
  code: string;
  /** Coarse class driving the row colour. */
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  checked: boolean;
  origPath?: string;
  /**
   * P11-T3: only some of this file's changes are included. Absent means the
   * whole file, which is the case for all but a handful of rows — computing it
   * requires a diff per file, so the host ships it only where one exists.
   */
  partial?: { total: number; included: number };
}

/**
 * The Unversioned Files bucket's group id. It lives here rather than beside the
 * changelist service because the webview has to recognise the bucket too — it
 * merges the same changelist across repositories, and the two well-known
 * buckets merge by id where user-created lists can only merge by name.
 * `changelistService.UNVERSIONED_ID` re-exports this so there is one literal.
 */
export const UNVERSIONED_GROUP_ID = '__unversioned__';

export interface CommitGroupDto {
  /** Changelist id, or the sentinel for the Unversioned Files group. */
  id: string;
  name: string;
  comment?: string;
  isActive: boolean;
  isDefault: boolean;
  /** False only for a group that cannot take part in a commit at all. */
  checkable: boolean;
  changes: CommitChangeDto[];
}

export interface CommitRepoDto {
  root: string;
  label: string;
  groups: CommitGroupDto[];
}

export interface CommitStateDto {
  repos: CommitRepoDto[];
  /** Repo the message box and the amend checkbox act on. */
  activeRepo?: string;
  /**
   * Labels of the repositories a commit would actually touch, host-computed
   * through the same predicate the commit path uses. The button renders this
   * rather than deriving it from the tree, so what it promises and what the
   * flow does cannot drift apart.
   */
  targets: string[];
  message: string;
  amend: boolean;
  /** Subject of the commit being amended, shown beside the checkbox. */
  amendSubject?: string;
  signing: boolean;
  /** A mutation is running — the action buttons disable rather than queue. */
  busy: boolean;
  /** The `N modified` counter above the message editor. */
  modifiedCount: number;
  checkedCount: number;
  paradigm: 'changelists' | 'staging';
  error?: string;
  /**
   * P11-T8: `gittree.colors.<status>` overrides (validated host-side). Absent
   * statuses fall back to GitTree's own `gittree.color.*` theme colors (P14-T5).
   */
  colors?: Record<string, string>;
}

/**
 * One file's HEAD↔worktree diff for the commit window's preview pane (P11-T3).
 * `included` is `null` when the whole file is in — the state every file starts
 * in — and an index list once the user has excluded something.
 */
export interface CommitFileDiffDto {
  repoRoot: string;
  path: string;
  originalText: string;
  modifiedText: string;
  changes: LineChangeDto[];
  included: number[] | null;
  /**
   * Whether the file itself is ticked. An unticked file contributes nothing, so
   * its changes must render unticked too — otherwise the pane would show three
   * included changes for a file that is not in the commit.
   */
  checked: boolean;
  /** Binary, or one side missing: per-change inclusion is not offered. */
  wholeFileOnly: boolean;
  /** Identifies the change list this diff describes; guards a racing toggle. */
  signature: string;
}

export const COMMIT_METHODS = {
  /** webview → host */
  init: 'commit/init',
  setChecked: 'commit/setChecked',
  fileDiff: 'commit/fileDiff',
  setIncluded: 'commit/setIncluded',
  setMessage: 'commit/setMessage',
  commit: 'commit/commit',
  toggleAmend: 'commit/toggleAmend',
  refresh: 'commit/refresh',
  openDiff: 'commit/openDiff',
  rollback: 'commit/rollback',
  shelve: 'commit/shelve',
  /** P11-T5: the gear popup's snapshot — author, sign-off, checks, defer. */
  options: 'commit/options',
  /** P11-T5: apply one option change from the gear popup. */
  setOption: 'commit/setOption',
  /** P11-T4: the 50-entry message ring, rendered as an in-webview dropdown. */
  messageHistory: 'commit/messageHistory',
  /** P11-T4: recent commits for the `Amend ▾` reuse-message dropdown. */
  recentCommits: 'commit/recentCommits',
  /** P11-T6: the Shelf tab's snapshot. */
  shelfState: 'commit/shelfState',
  /** P11-T6: one shelf action (unshelve/rename/delete/…) from the tab. */
  shelfAction: 'commit/shelfAction',
  /** POST-P14l: the Stash tab's snapshot. */
  stashState: 'commit/stashState',
  /** POST-P14l: a stash's file list, read on expand (git runs per stash). */
  stashFiles: 'commit/stashFiles',
  /** POST-P14l: one stash action (apply/pop/drop/branch/…) from the tab. */
  stashAction: 'commit/stashAction',
  /** host → webview */
  evtState: 'commit/state',
  /** P11-T6: pushed whenever a shelf store or the show-unshelved toggle changes. */
  evtShelf: 'commit/shelf',
  /** POST-P14l: pushed whenever a stash list or the combine setting changes. */
  evtStash: 'commit/stash',
  /**
   * Host → webview: a *programmatic* message write — history pick, amend
   * prefill, post-commit clear. This is deliberately not part of `evtState`:
   * a generic state push can be built from a snapshot that predates the
   * user's latest keystrokes (the editor persists on a debounce), so the
   * editor ignores `CommitStateDto.message` after init and only ever adopts
   * text from this event. That is what keeps the host from fighting the
   * textarea's native undo stack (master §6's "undo quirks" objection).
   */
  evtMessage: 'commit/message',
} as const;

export interface CommitSetCheckedParamsDto {
  repoRoot: string;
  paths: string[];
  checked: boolean;
}

export interface CommitRunParamsDto {
  repoRoot: string;
  andPush: boolean;
}

export interface CommitSetIncludedParamsDto {
  repoRoot: string;
  path: string;
  included: number[];
  /**
   * The signature the webview was looking at. The host recomputes the diff and
   * drops the toggle if it no longer matches, so a status refresh landing
   * mid-click cannot apply indices to a renumbered change list.
   */
  signature: string;
}

/** P11-T4 — one entry of the per-repo message ring. */
export interface CommitHistoryDto {
  entries: Array<{ message: string; ts: number }>;
}

/** P11-T4 — recent commits whose message can be reused from the Amend ▾ menu. */
export interface CommitRecentCommitsDto {
  commits: Array<{ sha: string; shortSha: string; subject: string; message: string }>;
}

/** P11-T4 — payload of `commit/message` (see `COMMIT_METHODS.evtMessage`). */
export interface CommitMessageEvtDto {
  repoRoot: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Shelf tab (P11-T6)
// ---------------------------------------------------------------------------

export interface CommitShelfFileDto {
  relPath: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  isBinary: boolean;
}

export interface CommitShelfEntryDto {
  id: string;
  name: string;
  comment: string;
  /** Epoch milliseconds. */
  createdAt: number;
  branch: string;
  baseShort: string;
  files: CommitShelfFileDto[];
  /** False when changes.patch no longer matches its recorded sha256 — the row
   *  renders damaged and every unshelve path refuses to touch it. */
  valid: boolean;
  /** Applied-but-kept (IntelliJ's greyed "already unshelved" state). */
  unshelved: boolean;
}

export interface CommitShelfStateDto {
  repos: Array<{ root: string; label: string; entries: CommitShelfEntryDto[] }>;
  /** The eye toggle: whether applied-but-kept entries are listed at all. */
  showUnshelved: boolean;
}

export type CommitShelfActionDto =
  | 'unshelve'
  | 'unshelveSilently'
  | 'unshelveFiles'
  | 'compareWithLocal'
  | 'openDiff'
  | 'showPatch'
  | 'export'
  | 'rename'
  | 'delete'
  | 'import'
  | 'toggleShowUnshelved';

export interface CommitShelfActionParamsDto {
  action: CommitShelfActionDto;
  repoRoot?: string;
  id?: string;
  relPath?: string;
}

// ---------------------------------------------------------------------------
// Stash tab (POST-P14l)
// ---------------------------------------------------------------------------

export interface CommitStashFileDto {
  relPath: string;
  /** Mirrors `StashFileStatus` — kept literal so the row colours typecheck. */
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

/**
 * One stash row. `sha` is the identity every action carries: `index` shifts
 * under the list whenever a stash is pushed or dropped, so acting on
 * `stash@{N}` captured at render time can hit a different stash entirely.
 * The index is still sent, because it is what `stash@{N}` displays.
 */
export interface CommitStashEntryDto {
  sha: string;
  index: number;
  selector: string;
  message: string;
  branch?: string;
  /** Epoch ms, matching `CommitShelfEntryDto.createdAt`. */
  createdAt: number;
}

export interface CommitStashStateDto {
  repos: Array<{ root: string; label: string; entries: CommitStashEntryDto[] }>;
  /**
   * IntelliJ's *Combine stashes and shelves in one tab* (Settings | Version
   * Control | Git | Stash). Off by default there and here: stashes get their
   * own `Stash` tab beside `Shelf`, and turning this on merges the two.
   */
  combined: boolean;
}

export type CommitStashActionDto =
  | 'push'
  | 'apply'
  | 'pop'
  | 'drop'
  | 'branch'
  | 'clear'
  | 'copyMessage'
  | 'diffAll'
  | 'openFileDiff';

export interface CommitStashActionParamsDto {
  action: CommitStashActionDto;
  repoRoot?: string;
  /** Stash identity — never the index. */
  sha?: string;
  /** Set only by `openFileDiff`. */
  relPath?: string;
}

// ---------------------------------------------------------------------------
// Commit options gear popup (P11-T5)
// ---------------------------------------------------------------------------

/** Snapshot behind the gear popup. One request on open; writes go one-by-one. */
export interface CommitOptionsDto {
  repoRoot: string;
  /** `Name <email>` override, or '' when committing as the configured user. */
  author: string;
  /** Deduped `Name <email>` list from recent history, for completion. */
  authorSuggestions: string[];
  signoff: boolean;
  checks: {
    reformat: boolean;
    optimizeImports: boolean;
    cleanup: boolean;
    analyze: boolean;
    todo: boolean;
  };
  analyzeSeverity: 'error' | 'warning';
  todoPattern: string;
  /** The `source.fixAll`-style code-action kind Cleanup applies (its "profile"). */
  cleanupKind: string;
  /** IntelliJ's "Run advanced checks after a commit is done". */
  deferAdvanced: boolean;
}

export type CommitOptionChangeDto =
  | { kind: 'author'; value: string }
  | { kind: 'signoff'; value: boolean }
  | { kind: 'check'; id: 'reformat' | 'optimizeImports' | 'cleanup' | 'analyze' | 'todo'; value: boolean }
  | { kind: 'analyzeSeverity'; value: 'error' | 'warning' }
  | { kind: 'todoPattern'; value: string }
  | { kind: 'cleanupKind'; value: string }
  | { kind: 'deferAdvanced'; value: boolean };

export interface CommitSetOptionParamsDto {
  repoRoot: string;
  option: CommitOptionChangeDto;
}

/**
 * `Name <email>` shape check for the author override — shared so the popup can
 * validate as the user types and the host can refuse what slips past. Kept
 * permissive the way git itself is: any non-angle-bracket name (commas and
 * non-ASCII included), any `local@domain` inside the brackets.
 */
export function isValidAuthor(value: string): boolean {
  return /^[^<>]*[^<>\s][^<>]*\s<[^<>\s@]+@[^<>\s]+>$/.test(value);
}

// ---------------------------------------------------------------------------
// Shelve Changes dialog (P11-T7)
// ---------------------------------------------------------------------------

/** One selectable group in the `Changelist:` dropdown. */
export interface ShelveDialogListDto {
  id: string;
  name: string;
  isActive: boolean;
  files: CommitChangeDto[];
}

export interface ShelveDialogParamsDto {
  repoRoot: string;
  repoLabel: string;
  lists: ShelveDialogListDto[];
  /** Initially selected list (the active one, or the invoking node's). */
  listId: string;
  /** Prefill: the commit-window draft, else the selected list's name. */
  message: string;
  /** P11-T8: status color overrides, same contract as `CommitStateDto.colors`. */
  colors?: Record<string, string>;
}

/** Lazy per-file diff for the collapsible `∨ Diff` section. */
export interface ShelveFileDiffDto {
  path: string;
  originalText: string;
  modifiedText: string;
  changes: LineChangeDto[];
  /** Untracked / deleted / binary: shelves whole, no per-change checkboxes. */
  wholeFileOnly: boolean;
  signature: string;
}

export interface ShelveDialogPartialDto {
  relPath: string;
  included: number[];
  /** Guards staleness — the host re-diffs and falls back to whole-file. */
  signature: string;
}

export interface ShelveDialogResultDto {
  listId: string;
  message: string;
  /** Ticked files shelving whole (partially-included files are NOT in here). */
  paths: string[];
  partials: ShelveDialogPartialDto[];
  removeFromWorktree: boolean;
}

export const SHELVE_DIALOG_METHODS = {
  /** webview → host request: one file's HEAD↔worktree diff. */
  fileDiff: 'shelveDialog/fileDiff',
  /** webview → host request: fresh params (the toolbar's refresh). */
  refresh: 'shelveDialog/refresh',
} as const;

export const DIALOG_METHODS = {
  /** webview→host, request: returns the dialog's initial params. */
  init: 'dialog/init',
  /** webview→host, event: user accepted; params carry the dialog's result. */
  accept: 'dialog/accept',
  /** webview→host, event: user cancelled, closed or pressed Escape. */
  cancel: 'dialog/cancel',
  /** webview→host, event: open this dialog's documentation. */
  help: 'dialog/help',
} as const;

// ---------------------------------------------------------------------------
// Push dialog (P13-T1; IntelliJ's layout since POST-P14ao) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

/** What a row pushes: a branch, or the commit of Push All up to Here. */
export interface PushSourceDto {
  kind: 'branch' | 'revision' | 'detached';
  /** Left of the arrow: the branch, or the commit's short hash. */
  presentation: string;
  /** What `git push` sends: `refs/heads/<branch>` or a commit hash. */
  revision: string;
  /** The local branch behind it, when there is one. */
  branch?: string;
}

/** Where it goes: `remote : branch`, `New` when the remote has no such branch. */
export interface PushTargetDto {
  remote: string;
  /** As `git push` names it: `main` — or a whole ref, Gerrit's `refs/for/master`. */
  branch: string;
  isNew: boolean;
  /** A push-spec ref outside `refs/heads/`. */
  special?: boolean;
  type: 'tracking' | 'pushSpec' | 'custom';
}

/** One outgoing commit — a row of the left tree, and its tooltip. */
export interface PushCommitDto {
  sha: string;
  subject: string;
  /** The whole message, for the tooltip. */
  body: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  authorTime: number;
}

/** One repository of the dialog — a node of the left tree. */
export interface PushRepoDto {
  root: string;
  label: string;
  source: PushSourceDto;
  /** `git remote`; empty means the row offers `Define remote`. */
  remotes: string[];
  /** Absent with no remote, or for an empty repository. */
  target?: PushTargetDto;
  /** The target the dialog opened with: `Set upstream` compares with it. */
  defaultTarget?: PushTargetDto;
  /** The source branch tracks something already, so a new target does not become its upstream on its own. */
  sourceTracks: boolean;
  /** `Empty repository`: shown in red; the repository cannot be pushed. */
  error?: string;
  /** Listing the outgoing commits failed: git's reason, as the row's child. */
  loadError?: string;
  /** Outgoing commits, newest first, at most 1000. */
  commits: PushCommitDto[];
  /** Every remote branch — the target field's suggestions. */
  remoteBranches: Array<{ remote: string; branch: string }>;
  /** Where this source branch was pushed lately, most recent first. */
  recentTargets: Array<{ sourceBranch: string; remote: string; branch: string }>;
  checked: boolean;
}

/** What the dialog keeps between openings, as IntelliJ's push settings do. */
export interface PushDialogUiDto {
  showDetails: boolean;
  groupByDirectory: boolean;
  /** Left tree : right side. */
  treeRatio: number;
  /** Changes : details. */
  detailsRatio: number;
}

export interface PushDialogParamsDto {
  title: string;
  repos: PushRepoDto[];
  /** One repository: no checkboxes, no `Edit all targets`. */
  single: boolean;
  /** The repository row selected first, when nothing was asked for. */
  highlight?: string;
  tags: 'none' | 'all' | 'follow';
  /** `Run Git hooks` is shown only when some repository has a pre-push hook. */
  showRunHooks: boolean;
  /** Render the dim "will run: git push …" line. */
  showCommandLine: boolean;
  /** `git push --force-if-includes` supported — the preview line must be exact. */
  forceIfIncludes: boolean;
  /** Branch patterns Force Push refuses (`gittree.protectedBranches`). */
  protectedBranches: string[];
  /** Targets force-pushed to with `Don't warn about this target`. */
  silentForceTargets: Array<{ remote: string; branch: string }>;
  ui: PushDialogUiDto;
  /** P11-T8 status color overrides for the file tree. */
  colors?: Record<string, string>;
  /** Issue links in the commit details. */
  issue?: { pattern: string; url: string };
}

/** The outgoing commits for an edited target. */
export interface PushRetargetDto {
  target: PushTargetDto;
  commits: PushCommitDto[];
  loadError?: string;
}

export interface PushDialogResultDto {
  /** The checked repositories that can be pushed, each with its target. */
  repos: Array<{
    root: string;
    source: PushSourceDto;
    target: { remote: string; branch: string };
    /** `Set upstream` ticked for this target. */
    setUpstream: boolean;
  }>;
  tags: 'none' | 'all' | 'follow';
  runHooks: boolean;
  /** Force Push — confirmed in the dialog already. */
  force: boolean;
  /** `Don't warn about this target`, ticked when confirming. */
  dontWarnForce?: { remote: string; branch: string };
}

export type PushDefineRemoteResultDto =
  | { ok: true; repo: PushRepoDto }
  | { ok: false; field: 'name' | 'url'; message: string };

export const PUSH_DIALOG_METHODS = {
  /**
   * webview → host request: the commits for an edited target. Params
   * `{root, remote, branch}`; returns `PushRetargetDto`.
   */
  retarget: 'pushDialog/retarget',
  /**
   * webview → host request: the merged changes of some commits of one
   * repository (IntelliJ's `zipChanges`). Params `{root, shas}`, oldest first;
   * returns `{files: CommitFileDto[]}`, each file with its two revisions.
   */
  changes: 'pushDialog/changes',
  /** webview → host request: one commit's details. Params `{root, sha}`; returns `CommitDetailsDto`. */
  details: 'pushDialog/details',
  /**
   * webview → host request: `Show Diff` for some files of one repository.
   * Params `{root, files: CommitFileDto[], index}`; returns `{ok: boolean}`.
   */
  openDiff: 'pushDialog/openDiff',
  /**
   * webview → host request: the toolbar's `Edit Source` — open the worktree
   * file. Params `{root, path}`; returns `{ok: boolean}`.
   */
  openFile: 'pushDialog/openFile',
  /**
   * webview → host request: IntelliJ's Define Remote — check the URL with
   * `git ls-remote`, add the remote, fetch it when asked. Params
   * `{root, name, url, fetch}`; returns `PushDefineRemoteResultDto`.
   */
  defineRemote: 'pushDialog/defineRemote',
  /** webview → host event: remember `Show Details`, grouping and splitter positions. */
  saveUi: 'pushDialog/saveUi',
} as const;

// ---------------------------------------------------------------------------
// Merge · Rebase · Reset · Rollback dialogs (P13-T3) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

/** One entry in a dialog's ref picker. */
export interface DialogRefDto {
  name: string;
  kind: 'local' | 'remote' | 'tag';
  upstream?: string;
}

/** Fields every T3 dialog's params carry. */
export interface OpDialogBaseDto {
  repoRoot: string;
  repoLabel: string;
  currentBranch: string;
  showCommandLine: boolean;
}

export interface MergeDialogParamsDto extends OpDialogBaseDto {
  refs: DialogRefDto[];
  defaultRef: string;
}

export interface MergeDialogResultDto {
  options: MergeOptions;
}

export interface RebaseDialogParamsDto extends OpDialogBaseDto {
  refs: DialogRefDto[];
  defaultOnto: string;
}

export interface RebaseDialogResultDto {
  options: RebaseOptions;
}

export interface ResetDialogParamsDto extends OpDialogBaseDto {
  refs: DialogRefDto[];
  defaultRef: string;
  /** Dirty entries right now — the live "will discard N local changes" line. */
  dirtyCount: number;
  stagedCount: number;
}

export interface ResetDialogResultDto {
  ref: string;
  mode: ResetMode;
}

export interface RollbackFileDto {
  path: string;
  /** Two-char porcelain code, for the badge. */
  code: string;
  kind: RollbackKind;
  origPath?: string;
}

export interface RollbackDialogParamsDto extends OpDialogBaseDto {
  files: RollbackFileDto[];
  /** Pre-ticked paths — the selection the command was invoked with. */
  checked: string[];
  deleteAddedLocalCopies: boolean;
  colors?: Record<string, string>;
}

export interface RollbackDialogResultDto {
  paths: string[];
  deleteAddedLocalCopies: boolean;
}

export const ROLLBACK_DIALOG_METHODS = {
  /** webview → host request: one file's HEAD↔worktree diff for the preview. */
  fileDiff: 'rollbackDialog/fileDiff',
} as const;

/** The preview pane's payload — same shape the Shelve dialog's diff uses. */
export interface RollbackFileDiffDto {
  path: string;
  originalText: string;
  modifiedText: string;
  changes: LineChangeDto[];
  /** Binary, too large, or otherwise not line-diffable. */
  wholeFileOnly: boolean;
}

// ---------------------------------------------------------------------------
// Cherry-pick · Stash · Unstash · Apply Patch · Clone · Remotes (P13-T4)
// ---------------------------------------------------------------------------

export interface CherryPickCommitDto {
  sha: string;
  subject: string;
  authorName: string;
  authorTime: number;
  /** Merge commits need `-m <parent>`; the dialog only offers it for these. */
  parentCount: number;
  /** Branch/ref the commit was found on, for the list's dim suffix. */
  ref?: string;
}

export interface CherryPickDialogParamsDto extends OpDialogBaseDto {
  commits: CherryPickCommitDto[];
  /** `gittree.cherryPick.recordOrigin` — the `-x` default. */
  recordOrigin: boolean;
}

export interface CherryPickDialogResultDto {
  options: CherryPickOptions;
}

export interface StashDialogParamsDto extends OpDialogBaseDto {
  /** git ≥ 2.35 — `--staged` is offered only when the build supports it. */
  canStashStaged: boolean;
  dirtyCount: number;
  untrackedCount: number;
  stagedCount: number;
  includeUntrackedDefault: boolean;
}

export interface StashDialogResultDto {
  options: StashPushArgsOptions;
}

export interface UnstashEntryDto {
  index: number;
  message: string;
  branch?: string;
  /** Unix seconds. */
  date?: number;
}

export interface UnstashFileDto {
  path: string;
  status: string;
}

export interface UnstashDialogParamsDto extends OpDialogBaseDto {
  entries: UnstashEntryDto[];
  /** Changelists the restored work can land in (P3) — IntelliJ's target selector. */
  changelists: Array<{ id: string; name: string }>;
  activeChangelistId: string;
}

export interface UnstashDialogResultDto {
  index: number;
  pop: boolean;
  reinstateIndex: boolean;
  changelistId: string;
}

export const UNSTASH_DIALOG_METHODS = {
  /** webview → host request: the files in one stash entry. Params `{index}`. */
  files: 'unstashDialog/files',
  /** webview → host request: one file's diff inside a stash. Params `{index, relPath}`. */
  fileDiff: 'unstashDialog/fileDiff',
} as const;

export interface PatchFileSummaryDto {
  relPath: string;
  hunks: number;
  status: string;
  /** The patch touches a file that is not in the worktree. */
  missing: boolean;
}

export interface ApplyPatchDialogParamsDto extends OpDialogBaseDto {
  /** Empty until the user picks a file. */
  patchPath: string;
  summary: PatchFileSummaryDto[];
  isMailbox: boolean;
  /** Parse/read failure, shown instead of the summary. */
  error?: string;
}

export interface ApplyPatchDialogResultDto {
  patchPath: string;
  threeWay: boolean;
  reverse: boolean;
  pDepth: number;
  whitespaceFix: boolean;
  /** Force a content-only apply even for a mailbox patch. */
  contentOnly: boolean;
}

export const PATCH_DIALOG_METHODS = {
  /** webview → host request: open the file picker; returns fresh params. */
  choose: 'patchDialog/choose',
  /** webview → host request: re-read the summary for `{patchPath}`. */
  inspect: 'patchDialog/inspect',
} as const;

export interface CloneDialogParamsDto {
  /** Directory the destination field starts in. */
  defaultParent: string;
  showCommandLine: boolean;
}

export interface CloneDialogResultDto {
  options: CloneOptions;
  /** What to do with the clone once it exists. */
  openAfter: 'window' | 'add' | 'none';
}

export const CLONE_DIALOG_METHODS = {
  /** webview → host request: native folder picker; returns `{directory}`. */
  browse: 'cloneDialog/browse',
  /** webview → host request: is `{directory}` usable? Returns `{ok, reason?}`. */
  checkDirectory: 'cloneDialog/checkDirectory',
} as const;

export interface RemoteRowDto {
  name: string;
  fetchUrl: string;
  /** Empty means "same as fetch". */
  pushUrl: string;
}

export interface RemotesDialogParamsDto extends OpDialogBaseDto {
  remotes: RemoteRowDto[];
}

export interface RemotesOpResultDto {
  ok: boolean;
  message?: string;
  /** The table after the operation — the dialog re-renders from this. */
  remotes: RemoteRowDto[];
}

// ---------------------------------------------------------------------------
// New Worktree dialog (P13-T6)
// ---------------------------------------------------------------------------

export interface NewWorktreeDialogParamsDto {
  repoRoot: string;
  repoLabel: string;
  branches: string[];
  /** The remotes, for what a new branch would track: the dialog previews the real command. */
  remoteNames: string[];
  seedBranch: string;
  /**
   * The seed is this worktree's checked-out branch, so git will refuse to
   * check it out again — the dialog opens in "create a new branch" mode
   * instead of presenting a choice that cannot succeed. Branches held by
   * *other* worktrees are not detectable here (that needs `worktree list`)
   * and stay the `--force` case they always were.
   */
  seedBranchIsHead: boolean;
  /** Sibling `../<repo>-<branch>`, IntelliJ's default location. */
  defaultPath: string;
  showCommandLine: boolean;
}

export interface NewWorktreeDialogResultDto {
  options: NewWorktreeOptions;
  openInNewWindow: boolean;
}

// ---------------------------------------------------------------------------
// Files Merged with Conflicts dialog (P13-T8 · S7)
// ---------------------------------------------------------------------------

export interface ConflictsDialogFileDto {
  path: string;
  /** `text`, `both-added`, `deleted-by-us`, … — the classified conflict kind. */
  kind: string;
  /** Special conflicts have no line-level merge to open. */
  mergeable: boolean;
}

export interface ConflictsDialogParamsDto {
  repoRoot: string;
  repoLabel: string;
  /** `merge`, `rebase`, `cherry-pick`… — what produced the conflicts. */
  operation: string;
  files: ConflictsDialogFileDto[];
  colors?: Record<string, string>;
}

export interface ConflictsDialogResultDto {
  action: 'acceptYours' | 'acceptTheirs' | 'resolveSimple' | 'merge';
  /** The ticked files the action applies to. */
  paths: string[];
}

export const REMOTES_DIALOG_METHODS = {
  /** webview → host request: add or edit. Params `{before?, after}`. */
  save: 'remotesDialog/save',
  /** webview → host request: `{name}`. */
  remove: 'remotesDialog/remove',
  /** webview → host request: `git remote prune <name>`. */
  prune: 'remotesDialog/prune',
} as const;

// ---------------------------------------------------------------------------
// Log view (P4-T3/T4) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

export interface LogFilterDto {
  refs?: string[] | 'ALL' | 'HEAD';
  range?: { a: string; b: string };
  authors?: string[];
  dateRange?: { from?: string; to?: string };
  paths?: string[];
  text?: { q: string; regex: boolean; matchCase: boolean };
  sort: 'topo' | 'date' | 'intelli';
  follow?: boolean;
  /** Graph Options ▸ First Parent; replaces the sort while on (see `LogFilter`). */
  firstParent?: boolean;
  /** Graph Options ▸ No Merges. */
  noMerges?: boolean;
}

export interface GraphLaneDto {
  lane: number;
  colorIdx: number;
}

export interface GraphForkDto extends GraphLaneDto {
  kind: 'first' | 'extra';
  joinsExisting?: boolean;
}

export interface GraphRowDto {
  nodeLane: number;
  colorIdx: number;
  lanesBefore: GraphLaneDto[];
  joins: GraphLaneDto[];
  forks: GraphForkDto[];
  continues: GraphLaneDto[];
}

export interface RefChipDto {
  name: string;
  type: 'branch' | 'remote-branch' | 'tag' | 'head';
  isHeadTarget?: boolean;
}

export interface LogRowDto {
  sha: string;
  subject: string;
  authorName: string;
  /** Unix seconds. */
  authorTime: number;
  parents: string[];
  refs: RefChipDto[];
  /**
   * Someone other than the author committed it (a rebase, a cherry-pick):
   * the Author column adds IntelliJ's `*`.
   */
  committedByOther?: boolean;
  side?: 'left' | 'right';
  graph: GraphRowDto;
}

export interface LogPageDto {
  page: number;
  rows: LogRowDto[];
  eof: boolean;
  /** The Log tab these rows are for; absent means the main tab. */
  logTab?: string;
}

/**
 * One workspace repository in the `Paths ▾ · Roots` section. `colorIdx` indexes
 * the graph palette so a repository keeps the same swatch across re-inits.
 */
export interface LogRootDto {
  root: string;
  /** Basename, or `parent/basename` where two roots would otherwise collide. */
  label: string;
  colorIdx: number;
}

/**
 * How the Git tool window draws refs. IntelliJ splits this across two menus: the
 * Commits pane's `Presentation Settings ▾ · Show · Tag Names` and the Branches
 * pane's `Branches Pane Settings · Show Tags`. Both are real settings, so they also
 * sit in VS Code's Settings editor, where IntelliJ's sit on its Version Control
 * pages.
 */
export interface LogPresentationDto {
  /**
   * `gittree.log.showTagNames`: a commit's tags are named chips, or one tag icon
   * whose names are a hover away.
   */
  showTagNames: boolean;
  /** `gittree.branches.showTags`: the Branches pane lists a `Tags` node. */
  showTags: boolean;
  /**
   * `gittree.log.compactReferences`, IntelliJ's Compact References View: a
   * commit's refs are one label, named after the first, with every ref's
   * colour stacked in its icon.
   */
  compactReferences: boolean;
  /** `gittree.log.referencesOnLeft`: the labels go before the message, not at its end. */
  referencesOnLeft: boolean;
  /** `gittree.log.columns.author`: Presentation Settings ▸ Columns ▸ Author. */
  showAuthorColumn: boolean;
  /** `gittree.log.columns.date`: Presentation Settings ▸ Columns ▸ Date. */
  showDateColumn: boolean;
  /** `gittree.log.columns.hash`: Presentation Settings ▸ Columns ▸ Hash. */
  showHashColumn: boolean;
}

/** What a view draws before the host has said otherwise: IntelliJ's own defaults. */
export const DEFAULT_LOG_PRESENTATION: LogPresentationDto = {
  showTagNames: false,
  showTags: true,
  compactReferences: true,
  referencesOnLeft: false,
  showAuthorColumn: true,
  showDateColumn: true,
  showHashColumn: false,
};

export interface LogInitDto {
  repoRoot: string;
  repoLabel: string;
  /**
   * Every repository the workspace has. The log renders one of them —
   * `repoRoot` says which — and the `Roots` section switches between them.
   */
  roots?: LogRootDto[];
  filter: LogFilterDto;
  laneWidth: number;
  /** P10-T2: graph palette variant (`gittree.log.graphPalette`). */
  graphPalette?: 'default' | 'colorBlind';
  /** P11-T8 palette overrides, same contract as `CommitStateDto.colors`. */
  colors?: Record<string, string>;
  /** P12-T4: issue-key linkification (`gittree.log.issuePattern`/`issueUrl`). */
  issue?: { pattern: string; url: string };
  /** P12-T5: saved filter presets (`gittree.log.filterPresets`). */
  presets?: Array<{ name: string; filter: LogFilterDto }>;
  /** How refs are drawn — see `LogPresentationDto`. */
  presentation?: LogPresentationDto;
  /** The Log tab this init is for (`LogTabDto.id`); absent means the main tab. */
  logTab?: string;
  /**
   * Set only on an `evtReset` the *host* raised because history moved (a
   * commit, checkout, rebase, pull…), never on one the user asked for. The
   * webview keeps its place across it — re-anchoring on the focused commit,
   * or on the row that was at the top when nothing was selected — instead of
   * clearing the panes and jumping to the newest commit.
   */
  preserve?: boolean;
}

/** One Log tab in the Git tool window's strip. */
export interface LogTabDto {
  id: string;
  /** What the tab shows; its title is made from this (`Log`, `Log: main`, `History: a.ts`). */
  filter: LogFilterDto;
  /** Every tab but the first, which is the log itself. */
  closable: boolean;
}

/** The Log tabs, and which one commands act on. */
export interface LogTabsDto {
  /** The main tab first, then the extra tabs in the order they were opened. */
  tabs: LogTabDto[];
  active: string;
  /**
   * A strip item to bring forward: a Log tab id, `console` or `worktrees`.
   * Set when a command opened or picked a tab, and on the first `log/tabs`
   * when something asked for a tab (`evtShowTab`) before this view could hear
   * the event itself (POST-P14af).
   */
  show?: string;
}

export interface CommitFileDto {
  status: string;
  path: string;
  origPath?: string;
  /**
   * Set when the file comes from several selected commits: the revision its
   * diff starts from (`<sha>^` of the earliest selected commit that touched
   * it; absent for a file those commits added) and the one it ends at (the
   * latest such commit; absent for a file they deleted).
   */
  before?: string;
  after?: string;
}

/**
 * P12-T3 — the Changed Files pane's data. One commit ships its own files.
 * Several selected commits ship IntelliJ's merge of **their** changes: the
 * files they touched, each with its own `before`/`after` revisions — not the
 * whole `<oldest>^..<newest>` range, which would pull in commits nobody
 * selected.
 */
export interface LogChangedFilesDto {
  files: CommitFileDto[];
  /** The newest commit shown. */
  newest?: string;
  /** Present for several commits: the ones the files come from, newest first. */
  shas?: string[];
}

/** P12-T8 — one Console row: a redacted, structured git run. */
export interface LogConsoleEntryDto {
  seq: number;
  /** Epoch ms. */
  ts: number;
  argv: string[];
  exitCode: number;
  durationMs: number;
  output: string;
}

// ---------------------------------------------------------------------------
// Branches pane (P12-T2)
// ---------------------------------------------------------------------------

export interface LogBranchesDto {
  /** Current branch name; undefined when detached. */
  current?: string;
  detached: boolean;
  /**
   * `upstream` is the branch's tracked remote branch (`origin/main`): a row
   * that carries both draws them as one label, as IntelliJ does.
   */
  locals: Array<{ name: string; favorite: boolean; upstream?: string }>;
  remotes: Array<{ remote: string; branches: string[] }>;
  tags: string[];
  /** user.email — what "Show my commits" filters the log by. */
  myAuthor?: string;
  /** user.name — what "Highlight my commits" matches row authors against. */
  myName?: string;
}

export interface LogBranchActionParamsDto {
  /** A `branchActions.ts` id, or 'new' (the rail's `+`, no ref needed). */
  action: string;
  name?: string;
  type?: 'local' | 'remote' | 'tag';
}

// ---------------------------------------------------------------------------
// Worktrees pane (POST-P14k)
// ---------------------------------------------------------------------------

/**
 * One worktree row. `path` is the identity the host resolves back to a
 * `WorktreeInfo` — the pane never holds a live handle, so a row acted on after
 * the list moved underneath it fails on the host's own lookup rather than on a
 * stale object.
 */
export interface LogWorktreeDto {
  path: string;
  /** Branch name, or undefined when detached or bare. */
  branch?: string;
  /** Short HEAD sha, for the detached label. */
  head?: string;
  isMain: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

export interface LogWorktreesDto {
  /** One group per workspace repository, in `core.repos` order. */
  repos: Array<{ root: string; label: string; worktrees: LogWorktreeDto[] }>;
}

export interface LogWorktreeActionParamsDto {
  action: 'add' | 'open' | 'remove' | 'lock' | 'unlock' | 'prune' | 'refresh';
  /** The repository the row belongs to; required for every action but none is trusted blindly. */
  repoRoot?: string;
  /** The acted-on worktree; absent for `add` / `prune` / `refresh`. */
  path?: string;
}

export interface CommitDetailsDto {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  /** P12-T4: `%G?` GPG state (G/B/U/X/Y/R/E/N). Absent from older hosts. */
  signature?: string;
  refs: string[];
  body: string;
  files: CommitFileDto[];
}

/**
 * Requests and events about one Log tab carry its id as `logTab` (absent means
 * the main tab, `MAIN_LOG_TAB`): init, page, details, commitMessage, setFilter,
 * the pickers, setRoot, the diffs, select, branches, branchAction,
 * changedFiles, showFileHistory, containedBranches, goTo, authors, refresh and
 * goToRef; and back, rows, reset, reveal, branchesChanged and focusFilter.
 */
export const LOG_METHODS = {
  /** webview → host */
  /** The Log tabs (`LogTabsDto`), asked for once before any tab starts. */
  tabs: 'log/tabs',
  /** The strip's `+`: a new tab copying `{ from }`'s filters; answers `{ logTab }`. */
  openTab: 'log/openTab',
  /** `{ tabs }`: × and the tab menu's Close Tab / Close Other Tabs / Close All Tabs. */
  closeTabs: 'log/closeTabs',
  /** `{ logTab }`: the user brought a Log tab forward; commands act on it from now on. */
  activateTab: 'log/activateTab',
  init: 'log/init',
  page: 'log/page',
  details: 'log/details',
  /**
   * POST-P14x: one commit's full message, for the row hover. Deliberately not
   * a field on `LogRowDto` — a 100k-commit page would carry every body it
   * will never show, and `details` costs a `--name-status` nobody hovering
   * has asked for.
   */
  commitMessage: 'log/commitMessage',
  setFilter: 'log/setFilter',
  pickAuthors: 'log/pickAuthors',
  pickDates: 'log/pickDates',
  pickPaths: 'log/pickPaths',
  /** `Paths ▾ · Select in Tree…` — a tree-ordered pick over the tracked paths. */
  pickPathsInTree: 'log/pickPathsInTree',
  /** `Paths ▾ · Roots` — show a different workspace repository. */
  setRoot: 'log/setRoot',
  openFileDiff: 'log/openFileDiff',
  openAllDiffs: 'log/openAllDiffs',
  copy: 'log/copy',
  /** P12-T1: the one host-side selection model every pane and command reads. */
  select: 'log/select',
  /** P12-T2: the Branches pane's ref snapshot. */
  branches: 'log/branches',
  /** P12-T2: one rail/context action on a ref, run through the shared registry. */
  branchAction: 'log/branchAction',
  /** P12-T3: the Changed Files pane — single commit or a multi-select aggregate. */
  changedFiles: 'log/changedFiles',
  /** P12-T3: `Show History for Revision` on a file row. */
  showFileHistory: 'log/showFileHistory',
  /** P12-T4: lazy `git branch --contains` — on click, never on selection. */
  containedBranches: 'log/containedBranches',
  /** P12-T4: parent-link navigation — reveal + select a sha in the graph. */
  goTo: 'log/goTo',
  /** P12-T5: author list for the User ▾ dropdown. */
  authors: 'log/authors',
  /** P12-T5: the toolbar's refresh. */
  refresh: 'log/refresh',
  /** P12-T5: Go to Hash/Branch/Tag — resolve a ref and reveal it. */
  goToRef: 'log/goToRef',
  /** P12-T5: persist the current filter as a named preset. */
  savePreset: 'log/savePreset',
  /** P12-T5: delete a named preset. */
  deletePreset: 'log/deletePreset',
  /** P12-T8: the Console tab's ring (delta read via afterSeq). */
  consoleEntries: 'log/console',
  /** P12-T8: clear the ring. */
  consoleClear: 'log/consoleClear',
  /** POST-P14k: the Worktrees tab's list, every repository at once. */
  worktrees: 'log/worktrees',
  /** POST-P14k: one row/toolbar action, dispatched to the `gittree.worktree.*` commands. */
  worktreeAction: 'log/worktreeAction',
  /**
   * A toggle in `Presentation Settings ▾` or `Branches Pane Settings`:
   * `Partial<LogPresentationDto>` in, the resulting `LogPresentationDto` out.
   */
  setPresentation: 'log/setPresentation',
  /** host → webview events */
  evtRows: 'log/rows',
  evtReset: 'log/reset',
  evtReveal: 'log/reveal',
  /** P12-T2: refs changed (branch created/deleted, favorite toggled…). */
  evtBranches: 'log/branchesChanged',
  /**
   * A repository joined or left the workspace, so `Paths ▾ · Roots` changed.
   * Sent on its own rather than through `evtReset`, which restarts paging and
   * drops the selection — too much for a list that only names repositories.
   */
  evtRoots: 'log/rootsChanged',
  /**
   * A presentation setting changed (`LogPresentationDto`), from a menu or from the
   * Settings editor. Sent on its own rather than through `evtReset`: how a ref is
   * drawn is no reason to re-run `git log` or drop the selection.
   */
  evtPresentation: 'log/presentationChanged',
  /** The Log tabs changed (`LogTabsDto`): opened, closed, refiltered, or one picked by a command. */
  evtTabs: 'log/tabsChanged',
  /** P12-T8: the command ring grew or was cleared (throttled, payload-free). */
  evtConsole: 'log/consoleChanged',
  /** POST-P14k: a worktree was added/removed/locked, or a repo's refs moved (payload-free). */
  evtWorktrees: 'log/worktreesChanged',
  /** P10-T2: keyboard parity — move focus into the filter search box. */
  evtFocusFilter: 'log/focusFilter',
  /**
   * POST-P14af: switch to one of the tool window's tabs (`{ tab }`: a Log tab
   * id, `console` or `worktrees`) — what a push notification's `Show Details`
   * does, IntelliJ's "Show details in console".
   */
  evtShowTab: 'log/showTab',
} as const;

/**
 * What callers ask the Git tool window to show: `log` is whichever Log tab is
 * active, which is the main tab unless the user brought another forward.
 */
export type LogTab = 'log' | 'console' | 'worktrees';

// ---------------------------------------------------------------------------
// Interactive rebase editor (P5-T2) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

export type RebaseActionDto = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebaseRowDto {
  /** Full sha. */
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** Unix seconds. */
  authorTime: number;
  /** Full original commit message (reword prefill / squash concatenation). */
  message: string;
  action: RebaseActionDto;
  /** Custom message set in the dialog (reword / squash-with-message). */
  newMessage?: string;
}

export type RebasePhaseDto = 'edit' | 'running' | 'paused' | 'done';

export interface RebaseStateDto {
  repoRoot: string;
  branch: string;
  baseSha: string;
  baseShort: string;
  /** Oldest first — exactly the todo order. */
  rows: RebaseRowDto[];
  /** Range reaches published history — Start requires acknowledgement. */
  published: boolean;
  phase: RebasePhaseDto;
  progress?: { step?: number; total?: number };
  /** Per-step log lines shown in progress mode. */
  log: string[];
  outcome?: 'completed' | 'failed' | 'aborted' | 'refused-merges';
  /** Conflicted paths while paused. */
  conflicts?: string[];
}

export interface RebaseStartParamsDto {
  entries: Array<{ sha: string; action: RebaseActionDto; message?: string }>;
  forceAcknowledged: boolean;
}

export const REBASE_METHODS = {
  /** webview → host */
  init: 'rebase/init',
  start: 'rebase/start',
  cancel: 'rebase/cancel',
  continue: 'rebase/continue',
  skip: 'rebase/skip',
  abort: 'rebase/abort',
  /** host → webview events */
  evtState: 'rebase/state',
  /** Context-menu "Reset Action" on a row → back to pick. */
  evtResetAction: 'rebase/resetAction',
} as const;

// ---------------------------------------------------------------------------
// Branches panel (new-way-4)
// ---------------------------------------------------------------------------

/** A ref as the Branches panel draws it: the fields its rows and cards read. */
export interface BranchPanelRefDto {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  readonly name: string;
  readonly sha: string;
  /** Unix seconds: the tip commit's date (an annotated tag's own). */
  readonly date?: number;
  readonly subject?: string;
  /** Local branches: the remote branch it tracks, `origin/main`. */
  readonly upstream?: string;
  /** Commits the branch has and its upstream lacks: what a push sends. */
  readonly ahead?: number;
  /** Commits the upstream has and the branch lacks: what an update brings. */
  readonly behind?: number;
  /** The tracked remote branch has been deleted. */
  readonly gone?: boolean;
  /** The checked-out branch (local branches only). */
  readonly current?: boolean;
  /** Remote branches: the remote's name, `origin`. */
  readonly remote?: string;
}

/** Git is in the middle of something in a repository. */
export interface BranchPanelOperationDto {
  readonly kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  /** Conflicted paths still to resolve. */
  readonly conflicts: number;
  /** Rebase progress, when git reports it. */
  readonly step?: number;
  readonly total?: number;
}

export interface BranchPanelRepoDto {
  readonly root: string;
  /** The name every GitTree surface uses for this root. */
  readonly label: string;
  /** Palette slot: the colour the log's `Roots` gives the same repository. */
  readonly colorIdx: number;
  /** The checked-out branch; absent when HEAD is detached. */
  readonly head?: string;
  readonly detached: boolean;
  readonly headSha?: string;
  /** No commit yet. */
  readonly unborn: boolean;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly upstreamGone?: boolean;
  /** Changed files, staged or not, untracked included. */
  readonly changes: number;
  readonly operation?: BranchPanelOperationDto;
  /** A fetch GitTree started is running here. */
  readonly fetching: boolean;
  readonly locals: readonly BranchPanelRefDto[];
  readonly remotes: readonly BranchPanelRefDto[];
  readonly tags: readonly BranchPanelRefDto[];
  /** Local branches checked out lately, most relevant first; the current one excluded. */
  readonly recent: readonly string[];
  /** Starred branches. */
  readonly favorites: readonly string[];
  /** What "merged" is measured against: the remote's default branch, `origin/main`. */
  readonly mainBranch?: string;
  /** Local branches with commits of their own, all of which have reached `mainBranch`. */
  readonly merged: readonly string[];
}

export interface BranchPanelStateDto {
  readonly repos: readonly BranchPanelRepoDto[];
  readonly showTags: boolean;
  readonly showInOut: boolean;
  readonly groupByFolder: boolean;
  /** A fetch of every repository is running. */
  readonly fetchingAll: boolean;
  /** The host's clock when this was built, unix seconds: ages are measured from it. */
  readonly now: number;
  /** The log's lane palette, so a repository's colour here is its colour there. */
  readonly palette: 'default' | 'colorBlind';
}

export type BranchPanelRefKind = 'local' | 'remote' | 'tag';

/**
 * What a gesture on a branch row is about: one ref name, in the repositories
 * the row stands for — the one repository of a single-root workspace, or in a
 * multi-root one every repository in view that has the ref.
 */
export interface BranchPanelTargetDto {
  readonly kind: BranchPanelRefKind;
  readonly name: string;
  readonly roots: readonly string[];
}

/** One repository's half of a branch card. Read when the card opens: it costs git calls. */
export interface BranchPanelRepoDetailsDto {
  readonly root: string;
  readonly author?: string;
  /** Unix seconds of the tip commit. */
  readonly date?: number;
  /** Against the repository's checked-out branch; absent for that branch itself. */
  readonly vsHead?: {
    /** What HEAD is: the branch name, or a short sha when detached. */
    readonly head: string;
    /** Commits on the ref that HEAD lacks. */
    readonly ahead: number;
    /** Commits on HEAD that the ref lacks. */
    readonly behind: number;
  };
  /** A remote branch: the local branch tracking it. */
  readonly trackedBy?: string;
}

export interface BranchPanelButtonDto {
  readonly run: BranchPanelRunDto;
  /** Short, for the button: `Merge into main`. */
  readonly label: string;
  /** Whole, for the tooltip: `Merge 'feature/x' into 'main'`. */
  readonly title: string;
  readonly icon: string;
}

export interface BranchPanelDetailsDto {
  readonly repos: readonly BranchPanelRepoDetailsDto[];
  /** The card's buttons: the two or three actions that matter most for this ref now. */
  readonly buttons: readonly BranchPanelButtonDto[];
}

/** Something to do, sent back to `branches/run`. */
export type BranchPanelRunDto =
  | {
      /** A `branchActions` action on a target. */
      readonly type: 'action';
      readonly target: BranchPanelTargetDto;
      readonly action: string;
      /** Only in this one of the target's repositories. */
      readonly root?: string;
    }
  | {
      /** A GitTree command, given the repository's root (or nothing: every root). */
      readonly type: 'command';
      readonly command: string;
      readonly root?: string;
      /** A second argument, after the root: a branch name. */
      readonly arg?: string;
    }
  | {
      /** Opens the panel's own New Branch form, starting at `from`. */
      readonly type: 'newBranch';
      readonly from: string;
      readonly roots: readonly string[];
    };

/** A menu entry the host built; the webview draws it and sends `run` back. */
export type BranchPanelMenuItemDto =
  | {
      readonly kind: 'item';
      readonly label: string;
      readonly run: BranchPanelRunDto;
      readonly accelerator?: string;
      readonly icon?: string;
    }
  | {
      readonly kind: 'submenu';
      readonly label: string;
      readonly items: readonly BranchPanelMenuItemDto[];
      readonly icon?: string;
    }
  | { readonly kind: 'separator' }
  | { readonly kind: 'header'; readonly label: string };

/** The New Branch form, submitted. */
export interface BranchPanelCreateDto {
  readonly name: string;
  /** Where it starts: a ref every chosen repository has, or `HEAD` for each one's own. */
  readonly from: string;
  readonly roots: readonly string[];
  readonly checkout: boolean;
}

export interface BranchPanelCreateResultDto {
  readonly ok: boolean;
  /** Why not, for the form to show. */
  readonly error?: string;
}

/** Panel settings the webview can change; each is a `gittree.branches.*` setting. */
export type BranchPanelSettingKey = 'showTags' | 'showIncomingOutgoing' | 'groupByFolder';

export const BRANCHES_METHODS = {
  /** webview → host: the first paint; answers a `BranchPanelStateDto`. */
  init: 'branches/init',
  /** host → webview: the state changed. */
  evtState: 'branches/state',
  /** webview → host: a branch card's details (`{ target }` → `BranchPanelDetailsDto`). */
  details: 'branches/details',
  /** webview → host: a branch row's menu (`{ target }`) or a repository's (`{ root }`). */
  menu: 'branches/menu',
  /** webview → host: run a `BranchPanelRunDto` (`{ run }`). */
  run: 'branches/run',
  /** webview → host: star or unstar a branch (`{ target, on }`). */
  favorite: 'branches/favorite',
  /** webview → host: the New Branch form (`BranchPanelCreateDto` → `BranchPanelCreateResultDto`). */
  create: 'branches/create',
  /** webview → host: change a panel setting (`{ key, value }`). */
  setting: 'branches/setting',
  /** webview → host: Fetch every repository; resolves when it is done. */
  fetchAll: 'branches/fetchAll',
  /** webview → host: one branch dropped onto another (`{ source, target }`). */
  drop: 'branches/drop',
  /** host → webview: open the New Branch form (`{ from?, roots? }`). */
  evtNewBranch: 'branches/newBranch',
  /** host → webview: put the cursor in the filter field. */
  evtFocusFilter: 'branches/focusFilter',
} as const;

/** One entry of a repository's menu (`repositoryMenu.ts`). */
export interface BranchesActionDto {
  readonly id: string;
  readonly label: string;
  readonly accelerator?: string;
  /** Group boundary before this entry — the menu draws a rule. */
  readonly separator?: boolean;
}
