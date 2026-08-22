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
}

export interface CommitGroupDto {
  /** Changelist id, or the sentinel for the Unversioned Files group. */
  id: string;
  name: string;
  comment?: string;
  isActive: boolean;
  isDefault: boolean;
  /**
   * False for Unversioned Files until P11-T3 makes untracked files tickable —
   * rendering an inert checkbox would be worse than rendering none.
   */
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
}

export const COMMIT_METHODS = {
  /** webview → host */
  init: 'commit/init',
  setChecked: 'commit/setChecked',
  setMessage: 'commit/setMessage',
  commit: 'commit/commit',
  toggleAmend: 'commit/toggleAmend',
  refresh: 'commit/refresh',
  openDiff: 'commit/openDiff',
  rollback: 'commit/rollback',
  shelve: 'commit/shelve',
  showOptions: 'commit/showOptions',
  showHistory: 'commit/showHistory',
  /** host → webview */
  evtState: 'commit/state',
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
}

export interface CommitFileDto {
  status: string;
  path: string;
  origPath?: string;
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
  /** host → webview events */
  evtRows: 'log/rows',
  evtReset: 'log/reset',
  evtReveal: 'log/reveal',
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
