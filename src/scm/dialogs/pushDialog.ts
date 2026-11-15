/**
 * Push dialog, host half — IntelliJ's `VcsPushDialog` (P13-T1; rebuilt on
 * IntelliJ's own layout and rules in POST-P14ao). It lists repositories, each
 * as `source → remote : branch` with its outgoing commits under it, and turns
 * the accepted result into real `git push` invocations through each
 * repository's operation queue.
 *
 * Every Push of GitTree opens it, as every Push of IntelliJ does: `Push…`
 * (Ctrl+Shift+K) for the workspace, a branch's `Push…` for that branch, `Push
 * All up to Here…` for a commit, and `Commit and Push…` once its commits land.
 * POST-P14cn: with `gittree.push.showDialog` off (its footer's `Don't show this
 * dialog again`) each of them pushes straight away instead, what the dialog
 * would push had Push been pressed at once, and the dialog opens only for a
 * push that cannot go ahead without it (`pushModel.pushWithoutDialog`).
 *
 * The rules — default target, refspec, upstream, protected branches — are the
 * vscode-free `pushModel.ts`, shared with the webview half
 * (`webview-ui/src/dialogs/Push.tsx`). Force keeps the P5 safety rule:
 * `--force-with-lease` (+ `--force-if-includes` when the git build has it),
 * never `--force`.
 *
 * All reads are local (`git remote`, local tracking refs, `log`) — the dialog
 * never talks to a remote until the user pushes, except to check the URL of a
 * remote being defined, as IntelliJ's Define Remote does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { writeSetting } from '../../ui/writeSetting';
import type { Core, RepoHandle } from '../../core/core';
import { isValidRefName } from '../../core/git/refName';
import { canonicalKey } from '../../core/repoDiscovery';
import { repoLabels, sortRootsByLabel } from '../../core/util/repoLabels';
import { makeRevUri } from '../../core/vdocs/revContentProvider';
import type { DiffEntry } from '../../diff/diffSession';
import { hasIdenticalSides } from '../../diff/navigationStep';
import { LogService } from '../../log/logService';
import { zipChanges } from '../../log/zipChanges';
import {
  PUSH_DIALOG_METHODS,
  type CommitDetailsDto,
  type CommitFileDto,
  type PushCommitDto,
  type PushDefineRemoteResultDto,
  type PushDialogParamsDto,
  type PushDialogResultDto,
  type PushDialogUiDto,
  type PushRepoDto,
  type PushRetargetDto,
} from '../../shared/protocol';
import { openDialog } from '../../ui/dialogHost';
import { statusColorOverrides } from '../../ui/statusColors';
import { buildPushArgs, splitUpstream } from './pushArgs';
import {
  addRecentPushTarget,
  branchSource,
  defaultPushTarget,
  DEFAULT_PROTECTED_BRANCHES,
  forceTargetKey,
  initiallyChecked,
  MAX_OUTGOING_COMMITS,
  outgoingRange,
  pushDialogTitle,
  pushRefspec,
  pushWithoutDialog,
  remembersTarget,
  revisionSource,
  setsUpstream,
  typedTarget,
  type ForceTarget,
  type PushDialogNeed,
  type PushSource,
  type PushTargetSpec,
  type PushWithoutDialog,
  type RecentPushTarget,
  type TargetContext,
} from './pushModel';
import type { PushTagsMode } from './pushArgs';
import { pushAndReport, pushOutcomeLine, type PushReportOptions, type PushTarget } from './pushRun';
import { showInfo } from '../../ui/notices';

export interface PushDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
  /**
   * POST-P14af: where Update Project's last Merge/Rebase answer is kept —
   * a rejected push asks the same question, defaulting to the same answer.
   * The dialog keeps its own memory here too: `Show Details`, the splitters,
   * the recent targets and the targets not to warn about.
   */
  state?: vscode.Memento;
}

/** What one dialog is opened for — IntelliJ's `VcsPushDialog` arguments. */
export interface PushDialogRequest {
  /** The repositories listed (IntelliJ's `allRepos`). */
  readonly repos: readonly RepoHandle[];
  /** Checked when the dialog opens. */
  readonly preselected: readonly RepoHandle[];
  /** The repository the user is in: checked when nothing was preselected, and selected first. */
  readonly current?: RepoHandle;
  /** What every row pushes. By default each repository's checked-out branch. */
  readonly source?:
    | { readonly kind: 'branch'; readonly branch: string }
    | { readonly kind: 'revision'; readonly sha: string; readonly branch?: string };
}

const UI_KEY = 'gittree.pushDialog.ui';
const RECENT_KEY = 'gittree.push.recentTargets';
const SILENT_FORCE_KEY = 'gittree.push.silentForceTargets';

const DEFAULT_UI: PushDialogUiDto = {
  showDetails: true,
  groupByDirectory: true,
  treeRatio: 0.5,
  detailsRatio: 0.67,
};

function uiOf(state: vscode.Memento | undefined): PushDialogUiDto {
  return { ...DEFAULT_UI, ...(state?.get<Partial<PushDialogUiDto>>(UI_KEY) ?? {}) };
}

function recentOf(state: vscode.Memento | undefined): Record<string, RecentPushTarget[]> {
  return state?.get<Record<string, RecentPushTarget[]>>(RECENT_KEY) ?? {};
}

function silentOf(state: vscode.Memento | undefined): ForceTarget[] {
  return state?.get<ForceTarget[]>(SILENT_FORCE_KEY) ?? [];
}

/** `gittree.protectedBranches`: IntelliJ's *Protected branches*. */
export function protectedBranches(): string[] {
  return vscode.workspace
    .getConfiguration('gittree')
    .get<string[]>('protectedBranches', [...DEFAULT_PROTECTED_BRANCHES]);
}

// ---- reading a repository ------------------------------------------------------

async function listRemotes(core: Core, repo: RepoHandle): Promise<string[]> {
  const res = await core.git.exec(repo.root, ['remote'], { structured: true, allowNonZeroExit: true });
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Branches under `refs/remotes/<remote>/`, per remote, `HEAD` left out. */
async function listRemoteBranches(
  core: Core,
  repo: RepoHandle,
  remotes: readonly string[],
): Promise<Map<string, Set<string>>> {
  const res = await core.git.exec(
    repo.root,
    ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
    { structured: true, allowNonZeroExit: true },
  );
  const out = new Map<string, Set<string>>(remotes.map((r) => [r, new Set<string>()]));
  // Longest first: a remote may be named like another's prefix (`team`, `team/fork`).
  const byLength = [...remotes].sort((a, b) => b.length - a.length);
  for (const line of res.stdout.split('\n')) {
    const ref = line.trim().replace(/^refs\/remotes\//, '');
    const remote = byLength.find((r) => ref.startsWith(`${r}/`));
    if (remote === undefined) continue;
    const branch = ref.slice(remote.length + 1);
    if (branch !== 'HEAD') out.get(remote)?.add(branch);
  }
  return out;
}

/** `remote.<name>.push`, per remote. */
async function listPushSpecs(core: Core, repo: RepoHandle): Promise<Map<string, string[]>> {
  const res = await core.git.exec(
    repo.root,
    ['config', '--get-regexp', '^remote\\..*\\.push$'],
    { structured: true, allowNonZeroExit: true },
  );
  const out = new Map<string, string[]>();
  for (const line of res.stdout.split('\n')) {
    const m = /^remote\.(.+)\.push\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const list = out.get(m[1]!) ?? [];
    list.push(m[2]!);
    out.set(m[1]!, list);
  }
  return out;
}

/** The upstream of `branch`, if it has one — gone or not. */
function trackingOf(
  repo: RepoHandle,
  branch: string | undefined,
  remotes: readonly string[],
): { remote: string; branch: string } | undefined {
  if (branch === undefined) return undefined;
  const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
  return ref?.upstream !== undefined ? splitUpstream(ref.upstream, remotes) : undefined;
}

async function targetContext(
  core: Core,
  repo: RepoHandle,
  source: PushSource,
): Promise<TargetContext> {
  const remotes = await listRemotes(core, repo);
  const [remoteBranches, pushSpecs] = await Promise.all([
    listRemoteBranches(core, repo, remotes),
    listPushSpecs(core, repo),
  ]);
  const snap = repo.model.snapshot;
  const tracking = trackingOf(repo, source.branch, remotes);
  return {
    remotes,
    remoteBranches,
    pushSpecs,
    ...(snap.headRef !== undefined && !snap.detached ? { currentBranch: snap.headRef } : {}),
    ...(tracking !== undefined ? { tracking } : {}),
  };
}

/** The row's source: what the dialog was asked to push, else the checked-out branch. */
function sourceFor(repo: RepoHandle, asked: PushDialogRequest['source']): PushSource | undefined {
  if (asked?.kind === 'branch') return branchSource(asked.branch);
  if (asked?.kind === 'revision') return revisionSource(asked.sha, asked.branch);
  const snap = repo.model.snapshot;
  if (snap.headRef !== undefined && !snap.detached) return branchSource(snap.headRef);
  if (snap.headSha !== undefined) return revisionSource(snap.headSha);
  return undefined;
}

/** git's message without its `fatal:`/`error:` prefixes — IntelliJ's `cleanupErrorPrefixes`. */
function cleanGitError(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^(fatal|error):\s*/i, '').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

async function outgoingCommits(
  core: Core,
  repo: RepoHandle,
  source: PushSource,
  target: PushTargetSpec,
): Promise<{ commits: PushCommitDto[]; loadError?: string }> {
  const res = await core.git.exec(
    repo.root,
    [
      'log',
      `--max-count=${MAX_OUTGOING_COMMITS}`,
      '--format=%H%x00%an%x00%ae%x00%at%x00%B%x1e',
      ...outgoingRange(source, target),
      '--',
    ],
    { structured: true, noOptionalLocks: true, allowNonZeroExit: true },
  );
  if (res.exitCode !== 0) return { commits: [], loadError: cleanGitError(res.stderr) };
  const commits: PushCommitDto[] = [];
  for (const record of res.stdout.split('\x1e')) {
    const fields = record.replace(/^\n/, '').split('\0');
    if (fields.length < 5) continue;
    const [sha, authorName, authorEmail, at] = fields;
    const body = fields.slice(4).join('\0').replace(/\n+$/, '');
    commits.push({
      sha: sha!,
      subject: body.split('\n', 1)[0] ?? '',
      body,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authorTime: Number(at ?? '0') || 0,
    });
  }
  return { commits };
}

/** IntelliJ's `isPrePushHookAvailable`: `Run Git hooks` appears only when there is one. */
async function hasPrePushHook(core: Core, repo: RepoHandle): Promise<boolean> {
  const res = await core.git.exec(repo.root, ['rev-parse', '--git-path', 'hooks/pre-push'], {
    structured: true,
    allowNonZeroExit: true,
  });
  const rel = res.stdout.trim();
  return res.exitCode === 0 && rel.length > 0 && fs.existsSync(path.resolve(repo.root, rel));
}

function remoteBranchList(ctx: TargetContext): Array<{ remote: string; branch: string }> {
  const out: Array<{ remote: string; branch: string }> = [];
  for (const [remote, branches] of ctx.remoteBranches) {
    for (const branch of branches) out.push({ remote, branch });
  }
  return out;
}

async function buildRepoRow(
  deps: PushDialogDeps,
  repo: RepoHandle,
  source: PushSource,
  label: string,
  checked: boolean,
  single: boolean,
): Promise<PushRepoDto> {
  const ctx = await targetContext(deps.core, repo, source);
  const target = defaultPushTarget(source, ctx);
  const fresh = repo.model.snapshot.initial;
  const loaded =
    target !== undefined && !fresh
      ? await outgoingCommits(deps.core, repo, source, target)
      : { commits: [] };
  const recent =
    source.branch !== undefined
      ? (recentOf(deps.state)[canonicalKey(repo.root)] ?? []).filter(
          (r) => r.sourceBranch === source.branch,
        )
      : [];
  return {
    root: repo.root,
    label,
    source,
    remotes: [...ctx.remotes],
    ...(target !== undefined ? { target, defaultTarget: target } : {}),
    sourceTracks: ctx.tracking !== undefined,
    ...(fresh ? { error: 'Empty repository' } : {}),
    ...(loaded.loadError !== undefined ? { loadError: loaded.loadError } : {}),
    commits: loaded.commits,
    remoteBranches: remoteBranchList(ctx),
    recentTargets: recent,
    // A repository whose commits could not be listed is not pushed by
    // default — except the only one, which has no checkbox to untick.
    checked: checked && (single || loaded.loadError === undefined),
  };
}

/** Each listed repository's source, kept for the handlers of the open dialog. */
export type PushSources = Map<string, PushSource>;

/**
 * The repositories a dialog for `request` lists, in its order, each with what
 * it pushes (one with nothing to push from is left out), and which of them it
 * opens ticked. The dialog and a Push without it read the same answer.
 */
interface DialogRows {
  readonly rows: ReadonlyArray<{ readonly repo: RepoHandle; readonly source: PushSource }>;
  readonly single: boolean;
  readonly ticked: (repo: RepoHandle) => boolean;
}

function dialogRows(request: PushDialogRequest): DialogRows {
  const byRoot = new Map(request.repos.map((r) => [r.root, r]));
  const ordered = sortRootsByLabel(request.repos.map((r) => r.root))
    .map((root) => byRoot.get(root))
    .filter((r): r is RepoHandle => r !== undefined);
  const rows = ordered.flatMap((repo) => {
    const source = sourceFor(repo, request.source);
    return source !== undefined ? [{ repo, source }] : [];
  });
  const single = rows.length === 1;
  const preselected = new Set(request.preselected.map((r) => r.root));
  const current = request.current?.root;
  return {
    rows,
    single,
    ticked: (repo) =>
      initiallyChecked(repo.root, {
        single,
        preselected,
        ...(current !== undefined ? { current } : {}),
      }),
  };
}

/** `gittree.push.tags`, the tag mode the last push used: what the footer opens with. */
function tagsSetting(): PushTagsMode {
  const value = vscode.workspace.getConfiguration('gittree').get<string>('push.tags', 'none');
  return value === 'all' || value === 'follow' ? value : 'none';
}

/** `because`: why a Push that was to go straight away opened the dialog instead (POST-P14cn). */
export async function buildPushParams(
  deps: PushDialogDeps,
  request: PushDialogRequest,
  sources: PushSources = new Map(),
  because?: string,
): Promise<PushDialogParamsDto> {
  const { core } = deps;
  const cfg = vscode.workspace.getConfiguration('gittree');
  const labels = repoLabels(core.repos.map((r) => r.root));
  const { rows: withSource, single, ticked } = dialogRows(request);
  const preselected = new Set(request.preselected.map((r) => r.root));
  const current = request.current?.root;
  const rows = await Promise.all(
    withSource.map(({ repo, source }) => {
      sources.set(canonicalKey(repo.root), source);
      return buildRepoRow(
        deps,
        repo,
        source,
        labels.get(repo.root) ?? path.basename(repo.root),
        ticked(repo),
        single,
      );
    }),
  );
  const hooks = await Promise.all(withSource.map(({ repo }) => hasPrePushHook(core, repo)));
  // IntelliJ selects the current repository's row first when nobody named
  // any; otherwise the dialog selects the first checked row with commits.
  const highlight =
    preselected.size === 0 ? (rows.find((r) => r.root === current) ?? rows[0])?.root : undefined;
  const issue = issueConfig();
  return {
    title: pushDialogTitle(rows.map((r) => r.label)),
    repos: rows,
    single,
    ...(highlight !== undefined ? { highlight } : {}),
    tags: tagsSetting(),
    showRunHooks: hooks.some((h) => h),
    showCommandLine: cfg.get<boolean>('dialogs.showCommandLine', true),
    forceIfIncludes: core.git.caps.forceIfIncludes,
    protectedBranches: protectedBranches(),
    silentForceTargets: silentOf(deps.state),
    ui: uiOf(deps.state),
    colors: statusColorOverrides(),
    ...(issue !== undefined ? { issue } : {}),
    dontShowAgain: !isPushDialogOn(),
    ...(because !== undefined ? { openedBecause: because } : {}),
  };
}

/**
 * POST-P14cn: a Push with `gittree.push.showDialog` off. What the dialog would
 * push had Push been pressed the moment it opened (`pushWithoutDialog`), read
 * as the dialog reads it, for the repositories it would tick and no others.
 * `undefined` when there is no repository to push at all.
 */
export async function planPushWithoutDialog(
  deps: PushDialogDeps,
  request: PushDialogRequest,
): Promise<PushWithoutDialog | undefined> {
  const { rows, single, ticked } = dialogRows(request);
  if (rows.length === 0) return undefined;
  const labels = repoLabels(deps.core.repos.map((r) => r.root));
  const asked = await Promise.all(
    rows
      .filter(({ repo }) => ticked(repo))
      .map(({ repo, source }) =>
        buildRepoRow(deps, repo, source, labels.get(repo.root) ?? path.basename(repo.root), true, single),
      ),
  );
  return pushWithoutDialog(asked, tagsSetting());
}

/** What the dialog says at its top when it opened for a Push that was to go straight away. */
export function pushDialogNeedText(need: PushDialogNeed): string {
  switch (need.kind) {
    case 'nothingChosen':
      return vscode.l10n.t('Shown because nothing said which repository to push: tick the ones to push.');
    case 'emptyRepository':
      return vscode.l10n.t('Shown because {0} has no commits yet.', need.repo);
    case 'noRemote':
      return vscode.l10n.t('Shown because {0} has no remote to push to.', need.repo);
    case 'noBranch':
      return vscode.l10n.t(
        'Shown because {0} in {1} is on no branch: say which branch it goes to.',
        need.commit,
        need.repo,
      );
    case 'commitsUnlisted':
      return vscode.l10n.t('Shown because the commits {0} would push could not be listed.', need.repo);
  }
}

/** The log's issue-link configuration, so a commit's details read the same here. */
function issueConfig(): { pattern: string; url: string } | undefined {
  const config = vscode.workspace.getConfiguration('gittree.log');
  const pattern = config.get<string>('issuePattern', '').trim();
  const url = config.get<string>('issueUrl', '').trim();
  if (pattern.length === 0 || url.length === 0) return undefined;
  try {
    new RegExp(pattern, 'g');
  } catch {
    return undefined;
  }
  return { pattern, url };
}

// ---- the dialog's requests -------------------------------------------------------

/**
 * `Show Diff`: the files of the pane in one diff sequence, opened at the one
 * asked for. An added or a deleted file is a stop like any other: the side it
 * lacks reads as empty.
 */
async function openDiffs(
  deps: PushDialogDeps,
  repoRoot: string,
  files: readonly CommitFileDto[],
  index: number,
): Promise<void> {
  const file = files[index];
  if (!file) return;
  const before = (f: CommitFileDto): string => f.before ?? 'HEAD';
  const after = (f: CommitFileDto): string => f.after ?? 'HEAD';
  const short = (rev: string): string => (rev.endsWith('^') ? `${rev.slice(0, 7)}^` : rev.slice(0, 7));
  const entries: DiffEntry[] = files.map((f) => ({
    original: makeRevUri(repoRoot, f.origPath ?? f.path, before(f)),
    modified: makeRevUri(repoRoot, f.path, after(f)),
    title: `${path.posix.basename(f.path)} (${short(before(f))}..${short(after(f))})`,
    label: f.path,
    identical: hasIdenticalSides(f.status),
  }));
  const at = index;
  const p14 = deps.core.debugRegistry.get('phase14') as
    | { sessions: { open(entries: readonly DiffEntry[], index: number): Promise<void> } }
    | undefined;
  if (p14) {
    await p14.sessions.open(entries, at);
    return;
  }
  const entry = entries[at];
  if (entry) await vscode.commands.executeCommand('vscode.diff', entry.original, entry.modified, entry.title);
}

function toDetailsDto(d: NonNullable<Awaited<ReturnType<LogService['getCommitDetails']>>>): CommitDetailsDto {
  return {
    ...d,
    files: d.files.map((f) => ({
      status: f.status,
      path: f.path,
      ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
    })),
  };
}

/** IntelliJ's Define Remote checks, in its order and words. */
function remoteNameProblem(name: string, taken: readonly string[]): string | undefined {
  if (name.length === 0) return 'Remote name cannot be empty';
  if (!isValidRefName(name)) return 'Remote name contains illegal characters';
  if (taken.includes(name)) return `Remote name '${name}' is already used`;
  return undefined;
}

async function defineRemote(
  deps: PushDialogDeps,
  repo: RepoHandle,
  source: PushSource,
  p: { name: string; url: string; fetch: boolean },
): Promise<PushDefineRemoteResultDto> {
  const { core } = deps;
  const name = p.name.trim();
  const url = p.url.trim();
  const nameProblem = remoteNameProblem(name, await listRemotes(core, repo));
  if (nameProblem !== undefined) return { ok: false, field: 'name', message: nameProblem };
  if (url.length === 0) return { ok: false, field: 'url', message: 'Remote URL cannot be empty' };
  // IntelliJ checks the URL answers before adding anything.
  const probe = await core.git.exec(repo.root, ['ls-remote', '--', url], { allowNonZeroExit: true });
  if (probe.exitCode !== 0) {
    return { ok: false, field: 'url', message: cleanGitError(probe.stderr) || `Cannot reach ${url}` };
  }
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Add remote {0}', name),
      kind: 'mutate',
      run: async (git, token) => {
        await git.exec(repo.root, ['remote', 'add', name, url], { token });
      },
    });
    if (p.fetch) {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Fetch {0}', name),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, ['fetch', name], { token });
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, field: 'url', message: `Could not add remote: ${cleanGitError(message)}` };
  }
  await repo.refresher.refreshNow();
  const label = repoLabels(core.repos.map((r) => r.root)).get(repo.root) ?? path.basename(repo.root);
  return { ok: true, repo: await buildRepoRow(deps, repo, source, label, true, true) };
}

/**
 * The dialog's request handlers, built here so integration tests can exercise
 * them without a panel — the P11-T3 lesson that a missing handler fails in
 * total silence is why the whole surface is asserted. `sources` are the open
 * dialog's rows; a repository not among them pushes its checked-out branch.
 */
export function pushDialogHandlers(
  deps: PushDialogDeps,
  sources: PushSources = new Map(),
): Record<string, (params: unknown) => unknown> {
  const repoFor = (root: string): RepoHandle | undefined =>
    // Canonical-key resolution with NO fallback — the P12-T2 lesson.
    deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
  const sourceOf = (repo: RepoHandle): PushSource | undefined =>
    sources.get(canonicalKey(repo.root)) ?? sourceFor(repo, undefined);
  return {
    [PUSH_DIALOG_METHODS.retarget]: async (raw): Promise<PushRetargetDto | undefined> => {
      const p = raw as { root: string; remote: string; branch: string };
      const repo = repoFor(p.root);
      const source = repo !== undefined ? sourceOf(repo) : undefined;
      if (!repo || !source) return undefined;
      const ctx = await targetContext(deps.core, repo, source);
      const target = typedTarget(ctx, p.remote, p.branch);
      const loaded = await outgoingCommits(deps.core, repo, source, target);
      return { target, ...loaded };
    },
    [PUSH_DIALOG_METHODS.changes]: async (raw): Promise<{ files: CommitFileDto[] }> => {
      const p = raw as { root: string; shas: string[] };
      const repo = repoFor(p.root);
      if (!repo || p.shas.length === 0) return { files: [] };
      const perCommit = await new LogService(repo).getCommitsFiles(p.shas);
      return {
        files: zipChanges(perCommit).map((f) => ({
          status: f.status,
          path: f.path,
          ...(f.origPath !== undefined ? { origPath: f.origPath } : {}),
          ...(f.before !== undefined ? { before: f.before } : {}),
          ...(f.after !== undefined ? { after: f.after } : {}),
        })),
      };
    },
    [PUSH_DIALOG_METHODS.details]: async (raw): Promise<CommitDetailsDto | undefined> => {
      const p = raw as { root: string; sha: string };
      const repo = repoFor(p.root);
      if (!repo) return undefined;
      const details = await new LogService(repo).getCommitDetails(p.sha);
      return details ? toDetailsDto(details) : undefined;
    },
    [PUSH_DIALOG_METHODS.openDiff]: async (raw): Promise<{ ok: boolean }> => {
      const p = raw as { root: string; files: CommitFileDto[]; index: number };
      const repo = repoFor(p.root);
      if (!repo) return { ok: false };
      await openDiffs(deps, repo.root, p.files, p.index);
      return { ok: true };
    },
    [PUSH_DIALOG_METHODS.openFile]: async (raw): Promise<{ ok: boolean }> => {
      const p = raw as { root: string; path: string };
      const repo = repoFor(p.root);
      if (!repo) return { ok: false };
      const uri = vscode.Uri.file(path.join(repo.root, p.path));
      try {
        await vscode.window.showTextDocument(uri, { preview: true });
        return { ok: true };
      } catch {
        // Deleted by the push's own commits — nothing to edit.
        return { ok: false };
      }
    },
    [PUSH_DIALOG_METHODS.defineRemote]: async (raw): Promise<PushDefineRemoteResultDto> => {
      const p = raw as { root: string; name: string; url: string; fetch: boolean };
      const repo = repoFor(p.root);
      const source = repo !== undefined ? sourceOf(repo) : undefined;
      if (!repo || !source) return { ok: false, field: 'url', message: 'Repository not found' };
      return defineRemote(deps, repo, source, p);
    },
    [PUSH_DIALOG_METHODS.saveUi]: async (raw): Promise<void> => {
      const p = raw as Partial<PushDialogUiDto>;
      await deps.state?.update(UI_KEY, { ...uiOf(deps.state), ...p });
    },
  };
}

// ---- pushing -----------------------------------------------------------------------

/**
 * The accept half, separated so integration tests drive it with exactly the
 * payload the webview posts (the dialog UI itself is Playwright-covered).
 * Force Push was confirmed in the dialog already. Returns the per-repo
 * outcome lines, for tests; the user gets one notification (POST-P14af:
 * `pushRun.ts`, which also answers a rejected push with IntelliJ's Merge /
 * Rebase question). A Push without the dialog (POST-P14cn) comes through here
 * too, with the payload the dialog would have posted, and `options` as a push
 * of the branch to its upstream reports.
 */
export async function applyPushResult(
  deps: PushDialogDeps,
  result: PushDialogResultDto,
  options: PushReportOptions = {},
): Promise<string[]> {
  const { core } = deps;
  const outcomes: string[] = [];
  const plan: PushTarget[] = [];
  const remembered: Array<{ repo: RepoHandle; entry: RecentPushTarget }> = [];

  // `Don't show this dialog again`, as IntelliJ keeps its checkbox: on Push,
  // not on Cancel, and before the push runs.
  if (result.dontShowAgain !== undefined && result.dontShowAgain === isPushDialogOn()) {
    await setPushDialogOn(!result.dontShowAgain);
    showInfo(
      result.dontShowAgain
        ? vscode.l10n.t(
            'Push now pushes straight away, without the Push dialog. To see it again, turn on the setting gittree.push.showDialog.',
          )
        : vscode.l10n.t('The Push dialog opens for every push again.'),
    );
  }

  for (const row of result.repos) {
    // Canonical-key resolution with NO fallback — the P12-T2 lesson.
    const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(row.root));
    if (!repo) {
      outcomes.push(`${row.root}: repository not found`);
      continue;
    }
    const source = row.source;
    const ctx = await targetContext(core, repo, source);
    const fallback = defaultPushTarget(source, ctx);
    // The default keeps what only it knows (a push spec's special ref);
    // anything else is a target typed in the dialog.
    const target =
      fallback !== undefined &&
      fallback.remote === row.target.remote &&
      fallback.branch === row.target.branch
        ? fallback
        : typedTarget(ctx, row.target.remote, row.target.branch);
    plan.push({
      repo,
      branch: source.branch ?? source.presentation,
      ...(source.kind !== 'branch' ? { source: source.revision } : {}),
      remote: target.remote,
      remoteBranch: target.branch,
      args: buildPushArgs({
        remote: target.remote,
        refspec: pushRefspec(source, target),
        setUpstream: setsUpstream(source, target, ctx.tracking !== undefined, row.setUpstream),
        tags: result.tags,
        runHooks: result.runHooks,
        force: result.force,
        forceIfIncludes: result.force && core.git.caps.forceIfIncludes,
      }),
    });
    if (source.branch !== undefined && remembersTarget(source, target, fallback)) {
      remembered.push({
        repo,
        entry: { sourceBranch: source.branch, remote: target.remote, branch: target.branch },
      });
    }
  }

  if (result.dontWarnForce !== undefined) {
    const silent = silentOf(deps.state);
    const key = forceTargetKey(result.dontWarnForce);
    if (!silent.some((t) => forceTargetKey(t) === key)) {
      await deps.state?.update(SILENT_FORCE_KEY, [...silent, result.dontWarnForce]);
    }
  }

  const results = await pushAndReport(deps, plan, options);
  // IntelliJ remembers a target once the push to it went through.
  let recent = recentOf(deps.state);
  for (const r of results) {
    if (r.kind !== 'pushed') continue;
    const hit = remembered.find((m) => m.repo === r.target.repo);
    if (!hit) continue;
    const key = canonicalKey(hit.repo.root);
    recent = { ...recent, [key]: addRecentPushTarget(recent[key] ?? [], hit.entry) };
  }
  if (remembered.length > 0) await deps.state?.update(RECENT_KEY, recent);
  outcomes.push(...results.map(pushOutcomeLine));
  return outcomes;
}

/**
 * POST-P14cn: every Push opens this dialog, the default. Off (the footer's
 * `Don't show this dialog again`), every Push pushes straight away, Commit and
 * Push included, and the dialog opens only for a push that needs it.
 */
const SHOW_DIALOG = 'push.showDialog';

export function isPushDialogOn(): boolean {
  return vscode.workspace.getConfiguration('gittree').get<boolean>(SHOW_DIALOG, true);
}

/** What the checkbox writes; also a test seam, where `undefined` puts the default back. */
export async function setPushDialogOn(value: boolean | undefined): Promise<void> {
  await writeSetting('gittree', SHOW_DIALOG, value);
}

/**
 * IntelliJ's *Show Push dialog for Commit and Push* (POST-P14ah), on by
 * default as it is there: `Commit and Push…` opens this dialog for the
 * repositories it just committed. Off, it pushes them straight away. It counts
 * only while `gittree.push.showDialog` is on: off, no Push opens the dialog.
 */
const SHOW_FOR_COMMIT_AND_PUSH = 'push.showDialogForCommitAndPush';

export function showPushDialogForCommitAndPush(): boolean {
  return vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>(SHOW_FOR_COMMIT_AND_PUSH, true);
}

/** Test seam; `undefined` puts the default back. */
export async function setShowPushDialogForCommitAndPush(value: boolean | undefined): Promise<void> {
  await writeSetting('gittree', SHOW_FOR_COMMIT_AND_PUSH, value);
}

/** What the dialog was last opened for, as a test reads it. */
export interface PushDialogOpened {
  readonly repos: readonly string[];
  readonly preselected: readonly string[];
  readonly source?: PushDialogRequest['source'];
  /** Why a Push that was to go straight away opened it instead (POST-P14cn). */
  readonly because?: string;
}

let lastRequest: PushDialogOpened | undefined;

/** Test seam: the repositories the dialog was last opened for — the ones it checked. */
export function lastPushDialogRequest(): readonly string[] | undefined {
  return lastRequest?.preselected;
}

/** Test seam: the whole of the last request — every listed repository, and the source. */
export function lastPushDialogOpened(): PushDialogOpened | undefined {
  return lastRequest;
}

/** Test seam: forget it, so a test can prove the dialog was not opened. */
export function clearLastPushDialogRequest(): void {
  lastRequest = undefined;
}

/**
 * Opens the dialog; resolves true when at least one push ran. `because`: why
 * a Push that was to go straight away opens it instead, said at its top.
 */
export async function showPushDialog(
  deps: PushDialogDeps,
  request: PushDialogRequest,
  because?: string,
): Promise<boolean> {
  lastRequest = {
    repos: request.repos.map((r) => r.root),
    preselected: (request.preselected.length > 0
      ? request.preselected
      : request.current !== undefined
        ? [request.current]
        : request.repos.length === 1
          ? request.repos
          : []
    ).map((r) => r.root),
    ...(request.source !== undefined ? { source: request.source } : {}),
    ...(because !== undefined ? { because } : {}),
  };
  // A webview dialog cannot be answered from an integration test:
  // `GITTREE_TEST_PUSH_DIALOG=cancel` closes it unanswered, as Escape would,
  // after recording what it was opened for. Read before the first await: a
  // caller that does not wait for the dialog (Commit and Push) has moved on
  // by then, and a test restores the seam as soon as its command returns.
  const cancelledByTest = process.env['GITTREE_TEST_PUSH_DIALOG'] === 'cancel';
  const sources: PushSources = new Map();
  const params = await buildPushParams(deps, request, sources, because);
  if (params.repos.length === 0) {
    showInfo(vscode.l10n.t('There is no repository to push.'));
    return false;
  }
  if (cancelledByTest) return false;
  const result = await openDialog<PushDialogParamsDto, PushDialogResultDto>({
    app: 'dialogs',
    dialog: 'push',
    title: params.title,
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: pushDialogHandlers(deps, sources),
  });
  if (!result || result.repos.length === 0) return false;

  // IntelliJ remembers the tag mode of the last push; `Run Git hooks` starts
  // ticked every time. Written only when it changes, and never into the
  // repository: every push used to leave `.vscode/settings.json` behind (POST-QA).
  await writeSetting('gittree', 'push.tags', result.tags);

  // `applyPushResult` reports; a second summary here would say it all twice.
  const outcomes = await applyPushResult(deps, result);
  return outcomes.length > 0;
}
