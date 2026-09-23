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
import type { TreeRow } from '../branches/popupTree';

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
// Push dialog (P13-T1) — host ⇄ webview DTOs
// ---------------------------------------------------------------------------

export interface PushCommitDto {
  sha: string;
  subject: string;
  authorName: string;
  /** Unix seconds. */
  authorTime: number;
}

export interface PushFileDto {
  /** Single-letter status (`A`/`M`/`D`/`R`…), the `--name-status` letter. */
  status: string;
  path: string;
  /** Rename/copy source. */
  origPath?: string;
}

/** One repository section — multi-root workspaces get one each. */
export interface PushRepoSectionDto {
  root: string;
  label: string;
  /** Current local branch. Detached/unborn repos are filtered out host-side. */
  branch: string;
  /** Remote names (`git remote`); empty means the repo cannot push. */
  remotes: string[];
  /** Chosen target — initially the upstream, else the first remote + branch. */
  remote: string;
  remoteBranch: string;
  /** The branch has a configured upstream. */
  hasUpstream: boolean;
  /** The tracking ref for the chosen target exists locally (diff is exact). */
  targetExists: boolean;
  /** Branch names under `refs/remotes/<remote>` — the retarget field's completions. */
  remoteBranchOptions: string[];
  /** Left side of the file tree's diffs: the tracking ref, span parent or empty tree. */
  base: string;
  /** Outgoing commits, newest first, capped — `totalCommits` is the true count. */
  commits: PushCommitDto[];
  totalCommits: number;
  /** The changed-file set of the push (target..HEAD, or the whole span). */
  files: PushFileDto[];
  checked: boolean;
}

export interface PushDialogParamsDto {
  repos: PushRepoSectionDto[];
  tags: 'none' | 'all' | 'follow';
  runHooks: boolean;
  /** Render the dim "will run: git push …" line. */
  showCommandLine: boolean;
  /** `git push --force-if-includes` supported — the preview line must be exact. */
  forceIfIncludes: boolean;
  /** P11-T8 status color overrides for the file tree. */
  colors?: Record<string, string>;
}

export interface PushDialogResultDto {
  /** Checked repos only, each with its (possibly retargeted) destination. */
  repos: Array<{ root: string; remote: string; remoteBranch: string }>;
  tags: 'none' | 'all' | 'follow';
  runHooks: boolean;
  /** Force-with-lease path (the split button's `Force Push…`). */
  force: boolean;
}

export const PUSH_DIALOG_METHODS = {
  /**
   * webview → host request: recompute one repo's commits/files for an edited
   * target. Params `{root, remote, remoteBranch}`; returns the updated
   * `PushRepoSectionDto`.
   */
  retarget: 'pushDialog/retarget',
  /**
   * webview → host request: open the pane toolbar's diff for one file.
   * Params `{root, base, status, path, origPath?}`; returns `{ok: boolean}`.
   */
  openDiff: 'pushDialog/openDiff',
  /**
   * webview → host request: the toolbar's `Edit source` — open the worktree
   * file. Params `{root, path}`; returns `{ok: boolean}`.
   */
  openFile: 'pushDialog/openFile',
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
  side?: 'left' | 'right';
  graph: GraphRowDto;
}

export interface LogPageDto {
  page: number;
  rows: LogRowDto[];
  eof: boolean;
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
  /**
   * Set only on an `evtReset` the *host* raised because history moved (a
   * commit, checkout, rebase, pull…), never on one the user asked for. The
   * webview keeps its place across it — re-anchoring on the focused commit,
   * or on the row that was at the top when nothing was selected — instead of
   * clearing the panes and jumping to the newest commit.
   */
  preserve?: boolean;
}

export interface CommitFileDto {
  status: string;
  path: string;
  origPath?: string;
}

/**
 * P12-T3 — the Changed Files pane's data. One commit ships its own files;
 * a multi-select ships the aggregate (`git diff <oldest>^..<newest>`), with
 * `base`/`newest` so a file click can open the range-scoped diff.
 */
export interface LogChangedFilesDto {
  files: CommitFileDto[];
  newest?: string;
  /** Present only for aggregates: the diff base (oldest^ or the empty tree). */
  base?: string;
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
  locals: Array<{ name: string; favorite: boolean }>;
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

export const LOG_METHODS = {
  /** webview → host */
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
  /** P12-T8: the command ring grew or was cleared (throttled, payload-free). */
  evtConsole: 'log/consoleChanged',
  /** POST-P14k: a worktree was added/removed/locked, or a repo's refs moved (payload-free). */
  evtWorktrees: 'log/worktreesChanged',
  /** P10-T2: keyboard parity — move focus into the filter search box. */
  evtFocusFilter: 'log/focusFilter',
} as const;

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
// Branches sidebar (new-way-2)
// ---------------------------------------------------------------------------

/**
 * The rows the sidebar draws are the rows `popupTree` builds, imported rather
 * than mirrored — the same reason the dialog option shapes above are imported.
 * A hand-copied row type is a row type that drifts from the one that runs.
 */
export type BranchesRowDto = TreeRow;

export interface BranchesTreeDto {
  readonly rows: readonly BranchesRowDto[];
  /** Ids of the expandable rows currently showing their children. */
  readonly open: readonly string[];
  /** The top field's text, echoed so a rehydrated view restores it. */
  readonly topQuery: string;
  /** `[root, query]` for every repository whose inline field has text. */
  readonly repoQueries: ReadonlyArray<readonly [string, string]>;
  readonly repoCount: number;
  readonly showInOut: boolean;
}

export const BRANCHES_METHODS = {
  /** webview → host: the first paint. */
  init: 'branches/init',
  /** webview → host: open or close one node. */
  toggle: 'branches/toggle',
  /** webview → host: the top field changed. */
  setTopQuery: 'branches/setTopQuery',
  /** webview → host: one repository's inline field changed. */
  setRepoQuery: 'branches/setRepoQuery',
  /** webview → host: run a row's default gesture (a verb, or a ref's menu). */
  activate: 'branches/activate',
  /** webview → host: the action list for a row, for the `›` menu. */
  actions: 'branches/actions',
  /** webview → host: run one action from that list. */
  runAction: 'branches/runAction',
  /** webview → host: toggle a ref's favourite star. */
  toggleFavorite: 'branches/toggleFavorite',
  /** webview → host: a header button. */
  header: 'branches/header',
  /** host → webview: a new set of rows. */
  evtTree: 'branches/tree',
} as const;

/** One entry of the `›` menu, flattened from the shared branch-action registry. */
export interface BranchesActionDto {
  readonly id: string;
  readonly label: string;
  readonly accelerator?: string;
  /** Group boundary before this entry — the menu draws a rule. */
  readonly separator?: boolean;
}
