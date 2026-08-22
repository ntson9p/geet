/**
 * Host ⇄ webview RPC protocol (master §8). Single source of truth compiled
 * into both the extension host and every webview bundle. No `any` (lint-
 * enforced). Every request must be idempotent or guarded — webviews reload
 * and re-send pending requests on rehydrate.
 */

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
  /** Repo the message box and buttons act on. */
  activeRepo?: string;
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
   * statuses fall back to the theme's gitDecoration variables in the webview.
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
  /** host → webview */
  evtState: 'commit/state',
  /** P11-T6: pushed whenever a shelf store or the show-unshelved toggle changes. */
  evtShelf: 'commit/shelf',
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

export interface LogInitDto {
  repoRoot: string;
  repoLabel: string;
  filter: LogFilterDto;
  laneWidth: number;
  /** P10-T2: graph palette variant (`gittree.log.graphPalette`). */
  graphPalette?: 'default' | 'colorBlind';
  /** P11-T8 palette overrides, same contract as `CommitStateDto.colors`. */
  colors?: Record<string, string>;
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
}

export interface LogBranchActionParamsDto {
  /** A `branchActions.ts` id, or 'new' (the rail's `+`, no ref needed). */
  action: string;
  name?: string;
  type?: 'local' | 'remote' | 'tag';
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
  refs: string[];
  body: string;
  files: CommitFileDto[];
}

export const LOG_METHODS = {
  /** webview → host */
  init: 'log/init',
  page: 'log/page',
  details: 'log/details',
  setFilter: 'log/setFilter',
  pickBranches: 'log/pickBranches',
  pickAuthors: 'log/pickAuthors',
  pickDates: 'log/pickDates',
  pickPaths: 'log/pickPaths',
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
  /** host → webview events */
  evtRows: 'log/rows',
  evtReset: 'log/reset',
  evtReveal: 'log/reveal',
  /** P12-T2: refs changed (branch created/deleted, favorite toggled…). */
  evtBranches: 'log/branchesChanged',
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
