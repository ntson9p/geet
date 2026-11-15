/**
 * The Push dialog's rules, ported from IntelliJ's `GitPushSupport`,
 * `GitPushTarget`, `GitPushOperation`, `GitPushTargetPanel` and
 * `ForcePushAction`. vscode-free: the host builds the dialog from it and the
 * webview renders and edits targets with it, so the two can never disagree
 * about where a push goes.
 *
 * - **Source** — what is pushed: the branch (`main → …`), or for Push All up
 *   to Here the commit (`1393301c → …`), or a detached HEAD.
 * - **Target** — where: a remote and a branch on it, `New` when the remote has
 *   no such branch yet.
 */
import { isValidRefName } from '../../core/git/refName';
import type { PushDialogResultDto, PushRepoDto } from '../../shared/protocol';
import type { PushTagsMode } from './pushArgs';
import { pushSpecTargetRef } from './pushSpecParser';

export type PushSourceKind = 'branch' | 'revision' | 'detached';

export interface PushSource {
  readonly kind: PushSourceKind;
  /** Left of the arrow: the branch name, or the commit's short hash. */
  readonly presentation: string;
  /** What `git push` sends: `refs/heads/<branch>`, or a commit hash. */
  readonly revision: string;
  /**
   * The local branch behind it. For `revision`, the branch the commit is on —
   * IntelliJ's `GitPushSource.OnRevision` keeps it for the default target.
   */
  readonly branch?: string;
}

export type PushTargetType = 'tracking' | 'pushSpec' | 'custom';

export interface PushTargetSpec {
  readonly remote: string;
  /**
   * The branch on the remote, as `git push` names it: `main`, `feature/x` — or
   * a whole ref such as Gerrit's `refs/for/master`.
   */
  readonly branch: string;
  /** The remote has no such branch yet: the row says `New`. */
  readonly isNew: boolean;
  /** A push-spec ref outside `refs/heads/` (`refs/for/master`). */
  readonly special?: boolean;
  readonly type: PushTargetType;
}

/** IntelliJ's `DvcsUtil.getShortHash`: eight characters. */
export function shortHash(sha: string): string {
  return sha.slice(0, 8);
}

export function branchSource(branch: string): PushSource {
  return { kind: 'branch', presentation: branch, revision: `refs/heads/${branch}`, branch };
}

/**
 * Push All up to Here: the commit and everything before it. With `branch`,
 * the branch it was found on (`OnRevision`); without, a detached source.
 */
export function revisionSource(sha: string, branch?: string): PushSource {
  return branch !== undefined
    ? { kind: 'revision', presentation: shortHash(sha), revision: sha, branch }
    : { kind: 'detached', presentation: shortHash(sha), revision: sha };
}

/** IntelliJ's `getDefaultOrFirstRemote`: `origin` when there is one. */
export function defaultRemote(remotes: readonly string[]): string | undefined {
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

/** What a repository knows that the default target depends on. */
export interface TargetContext {
  /** `git remote`, in its order. */
  readonly remotes: readonly string[];
  /** Branch names under `refs/remotes/<remote>/`, per remote. */
  readonly remoteBranches: ReadonlyMap<string, ReadonlySet<string>>;
  /** The checked-out branch, if any. */
  readonly currentBranch?: string;
  /** The source branch's upstream, when it has one. */
  readonly tracking?: { readonly remote: string; readonly branch: string };
  /** `remote.<name>.push` per remote. */
  readonly pushSpecs?: ReadonlyMap<string, readonly string[]>;
}

function exists(ctx: TargetContext, remote: string, branch: string): boolean {
  return ctx.remoteBranches.get(remote)?.has(branch) === true;
}

/** `GitPushTarget.getFromPushSpec`: where the remote's push spec sends `branch`. */
function pushSpecTarget(ctx: TargetContext, branch: string): PushTargetSpec | undefined {
  const remote = ctx.tracking?.remote ?? defaultRemote(ctx.remotes);
  if (remote === undefined) return undefined;
  const specs = ctx.pushSpecs?.get(remote) ?? [];
  if (specs.length === 0) return undefined;
  const ref = pushSpecTargetRef(branch, specs);
  if (ref === undefined) return undefined;
  const heads = 'refs/heads/';
  const tracking = `refs/remotes/${remote}/`;
  const name = ref.startsWith(heads)
    ? ref.slice(heads.length)
    : ref.startsWith(tracking)
      ? ref.slice(tracking.length)
      : undefined;
  if (name === undefined) return { remote, branch: ref, isNew: true, special: true, type: 'pushSpec' };
  return { remote, branch: name, isNew: !exists(ctx, remote, name), type: 'pushSpec' };
}

/** `makeTargetForNewBranch`: `<remote> : <name>`, `New` unless it is already there. */
function sameNameTarget(ctx: TargetContext, remote: string, name: string): PushTargetSpec {
  return { remote, branch: name, isNew: !exists(ctx, remote, name), type: 'tracking' };
}

/**
 * IntelliJ's `UniqueNameGenerator`: `detached`, else `detached2`, `detached3`…
 * — the branch a detached HEAD is offered to become on the remote.
 */
export function uniqueDetachedName(taken: ReadonlySet<string>): string {
  if (!taken.has('detached')) return 'detached';
  for (let i = 2; ; i++) {
    const name = `detached${i}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * `GitPushSupport.getDefaultTarget`: the push spec's target, else the branch
 * it tracks, else a branch of its own name on `origin` (or the first remote).
 * `undefined` only when there is no remote at all — the row offers
 * `Define remote` instead.
 */
export function defaultPushTarget(
  source: PushSource,
  ctx: TargetContext,
): PushTargetSpec | undefined {
  if (source.branch !== undefined) {
    const spec = pushSpecTarget(ctx, source.branch);
    if (spec !== undefined) return spec;
    if (ctx.tracking !== undefined) {
      // IntelliJ trusts the upstream; one the remote has deleted is pushed as
      // the new branch it now is, rather than failing to list the commits.
      const { remote, branch } = ctx.tracking;
      return { remote, branch, isNew: !exists(ctx, remote, branch), type: 'tracking' };
    }
  }
  const remote = defaultRemote(ctx.remotes);
  if (remote === undefined) return undefined;
  if (source.branch !== undefined) return sameNameTarget(ctx, remote, source.branch);
  if (ctx.currentBranch !== undefined) return sameNameTarget(ctx, remote, ctx.currentBranch);
  return {
    remote,
    branch: uniqueDetachedName(ctx.remoteBranches.get(remote) ?? new Set()),
    isNew: true,
    type: 'tracking',
  };
}

/** `GitPushTarget.parse`: a target typed in the dialog. */
export function typedTarget(ctx: TargetContext, remote: string, branch: string): PushTargetSpec {
  return { remote, branch, isNew: !exists(ctx, remote, branch), type: 'custom' };
}

/** IntelliJ lists at most this many outgoing commits for a new branch; GitTree for any. */
export const MAX_OUTGOING_COMMITS = 1000;

/**
 * `GitOutgoingCommitsProvider`: the commits the push sends. To a branch the
 * remote has, `<tracking>..<source>`; to a new one, everything that remote has
 * nowhere.
 */
export function outgoingRange(source: PushSource, target: PushTargetSpec): string[] {
  return target.isNew
    ? [source.revision, '--not', `--remotes=${target.remote}`]
    : [`refs/remotes/${target.remote}/${target.branch}..${source.revision}`];
}

/** `<source>:refs/heads/<branch>` — a whole ref the target already is stays as it is. */
export function pushRefspec(source: PushSource, target: PushTargetSpec): string {
  const dst = target.branch.startsWith('refs/') ? target.branch : `refs/heads/${target.branch}`;
  return `${source.revision}:${dst}`;
}

/**
 * `GitPushTarget.shouldSetUpstream`: a branch pushed to a new remote branch
 * starts tracking it unless it already tracks something; `Set upstream`
 * (`explicit`) makes any target its upstream. Never for a commit pushed on
 * its own, nor for a special ref such as `refs/for/master`.
 */
export function setsUpstream(
  source: PushSource,
  target: PushTargetSpec,
  sourceTracks: boolean,
  explicit: boolean,
): boolean {
  if (source.kind !== 'branch' || target.special === true) return false;
  return (target.isNew && !sourceTracks) || explicit;
}

/**
 * The upstream `Set upstream` compares against, when the checkbox exists at
 * all: only for a branch whose default target is an existing branch — the one
 * it tracks, typically. `undefined` means no checkbox.
 */
export function upstreamCheckboxBase(
  source: PushSource,
  defaultTarget: PushTargetSpec | undefined,
): { remote: string; branch: string } | undefined {
  if (source.kind !== 'branch' || defaultTarget === undefined) return undefined;
  if (defaultTarget.type !== 'tracking' || defaultTarget.isNew) return undefined;
  return { remote: defaultTarget.remote, branch: defaultTarget.branch };
}

/** The checkbox shows while the typed target is valid and is not the upstream already. */
export function showsUpstreamCheckbox(
  base: { remote: string; branch: string } | undefined,
  remote: string,
  branch: string,
): boolean {
  return (
    base !== undefined &&
    isValidRefName(branch) &&
    !(base.remote === remote && base.branch === branch)
  );
}

export type TargetBadge = 'New' | 'Upstream' | 'New & Upstream';

/** The green label right of the target: `New`, `Upstream`, or both. */
export function targetBadge(
  target: PushTargetSpec,
  base: { remote: string; branch: string } | undefined,
  setUpstream: boolean,
): TargetBadge | undefined {
  const newUpstream =
    setUpstream && base !== undefined && !(base.remote === target.remote && base.branch === target.branch);
  if (target.isNew && newUpstream) return 'New & Upstream';
  if (target.isNew) return 'New';
  if (newUpstream) return 'Upstream';
  return undefined;
}

/** IntelliJ's default *Protected branches*. */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['master', 'main'];

/**
 * `GitSharedSettings.isBranchProtected`: a pattern matches the whole name, so
 * `master` protects `master` and not `my-master-copy`. A pattern that is not a
 * valid regular expression protects nothing.
 */
/** `origin/feature/x` → `feature/x`: the branch name the protected patterns describe. */
export function remoteBranchName(upstream: string): string {
  const slash = upstream.indexOf('/');
  return slash > 0 ? upstream.slice(slash + 1) : upstream;
}

export function isBranchProtected(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(branch);
    } catch {
      return false;
    }
  });
}

/** A force-push target, keyed as IntelliJ's *don't warn* list keys it. */
export interface ForceTarget {
  readonly remote: string;
  readonly branch: string;
}

export const forceTargetKey = (t: ForceTarget): string => `${t.remote}\u0000${t.branch}`;

export interface ForceConfirmation {
  readonly message: string;
  /** Present when every target asked about is this one: `Don't warn about this target`. */
  readonly target?: ForceTarget;
}

/**
 * `ForcePushAction.confirmForcePush`: nothing to ask when every target was
 * marked *don't warn*; else IntelliJ's warning, naming the target when it is
 * the only one left to ask about.
 */
export function forcePushConfirmation(
  targets: readonly ForceTarget[],
  silent: readonly ForceTarget[],
): ForceConfirmation | undefined {
  const quiet = new Set(silent.map(forceTargetKey));
  const ask = new Map<string, ForceTarget>();
  for (const t of targets) if (!quiet.has(forceTargetKey(t))) ask.set(forceTargetKey(t), t);
  if (ask.size === 0) return undefined;
  if (ask.size === 1) {
    const only = [...ask.values()][0]!;
    return {
      message: `You're going to force push to '${only.branch}'. It may overwrite commits at the remote. Are you sure you want to proceed?`,
      target: only,
    };
  }
  return {
    message:
      "You're going to force push. It may overwrite commits at the remote. Are you sure you want to proceed?",
  };
}

/** One remembered push: `sourceBranch` went to `remote : branch`. */
export interface RecentPushTarget {
  readonly sourceBranch: string;
  readonly remote: string;
  readonly branch: string;
}

/** `RECENT_PUSH_TARGETS_LIMIT`, per repository. */
export const RECENT_PUSH_TARGETS_LIMIT = 10;

/** `addRecentPushTarget`: to the front, once, at most ten. */
export function addRecentPushTarget(
  list: readonly RecentPushTarget[],
  entry: RecentPushTarget,
): RecentPushTarget[] {
  const same = (e: RecentPushTarget): boolean =>
    e.sourceBranch === entry.sourceBranch && e.remote === entry.remote && e.branch === entry.branch;
  return [entry, ...list.filter((e) => !same(e))].slice(0, RECENT_PUSH_TARGETS_LIMIT);
}

/**
 * Only a push somewhere other than where the branch goes anyway is worth
 * remembering, as IntelliJ's `GitPushOperation` decides: a source with a
 * branch, a target that is not a special ref and not the default one.
 */
export function remembersTarget(
  source: PushSource,
  target: PushTargetSpec,
  defaultTarget: PushTargetSpec | undefined,
): boolean {
  if (source.branch === undefined || target.special === true) return false;
  return !(
    defaultTarget !== undefined &&
    defaultTarget.remote === target.remote &&
    defaultTarget.branch === target.branch
  );
}

/** A suggestion for the target field. */
export interface TargetVariant {
  readonly name: string;
  /** Shown first, with IntelliJ's `recently pushed`. */
  readonly recent: boolean;
}

/**
 * `GitPushTargetCompletionProvider.getVariants`: the current remote's recent
 * targets first, most recent first, then every remote branch — `origin`'s,
 * then the other remotes' by name — once each.
 */
export function targetVariants(
  recent: readonly RecentPushTarget[],
  currentRemote: string,
  remoteBranches: ReadonlyArray<{ remote: string; branch: string }>,
): TargetVariant[] {
  const out: TargetVariant[] = [];
  const seen = new Set<string>();
  for (const r of recent) {
    if (r.remote !== currentRemote || seen.has(r.branch)) continue;
    seen.add(r.branch);
    out.push({ name: r.branch, recent: true });
  }
  const sorted = [...remoteBranches].sort((a, b) => {
    if (a.remote === b.remote) return a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0;
    if (a.remote === 'origin') return -1;
    if (b.remote === 'origin') return 1;
    return a.remote < b.remote ? -1 : 1;
  });
  for (const r of sorted) {
    if (seen.has(r.branch)) continue;
    seen.add(r.branch);
    out.push({ name: r.branch, recent: false });
  }
  return out;
}

/** `Push Commits to <repo>` for one repository, `Push Commits` for several. */
export function pushDialogTitle(labels: readonly string[]): string {
  return labels.length === 1 ? `Push Commits to ${labels[0]}` : 'Push Commits';
}

/**
 * `PushController.processRepositories`: which repositories start checked. In
 * a one-repository dialog, that one; otherwise the ones the caller named — or,
 * when it named none, the repository the user is in.
 */
export function initiallyChecked(
  root: string,
  dialog: { single: boolean; preselected: ReadonlySet<string>; current?: string },
): boolean {
  if (dialog.single || dialog.preselected.has(root)) return true;
  return dialog.preselected.size === 0 && dialog.current === root;
}

// ---- a Push without the dialog (POST-P14cn) ------------------------------------------

/**
 * Why a Push opens the dialog although `gittree.push.showDialog` is off: what
 * the dialog would push by default cannot go ahead, and only the dialog can
 * settle it. IntelliJ's Commit and Push opens its dialog the same way when it
 * cannot push (`GitPushAfterCommitDialog.shouldShow`: `!canPush`).
 */
export type PushDialogNeed =
  /** Several repositories, and nothing says which to push: none named, no editor's. */
  | { readonly kind: 'nothingChosen' }
  /** No commit yet, so nothing a push could send. */
  | { readonly kind: 'emptyRepository'; readonly repo: string }
  /** No remote: the dialog's `Define remote`. */
  | { readonly kind: 'noRemote'; readonly repo: string }
  /**
   * A commit on no branch (a detached HEAD, or Push All up to Here of such a
   * commit): the remote branch the dialog offers is a made-up name.
   */
  | { readonly kind: 'noBranch'; readonly repo: string; readonly commit: string }
  /** Its commits could not be listed, and the dialog would leave it unticked. */
  | { readonly kind: 'commitsUnlisted'; readonly repo: string };

/** What a Push without the dialog reads of a row the dialog would open with. */
export type PushRowFacts = Pick<PushRepoDto, 'root' | 'label' | 'source' | 'target' | 'error' | 'checked'>;

export type PushWithoutDialog =
  | { readonly kind: 'push'; readonly result: PushDialogResultDto }
  | { readonly kind: 'dialog'; readonly need: PushDialogNeed };

/**
 * A Push without the dialog: what the dialog would post had Push been pressed
 * the moment it opened. That is each repository it would open ticked, to the
 * target it would open with, and the footer as it would open: the tag mode last
 * used, `Run Git hooks` ticked, no force, no `Set upstream`. A branch that
 * tracks nothing goes to a new branch of its own name and tracks it from then
 * on: it is published.
 *
 * `asked` are the rows of the repositories the dialog would tick (in its
 * order), built as the dialog builds them. A row it would still leave unticked
 * is one whose commits could not be listed. The first of them that cannot be
 * pushed as it stands says why the dialog opens instead.
 */
export function pushWithoutDialog(asked: readonly PushRowFacts[], tags: PushTagsMode): PushWithoutDialog {
  if (asked.length === 0) return { kind: 'dialog', need: { kind: 'nothingChosen' } };
  const repos: PushDialogResultDto['repos'] = [];
  for (const row of asked) {
    if (row.error !== undefined) return { kind: 'dialog', need: { kind: 'emptyRepository', repo: row.label } };
    if (row.target === undefined) return { kind: 'dialog', need: { kind: 'noRemote', repo: row.label } };
    if (row.source.kind === 'detached') {
      return { kind: 'dialog', need: { kind: 'noBranch', repo: row.label, commit: row.source.presentation } };
    }
    if (!row.checked) return { kind: 'dialog', need: { kind: 'commitsUnlisted', repo: row.label } };
    repos.push({
      root: row.root,
      source: row.source,
      target: { remote: row.target.remote, branch: row.target.branch },
      setUpstream: false,
    });
  }
  return { kind: 'push', result: { repos, tags, runHooks: true, force: false } };
}
