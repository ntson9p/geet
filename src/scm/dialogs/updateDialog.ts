/**
 * Update Project, host half (P13-T2, gap analysis S4 · §2A "Update Project
 * dialog"): the Merge / Rebase question, the `Don't Ask Again` shortcut that
 * turns Ctrl+T into a direct action, `Reset to the Remote Branch` behind a
 * destructive confirmation and a P9 snapshot, and the result notification that
 * stands in for IntelliJ's `Update Info` tab (deviation D9).
 *
 * POST-P14ab: the question is a native modal message box rather than a
 * webview dialog in an editor tab (D30). A whole editor tab for two radio
 * buttons read as a stray page; the message box is modal and centred the way
 * IntelliJ's dialog is, and a two-way choice is what a pair of buttons is for.
 *
 * Every command comes from the vscode-free `updateArgs.ts`, so the question's
 * command lines and the execution cannot drift apart.
 *
 * POST-P14aw: it fetches before it asks. The question can then say what each
 * repository will pull — it used to read the last fetch's `0 behind` and pull
 * commits anyway — and is not asked at all when nothing is coming in. Across
 * a project the run no longer stops at the first repository that fails: each
 * one's update is its own merge in its own repository, as IntelliJ's are, and
 * one summary (`updateReport.ts`) says what became of every one of them.
 *
 * POST-P14bm: Update Project Without Fetching skips the fetch and updates
 * from each remote branch as it was last fetched — instant, and offline. The
 * question says how old that is (`· fetched 2 hours ago`, from `FETCH_HEAD`),
 * a repository whose upstream was never fetched is skipped, and an Update
 * Project whose fetch fails offers it on the failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitsCount, filesCount } from '../../ui/counts';
import { writeSetting } from '../../ui/writeSetting';
import type { Core, RepoHandle } from '../../core/core';
import { describeGitFailure, GitError } from '../../core/git/errors';
import { parseStatusV2 } from '../../core/git/parsers/statusV2';
import { detectInProgressOp } from '../../core/model/inProgressOp';
import { repoBusyReason } from '../../core/model/repoBusy';
import { canonicalKey } from '../../core/repoDiscovery';
import { repoLabels } from '../../core/util/repoLabels';
import { SNAPSHOT_LABELS } from '../../localHistory/hooks';
import type { CancelToken, GitExecutor } from '../../core/git/executor';
import { anyToken } from '../../core/util/cancellation';
import { parseRangeCounts } from '../../log/logFilter';
import { confirmModal } from '../../ui/confirm';
import { notifySuccess, notifyWarning, type NotificationAction } from '../../ui/notify';
import { beginOperationProgress, type OperationProgress } from '../../ui/progress';
import { runFetchAll } from '../fetchAll';
import { splitUpstream } from './pushArgs';
import {
  buildDetachArgs,
  buildIntegrateArgs,
  buildReattachArgs,
  buildResetToRemoteArgs,
  buildUpdateFetchArgs,
  buildUpdateQuestion,
  hasStashableChanges,
  normalizeStrategySetting,
  planSetAside,
  updateChoices,
  type UpdateChoice,
  type UpdateStrategy,
  type UpdateStrategySetting,
} from './updateArgs';
import {
  conflictsPhrase,
  fetchedAgo,
  standing,
  standingAsFetched,
  summarizeProjectUpdate,
  updateTitle,
  type RepoUpdateResult,
  type UpdateCovers,
} from './updateReport';
import { showInfo } from '../../ui/notices';

export interface UpdateDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
  /**
   * Where the last Merge/Rebase answer is kept. Workspace *state*, not a
   * setting: it changes on every answer, and writing a setting that often
   * would keep rewriting `.vscode/settings.json` — a file many repositories
   * track. IntelliJ keeps its equivalent in `workspace.xml` for the same
   * reason. Optional so a caller without one still gets IntelliJ's default.
   */
  state?: vscode.Memento;
}

/** What Update Project is asked to do — the question's answer, as data. */
export interface UpdateRequest {
  action: 'update' | 'reset';
  strategy: UpdateStrategy;
}

const LAST_STRATEGY_KEY = 'gittree.update.lastStrategy';

/** POST-P14bm: Update Project Without Fetching — with a root, that repository; without, the project. */
export const UPDATE_WITHOUT_FETCH_COMMAND = 'gittree.update.withoutFetch';

/**
 * POST-P14bx: Update Repository… and its Without Fetching — one repository's
 * update, as its own menu and button name it; with no repository named, which
 * one is asked.
 */
export const UPDATE_REPOSITORY_COMMAND = 'gittree.update.repository';
export const UPDATE_REPOSITORY_WITHOUT_FETCH_COMMAND = 'gittree.update.repositoryWithoutFetch';

/** What the update actually did — returned so integration tests can assert it. */
export interface UpdateOutcome {
  ok: boolean;
  /** Commits the fetch brought in (upstream before → upstream after). */
  commitsPulled: number;
  filesChanged: number;
  /** Upstream sha before the fetch; the "Show in Log" range's left side. */
  from: string;
  to: string;
  message: string;
  /**
   * POST-P14ac: files left conflicted when git put the user's own changes
   * back after the update. git calls that success (exit 0, "Your changes are
   * safe in the stash"), so it has to be counted to be reported at all.
   */
  restoreConflicts?: number;
  /**
   * POST-P14af: the merge or rebase itself stopped on conflicts and is still
   * in progress — as opposed to one git refused to start. A push waiting on
   * this update is cancelled with IntelliJ's "conflicts during the update".
   */
  conflicts?: boolean;
  /** POST-P14aw: the files it stopped on, when `conflicts`. */
  conflictFiles?: string[];
  /** POST-P14aw: it got no further than a fetch that failed — from where, and why. */
  fetchFailed?: { readonly remote?: string; readonly reason: string };
}

/** Structural slice of phase06's conflict lifecycle — imported by shape, not module. */
interface ConflictLifecycleShape {
  lifecycle?: {
    expectConflict(repoRoot: string, source: 'stash-pop'): void;
    holdNotices?(repoRoot: string): vscode.Disposable;
  };
}

/**
 * Holds back the conflict lifecycle's own toast for `repos` until disposed:
 * the update names the conflicts in its result, with the same Show Conflicts.
 */
function holdConflictNotices(core: Core, repos: readonly RepoHandle[]): vscode.Disposable {
  const lifecycle = (core.debugRegistry.get('phase06') as ConflictLifecycleShape | undefined)?.lifecycle;
  const holds: vscode.Disposable[] = [];
  for (const repo of repos) {
    const hold = lifecycle?.holdNotices?.(repo.root);
    if (hold !== undefined) holds.push(hold);
  }
  return vscode.Disposable.from(...holds);
}

function readSetting(): UpdateStrategySetting {
  return normalizeStrategySetting(
    vscode.workspace.getConfiguration('gittree').get<string>('update.strategy', 'ask'),
  );
}

/**
 * The strategy an update uses when nobody is asked: the setting when it names
 * one, else the last answer to the question, else Merge — IntelliJ's default.
 *
 * IntelliJ keeps two things apart here and GitTree used to fold them into one
 * setting: *which* strategy (saved on every OK) and *whether to ask* (`Don't
 * show again`). Keeping the answer even while the question is still asked is
 * what lets an update that asks nothing — a branch row's `Update` — do what
 * the user chose last time.
 */
export function rememberedUpdateStrategy(state: vscode.Memento | undefined): UpdateStrategy {
  const setting = readSetting();
  if (setting !== 'ask') return setting;
  return state?.get<string>(LAST_STRATEGY_KEY) === 'rebase' ? 'rebase' : 'merge';
}

/**
 * Keeps an answer as "what you chose last time". Shared with the push flow's
 * Push Rejected question (POST-P14af): IntelliJ keeps one update method for
 * both, and saves it from either dialog.
 */
export async function rememberStrategy(
  state: vscode.Memento | undefined,
  strategy: UpdateStrategy,
): Promise<void> {
  await state?.update(LAST_STRATEGY_KEY, strategy);
}

async function remoteNames(core: Core, repo: RepoHandle): Promise<string[]> {
  const res = await core.git.exec(repo.root, ['remote']);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The modal as it will be shown — kept whole so tests can read what was asked. */
export interface UpdatePrompt {
  message: string;
  detail: string;
  /** Button labels, index-aligned with `choices`. */
  buttons: string[];
  choices: UpdateChoice[];
}

function choiceLabel(choice: UpdateChoice): string {
  switch (choice) {
    case 'merge':
      return vscode.l10n.t('Merge');
    case 'rebase':
      return vscode.l10n.t('Rebase');
    case 'reset':
      return vscode.l10n.t('Reset to the Remote Branch');
  }
}

/** A repository a project-wide update leaves alone, and why. */
export interface SkippedRepo {
  repo: RepoHandle;
  reason: string;
}

/** What one Update Project run covers. */
export interface UpdateScope {
  targets: RepoHandle[];
  skipped: SkippedRepo[];
}

/**
 * The repositories a project-wide Update Project touches (POST-P14ae) — every
 * one, as IntelliJ's does, except those it cannot update: a detached HEAD or a
 * branch with no upstream has nothing to update from, and a merge or rebase
 * already in progress is one git refuses to update over. Those are *skipped*,
 * not attempted — `runCommonAction`'s rule — so one repository mid-rebase
 * cannot stop the other six, and the question says so before anything runs.
 */
export function updateScope(repos: readonly RepoHandle[]): UpdateScope {
  const scope: UpdateScope = { targets: [], skipped: [] };
  for (const repo of repos) {
    const snap = repo.model.snapshot;
    // POST-P14ax: conflicts with no merge behind them too — a stash whose changes
    // did not go back cleanly. The conflict lifecycle holds the repository's
    // mutations until they are resolved, so its fetch would wait, and the run with it.
    const busy = repoBusyReason(snap);
    if (busy !== undefined) {
      scope.skipped.push({ repo, reason: busy });
    } else if (snap.detached) {
      scope.skipped.push({ repo, reason: vscode.l10n.t('detached HEAD') });
    } else if (snap.upstream === undefined) {
      scope.skipped.push({ repo, reason: vscode.l10n.t('no upstream branch') });
    } else {
      scope.targets.push(repo);
    }
  }
  return scope;
}

/** Workspace-wide names, so a repository is called here what the sidebar calls it. */
function labelsFor(core: Core): (repo: RepoHandle) => string {
  const labels = repoLabels(core.repos.map((r) => r.root));
  return (repo) => labels.get(repo.root) ?? path.basename(repo.root);
}

/**
 * An update's title (POST-P14bx, `updateTitle`): `Update Project` when the project
 * was asked for, and in a workspace of one repository, which *is* the project, so
 * nothing changes there. Else the repositories `repos` named: `Update api`,
 * `Update 2 Repositories`.
 */
export function runTitle(
  deps: UpdateDialogDeps,
  covers: UpdateCovers,
  repos: readonly RepoHandle[],
  withoutFetch: boolean,
): string {
  const label = labelsFor(deps.core);
  return updateTitle(deps.core.repos.length > 1 ? covers : 'project', repos.map(label), withoutFetch);
}

/**
 * One repository fetched for an update (POST-P14aw): what it tracks, and what
 * the fetch found there. The question is built from these, after the fetch,
 * so the counts in it are the ones the merge will meet.
 */
export interface FetchedUpdate {
  readonly repo: RepoHandle;
  readonly branch: string;
  readonly upstream: string;
  readonly remote: string | undefined;
  /** The upstream before the fetch, `''` when it did not resolve. */
  readonly before: string;
  /** The upstream after it: undefined when the fetch failed, or pruned it. */
  readonly after: string | undefined;
  /** Commits the upstream has that the branch does not. */
  readonly behind: number;
  /** Commits the branch has that the upstream does not. */
  readonly ahead: number;
  /** Why the fetch failed, in git's words. */
  readonly fetchError?: string;
  /**
   * POST-P14bm: not fetched — Update Project Without Fetching. `before`,
   * `after` and the counts are the upstream as it was last fetched.
   */
  readonly notFetched?: true;
  /** With `notFetched`: when that last fetch was, as far as can be told. */
  readonly fetchedAt?: number;
}

/** What one Update Project run found, once fetched. */
export interface FetchedScope {
  /** Every repository it fetched, in workspace order, the failed ones too. */
  readonly fetched: readonly FetchedUpdate[];
  readonly skipped: readonly SkippedRepo[];
  /** POST-P14bm: nothing was fetched; the question says so, and says how old the data is. */
  readonly withoutFetch?: boolean;
}

/** Fetched, still tracking something, and with commits to take in. */
function isPullable(f: FetchedUpdate): boolean {
  return f.fetchError === undefined && f.after !== undefined && f.behind > 0;
}

/** One repository's line in the question: where it stands, or why it will not be updated. */
function standingLine(f: FetchedUpdate, now: number): string {
  if (f.notFetched === true) {
    if (f.after === undefined) return vscode.l10n.t("{0} hasn't been fetched yet", f.upstream);
    return standingAsFetched(f.branch, f.upstream, f.behind, f.ahead, f.fetchedAt, now);
  }
  if (f.fetchError !== undefined) {
    return f.remote !== undefined
      ? vscode.l10n.t("couldn't fetch from {0} — {1}", f.remote, f.fetchError)
      : vscode.l10n.t("couldn't fetch — {0}", f.fetchError);
  }
  if (f.after === undefined) return vscode.l10n.t('{0} no longer exists on the remote', f.upstream);
  return standing(f.branch, f.upstream, f.behind, f.ahead);
}

/**
 * The Update Project question, or `undefined` when no repository in it could
 * be fetched. Whether to ask at all is the caller's to decide: nothing to pull
 * anywhere is said without a question.
 *
 * The buttons carry the verbs; the detail says what they act on, which a
 * dialog title alone never did — `develop ← origin/develop · 3 to pull`, one
 * line per repository, named when the workspace has more than one, then any
 * repository being skipped and why. With `gittree.dialogs.showCommandLine`
 * on, one repository gets each button's exact commands, the lines the P13
 * dialogs showed as `will run:`; several get one sentence saying what each of
 * them runs, rather than two command lines per repository.
 *
 * POST-P14bm: without a fetch, it is titled so, opens by saying nothing is
 * fetched first, and each line says how long ago its repository fetched.
 *
 * POST-P14bx: titled by what was asked for (`runTitle`): `Update Project` unless
 * the caller says otherwise, `Update api` for one repository's own update.
 */
export function buildUpdatePrompt(
  deps: UpdateDialogDeps,
  scope: FetchedScope,
  title: string = updateTitle('project', [], scope.withoutFetch === true),
): UpdatePrompt | undefined {
  const { fetched, skipped } = scope;
  const reachable = fetched.filter((f) => f.fetchError === undefined && f.after !== undefined);
  if (reachable.length === 0) return undefined;
  const only = fetched.length === 1 ? reachable[0] : undefined;
  const label = labelsFor(deps.core);
  const named = deps.core.repos.length > 1;
  const remembered = rememberedUpdateStrategy(deps.state);
  const showCommands = vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>('dialogs.showCommandLine', true);
  const withoutFetch = scope.withoutFetch === true;
  const now = Date.now();

  const lines: string[] = [];
  if (withoutFetch) {
    lines.push(
      only !== undefined
        ? vscode.l10n.t('Nothing is fetched first: {0} is used as it was last fetched.', only.upstream)
        : vscode.l10n.t(
            "Nothing is fetched first: each repository's remote branch is used as it was last fetched.",
          ),
      '',
    );
  }
  for (const f of fetched) {
    lines.push(named ? `${label(f.repo)}: ${standingLine(f, now)}` : standingLine(f, now));
  }
  for (const s of skipped) {
    lines.push(vscode.l10n.t('{0}: skipped — {1}', label(s.repo), s.reason));
  }
  lines.push('');

  let choices: UpdateChoice[];
  if (only !== undefined) {
    const snap = only.repo.model.snapshot;
    const question = buildUpdateQuestion(
      remembered,
      only.upstream,
      only.remote,
      // The command lines show what would be put aside given the tree as last
      // seen; the run reads status again and decides for itself.
      (strategy) =>
        planSetAside(snap.statusEntries, strategy, deps.core.git.caps.mergeAutostash),
      // Already fetched: each button runs what is left.
      true,
    );
    choices = [...question.choices];
    if (showCommands) {
      for (const choice of choices) lines.push(`${choiceLabel(choice)}: ${question.commands[choice]}`);
    }
  } else {
    choices = updateChoices(remembered, false);
    if (showCommands) {
      lines.push(
        vscode.l10n.t(
          'Each repository with something to pull runs git merge or git rebase onto its upstream, in the order listed. One that stops on conflicts or fails does not stop the others.',
        ),
      );
    }
  }
  if (!showCommands) {
    lines.push(
      vscode.l10n.t(
        'Merge incoming changes into the current branch, or rebase the current branch on top of incoming changes.',
      ),
    );
  }
  return {
    message: title,
    detail: lines.join('\n'),
    buttons: choices.map(choiceLabel),
    choices,
  };
}

let lastPrompt: UpdatePrompt | undefined;

/** Test seam: the question most recently put to the user, if any. */
export function lastUpdatePrompt(): UpdatePrompt | undefined {
  return lastPrompt;
}

/** Test seam: forget the last question, so a test can prove none was asked. */
export function clearLastUpdatePrompt(): void {
  lastPrompt = undefined;
}

/**
 * Puts the question. `undefined` is Cancel, Escape or closing the box.
 *
 * A native modal cannot be clicked from a test, so `GITTREE_TEST_UPDATE_CHOICE`
 * answers it (`merge` | `rebase` | `reset` | `cancel`), the same kind of seam
 * as `GITTREE_TEST_AUTOCONFIRM`. The prompt is recorded either way, so a test
 * sees exactly what a user would have been asked.
 */
async function askUpdate(prompt: UpdatePrompt): Promise<UpdateChoice | undefined> {
  lastPrompt = prompt;
  const seam = process.env['GITTREE_TEST_UPDATE_CHOICE'];
  if (seam !== undefined) {
    return prompt.choices.find((c) => c === seam);
  }
  const picked = await vscode.window.showInformationMessage(
    prompt.message,
    { modal: true, detail: prompt.detail },
    ...prompt.buttons,
  );
  const index = picked === undefined ? -1 : prompt.buttons.indexOf(picked);
  return index >= 0 ? prompt.choices[index] : undefined;
}

async function revParse(core: Core, repo: RepoHandle, ref: string): Promise<string | undefined> {
  const res = await core.git.exec(repo.root, ['rev-parse', '--verify', '--quiet', ref], {
    allowNonZeroExit: true,
  });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

/** What failed, worded for the user: git's reason rather than its exit code. */
function failureOf(err: unknown): string {
  if (err instanceof GitError) {
    // GitTree's own words when git never ran: a step cancelled before it began.
    return err.exitCode < 0 ? err.message : describeGitFailure(err.details);
  }
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n', 1)[0]?.trim() ?? text;
}

function branchName(repo: RepoHandle): string {
  return repo.model.snapshot.headRef ?? path.basename(repo.root);
}

/** Where `upstream` is now, and how far the branch is from it either way. */
async function measureStanding(
  core: Core,
  repo: RepoHandle,
  upstream: string,
): Promise<Pick<FetchedUpdate, 'after' | 'behind' | 'ahead'>> {
  const after = await revParse(core, repo, upstream);
  if (after === undefined) return { after, behind: 0, ahead: 0 };
  const res = await core.git.exec(
    repo.root,
    ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
    { allowNonZeroExit: true },
  );
  const counts = res.exitCode === 0 ? parseRangeCounts(res.stdout) : undefined;
  return { after, behind: counts?.right ?? 0, ahead: counts?.left ?? 0 };
}

/**
 * The fetch half of an update (POST-P14aw). Never throws: a fetch that fails
 * is that repository's result, and a project goes on without it.
 */
export async function fetchForUpdate(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  progress: OperationProgress | undefined,
): Promise<FetchedUpdate> {
  const { core } = deps;
  const branch = branchName(repo);
  const upstream = repo.model.snapshot.upstream ?? '';
  let remote: string | undefined;
  let before = '';
  try {
    remote = splitUpstream(upstream, await remoteNames(core, repo))?.remote;
    before = (await revParse(core, repo, upstream)) ?? '';
    await repo.queue.enqueue({
      label: vscode.l10n.t('Fetch'),
      kind: 'mutate',
      ...stepUnder(progress, async (git, token) => {
        await git.exec(repo.root, buildUpdateFetchArgs(remote), { token });
      }),
    });
    repo.model.update({ lastFetchAt: Date.now() });
    return { repo, branch, upstream, remote, before, ...(await measureStanding(core, repo, upstream)) };
  } catch (err) {
    return {
      repo,
      branch,
      upstream,
      remote,
      before,
      after: undefined,
      behind: 0,
      ahead: 0,
      fetchError: failureOf(err),
    };
  }
}

/**
 * The repositories of `repos` an update would cover, measured against what
 * was fetched last, without fetching. The question as it would read — a test
 * seam, since the real one is only ever built after a fetch.
 */
export async function scopeAsLastFetched(
  deps: UpdateDialogDeps,
  repos: readonly RepoHandle[],
): Promise<FetchedScope> {
  const scope = updateScope(repos);
  const fetched = await Promise.all(
    scope.targets.map(async (repo): Promise<FetchedUpdate> => {
      const upstream = repo.model.snapshot.upstream ?? '';
      const remote = splitUpstream(upstream, await remoteNames(deps.core, repo))?.remote;
      const measured = await measureStanding(deps.core, repo, upstream);
      return { repo, branch: branchName(repo), upstream, remote, before: measured.after ?? '', ...measured };
    }),
  );
  return { fetched, skipped: scope.skipped };
}

/**
 * When `repo` last fetched, as far as can be told (POST-P14bm): `FETCH_HEAD`,
 * which every `git fetch` and `git pull` rewrites — GitTree's, the terminal's,
 * another tool's — or GitTree's own note of its last fetch, whichever is later.
 * `FETCH_HEAD` is kept by the worktree that fetched, so a linked worktree looks
 * in the main one's too. It is the repository's last fetch of any remote, not
 * necessarily the upstream's: near enough for "how stale is this". Undefined
 * with no trace of a fetch at all — a clone that has not fetched since.
 */
function lastFetchTime(repo: RepoHandle): number | undefined {
  const times: number[] = [];
  for (const dir of new Set([repo.dirs.gitDir, repo.dirs.commonDir])) {
    try {
      times.push(fs.statSync(path.join(dir, 'FETCH_HEAD')).mtimeMs);
    } catch {
      // Never fetched from here.
    }
  }
  const own = repo.model.snapshot.lastFetchAt;
  if (own !== undefined) times.push(own);
  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * One repository as Update Project Without Fetching finds it (POST-P14bm):
 * against its upstream as last fetched, and when that was.
 */
async function lastFetched(deps: UpdateDialogDeps, repo: RepoHandle): Promise<FetchedUpdate> {
  const upstream = repo.model.snapshot.upstream ?? '';
  let remote: string | undefined;
  try {
    remote = splitUpstream(upstream, await remoteNames(deps.core, repo))?.remote;
  } catch {
    // Only ever shown; the update itself names the upstream, not the remote.
  }
  const measured = await measureStanding(deps.core, repo, upstream);
  const fetchedAt = lastFetchTime(repo);
  return {
    repo,
    branch: branchName(repo),
    upstream,
    remote,
    before: measured.after ?? '',
    ...measured,
    notFetched: true,
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
  };
}

/**
 * What Update Project Without Fetching covers (POST-P14bm): the repositories
 * `updateScope` would update, measured against what each fetched last. One
 * whose upstream has never been fetched has nothing to update from: skipped,
 * and the question and the summary say why.
 */
async function measureWithoutFetch(deps: UpdateDialogDeps, scope: UpdateScope): Promise<FetchedScope> {
  const measured = await Promise.all(scope.targets.map((repo) => lastFetched(deps, repo)));
  const skipped = [...scope.skipped];
  const fetched: FetchedUpdate[] = [];
  for (const f of measured) {
    if (f.after === undefined) {
      skipped.push({ repo: f.repo, reason: vscode.l10n.t('{0} not fetched yet', f.upstream) });
    } else {
      fetched.push(f);
    }
  }
  return { fetched, skipped, withoutFetch: true };
}

/** `measureWithoutFetch` for `repos`: the question Without Fetching would put — a test seam too. */
export async function scopeWithoutFetch(
  deps: UpdateDialogDeps,
  repos: readonly RepoHandle[],
): Promise<FetchedScope> {
  return measureWithoutFetch(deps, updateScope(repos));
}

/** A fetch that failed, as the update's outcome. */
function fetchFailure(f: FetchedUpdate): UpdateOutcome {
  const reason = f.fetchError ?? '';
  return {
    ok: false,
    commitsPulled: 0,
    filesChanged: 0,
    from: f.before,
    to: f.before,
    message:
      f.remote !== undefined
        ? vscode.l10n.t("Couldn't fetch from {0}: {1}", f.remote, reason)
        : vscode.l10n.t("Couldn't fetch: {0}", reason),
    fetchFailed: { ...(f.remote !== undefined ? { remote: f.remote } : {}), reason },
  };
}

/** What a repository that was fetched but not merged or rebased comes to. */
function outcomeWithoutUpdate(f: FetchedUpdate): UpdateOutcome {
  if (f.fetchError !== undefined) return fetchFailure(f);
  if (f.after === undefined) {
    return {
      ok: false,
      commitsPulled: 0,
      filesChanged: 0,
      from: f.before,
      to: f.before,
      message:
        f.notFetched === true
          ? vscode.l10n.t("Nothing to update from: {0} hasn't been fetched yet.", f.upstream)
          : vscode.l10n.t('{0} no longer exists on the remote.', f.upstream),
    };
  }
  return {
    ok: true,
    commitsPulled: 0,
    filesChanged: 0,
    from: f.after,
    to: f.after,
    message: f.notFetched === true ? upToDateAsFetched(f) : vscode.l10n.t('Already up to date.'),
  };
}

/**
 * POST-P14bm: up to date with the last fetch, which is not the remote as it
 * is now — so the age goes with it: `… with origin/main, as fetched 2 hours ago`.
 */
function upToDateAsFetched(f: FetchedUpdate): string {
  return f.fetchedAt !== undefined
    ? vscode.l10n.t('Already up to date with {0}, as fetched {1}.', f.upstream, fetchedAgo(f.fetchedAt, Date.now()))
    : vscode.l10n.t('Already up to date with {0}, as last fetched.', f.upstream);
}

/**
 * The accept half, separated so integration tests drive it with exactly the
 * answer the question returns. Returns what happened, for the notification and
 * for the tests.
 */
export async function applyUpdateResult(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  result: UpdateRequest,
): Promise<UpdateOutcome> {
  const snap = repo.model.snapshot;
  if (snap.upstream === undefined) {
    return {
      ok: false,
      commitsPulled: 0,
      filesChanged: 0,
      from: '',
      to: '',
      message: vscode.l10n.t('"{0}" has no upstream branch to update from.', snap.headRef ?? ''),
    };
  }
  // The fetch and the merge or rebase are one operation to the user: one
  // progress for both, not a notification that closes after the fetch and
  // opens again for the merge. Reset asks a question in between, so its two
  // steps keep their own.
  if (result.action !== 'update') {
    const fetched = await fetchForUpdate(deps, repo, undefined);
    return fetched.fetchError !== undefined ? fetchFailure(fetched) : resetFetched(deps, fetched);
  }
  const progress = beginOperationProgress(vscode.l10n.t('Updating {0}', branchName(repo)));
  try {
    progress.report(vscode.l10n.t('Fetching…'));
    const fetched = await fetchForUpdate(deps, repo, progress);
    if (fetched.fetchError !== undefined) return fetchFailure(fetched);
    return await integrateFetched(deps, fetched, result.strategy === 'rebase' ? 'rebase' : 'merge', progress);
  } finally {
    progress.done();
  }
}

/** A queued step under `progress`: quiet on its own, cancelled by its Cancel too. */
function stepUnder<T>(
  progress: OperationProgress | undefined,
  run: (git: GitExecutor, token: CancelToken) => Promise<T>,
): { quietProgress?: true; run: (git: GitExecutor, token: CancelToken) => Promise<T> } {
  if (progress === undefined) return { run };
  return {
    quietProgress: true,
    run: async (git, token) => {
      const linked = anyToken(token, progress.token);
      try {
        return await run(git, linked.token);
      } finally {
        linked.dispose();
      }
    },
  };
}

/**
 * What an update brings in, measured before it integrates: the commits the
 * upstream has that HEAD does not — however they got there. Measuring the
 * upstream's move during this fetch alone said *Already up to date* whenever
 * an earlier fetch (automatic, or the Fetch button) had brought the commits
 * down already, while the merge then took them in. `base` is where HEAD and
 * the upstream part, the start of the range `Show in Log` filters on.
 */
async function incomingFromUpstream(
  core: Core,
  repo: RepoHandle,
  upstream: string,
  fallbackBase: string,
): Promise<{ commits: number; files: number; base: string }> {
  const opts = { allowNonZeroExit: true } as const;
  const baseRes = await core.git.exec(repo.root, ['merge-base', 'HEAD', upstream], opts);
  const base = baseRes.exitCode === 0 ? baseRes.stdout.trim() : fallbackBase;
  const countRes = await core.git.exec(repo.root, ['rev-list', '--count', `HEAD..${upstream}`], opts);
  const commits = countRes.exitCode === 0 ? Number(countRes.stdout.trim()) || 0 : 0;
  if (commits === 0 || base.length === 0) return { commits, files: 0, base };
  const filesRes = await core.git.exec(repo.root, ['diff', '--name-only', '-z', base, upstream], opts);
  const files =
    filesRes.exitCode === 0 ? filesRes.stdout.split('\0').filter((p) => p.length > 0).length : 0;
  return { commits, files, base };
}

/** `Reset to the Remote Branch`, onto what `fetched` found — behind its own confirmation. */
async function resetFetched(deps: UpdateDialogDeps, fetched: FetchedUpdate): Promise<UpdateOutcome> {
  const { core } = deps;
  const { repo, upstream, before } = fetched;
  const snap = repo.model.snapshot;
  const after = fetched.after;
  if (after === undefined) return outcomeWithoutUpdate(fetched);
  const counted = await incomingFromUpstream(core, repo, upstream, before);
  const from = counted.base;
  const ok = await confirmModal(
    vscode.l10n.t('Reset "{0}" to {1}?', snap.headRef ?? '', upstream),
    vscode.l10n.t(
      'Discards every local commit and uncommitted change on this branch. A Local History snapshot is taken first.',
    ),
    vscode.l10n.t('Reset Hard'),
  );
  if (!ok) {
    return {
      ok: false,
      commitsPulled: counted.commits,
      filesChanged: counted.files,
      from,
      to: after,
      message: vscode.l10n.t('Reset cancelled.'),
    };
  }
  try {
    await repo.queue.enqueue({
      label: vscode.l10n.t('Reset to {0}', upstream),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.reset,
      run: async (git, token) => {
        await git.exec(repo.root, buildResetToRemoteArgs(upstream), { token });
      },
    });
    await repo.refresher.refreshNow();
    return {
      ok: true,
      commitsPulled: counted.commits,
      filesChanged: counted.files,
      from,
      to: after,
      message: vscode.l10n.t('Reset {0} to {1}.', snap.headRef ?? '', upstream),
    };
  } catch (err) {
    return { ok: false, commitsPulled: 0, filesChanged: 0, from, to: after, message: failureOf(err) };
  }
}

/**
 * The merge or rebase half of an update, onto what `fetched` found. A branch
 * with nothing to pull is left alone: the merge could only say so. `named`
 * prefixes the progress, for a project's several repositories.
 */
async function integrateFetched(
  deps: UpdateDialogDeps,
  fetched: FetchedUpdate,
  strategy: UpdateStrategy,
  progress: OperationProgress | undefined,
  named?: string,
): Promise<UpdateOutcome> {
  const { core } = deps;
  const { repo, upstream, before } = fetched;
  const after = fetched.after;
  if (after === undefined) return outcomeWithoutUpdate(fetched);

  // Measured against HEAD, before integrating: everything the upstream has
  // that the branch does not is what comes in — fetched now or earlier. Not
  // HEAD before→after, which a rebase's rewritten local commits would inflate.
  const counted = await incomingFromUpstream(core, repo, upstream, before);
  const from = counted.base;
  if (counted.commits === 0) {
    return { ok: true, commitsPulled: 0, filesChanged: 0, from, to: after, message: vscode.l10n.t('Already up to date.') };
  }
  const report = (step: string): void => {
    progress?.report(named !== undefined ? `${named}: ${step}` : step);
  };

  // Intent-to-add paths still out of the index when the integrate step stopped
  // half-way — reported rather than put back, see the `finally` below.
  let leftUntracked: string[] = [];
  // Files left conflicted by git putting the user's own changes back.
  let restoreConflicts = 0;
  try {
    report(
      strategy === 'rebase'
        ? vscode.l10n.t('Rebasing onto {0}…', upstream)
        : vscode.l10n.t('Merging {0}…', upstream),
    );
    await repo.queue.enqueue({
      label:
        strategy === 'rebase'
          ? vscode.l10n.t('Rebase onto {0}', upstream)
          : vscode.l10n.t('Merge {0}', upstream),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel:
        strategy === 'rebase' ? SNAPSHOT_LABELS.rebaseStart : SNAPSHOT_LABELS.merge,
      ...stepUnder(progress, async (git, token) => {
        // POST-P14ac: decided from a status read *now*, inside the queue — the
        // model snapshot can be older than the working tree it describes.
        const status = await git.exec(
          repo.root,
          ['status', '--porcelain=v2', '-z', '--untracked-files=no'],
          { structured: true, noOptionalLocks: true, token },
        );
        const entries = parseStatusV2(status.stdout).entries;
        const aside = planSetAside(entries, strategy, core.git.caps.mergeAutostash);
        const stashes = aside.autostash && hasStashableChanges(entries);
        if (aside.detach.length > 0) {
          await git.exec(repo.root, buildDetachArgs(aside.detach), { token });
        }
        try {
          await git.exec(repo.root, buildIntegrateArgs(strategy, upstream, aside.autostash), {
            token,
          });
        } finally {
          if (aside.detach.length > 0) {
            // Put back only once the merge or rebase is over. Stopped on a
            // conflict, the autostash is still waiting to be re-applied when
            // the user finishes, and `git stash` cannot stand intent-to-add
            // entries — re-adding them now could fail that very step. Left
            // untracked they lose nothing: the file is on disk, and it stays
            // in its changelist, whose commit path adds it back with `-N`.
            const present = aside.detach.filter((p) => fs.existsSync(path.join(repo.root, p)));
            if (detectInProgressOp(repo.dirs.gitDir) !== undefined) {
              leftUntracked = present;
            } else if (present.length > 0) {
              await git.exec(repo.root, buildReattachArgs(present), {
                token,
                allowNonZeroExit: true,
              });
            }
          }
        }
        // Reached only when the merge or rebase itself finished. If putting
        // the stashed changes back then conflicted, git still exits 0, with no
        // merge or rebase in progress for the conflict lifecycle to name it
        // by — so count it here, and tell the lifecycle what it was. Told only
        // once it has happened, as the stash service does: a hint registered
        // in advance would outlive a clean update and mislabel the next,
        // unrelated conflict in this repository.
        if (stashes) {
          const after = await git.exec(
            repo.root,
            ['status', '--porcelain=v2', '-z', '--untracked-files=no'],
            { structured: true, noOptionalLocks: true, token },
          );
          restoreConflicts = parseStatusV2(after.stdout).entries.filter(
            (e) => e.kind === 'unmerged',
          ).length;
          if (restoreConflicts > 0) {
            (core.debugRegistry.get('phase06') as ConflictLifecycleShape | undefined)
              ?.lifecycle?.expectConflict(repo.root, 'stash-pop');
          }
        }
      }),
    });
  } catch (err) {
    // Stopped on conflicts — still in progress — or refused before starting?
    // The operation left on disk is the reliable answer; git's wording is not.
    const conflicts =
      (err instanceof GitError && err.kind === 'merge-conflict') ||
      detectInProgressOp(repo.dirs.gitDir) !== undefined;
    await repo.refresher.refreshNow();
    // POST-P14aw: the reason, not `git exited with code 1` — which is all a
    // conflicted merge leaves on stderr, git saying the rest on stdout.
    const conflictFiles = conflicts
      ? repo.model.snapshot.statusEntries.filter((e) => e.kind === 'unmerged').map((e) => e.path)
      : [];
    const reason = conflicts
      ? vscode.l10n.t('The {0} stopped on {1}', strategy, conflictsPhrase(conflictFiles))
      : failureOf(err).replace(/\.$/u, '');
    // One line: the notification shows only the first one.
    const message =
      leftUntracked.length === 0
        ? `${reason}.`
        : `${reason} — ${
            leftUntracked.length === 1
              ? vscode.l10n.t(
                  '1 file added to VCS is unversioned until the {0} is finished; it stays in its changelist.',
                  strategy,
                )
              : vscode.l10n.t(
                  '{0} files added to VCS are unversioned until the {1} is finished; they stay in their changelist.',
                  leftUntracked.length,
                  strategy,
                )
          }`;
    return {
      ok: false,
      commitsPulled: counted.commits,
      filesChanged: counted.files,
      from,
      to: after,
      message,
      ...(conflicts ? { conflicts: true, conflictFiles } : {}),
    };
  }
  await repo.refresher.refreshNow();

  const summary =
    counted.commits === 0
      ? vscode.l10n.t('Already up to date.')
      : vscode.l10n.t(
          '{0}: {1}, {2} changed.',
          strategy === 'rebase' ? vscode.l10n.t('Rebased') : vscode.l10n.t('Merged'),
          commitsCount(counted.commits),
          filesCount(counted.files),
        );
  return {
    ok: true,
    commitsPulled: counted.commits,
    filesChanged: counted.files,
    from,
    to: after,
    message:
      restoreConflicts === 0
        ? summary
        : `${summary} ${vscode.l10n.t(
            'Your local changes conflict with it in {0}; a copy is kept in the stash.',
            filesCount(restoreConflicts),
          )}`,
    ...(restoreConflicts > 0 ? { restoreConflicts } : {}),
  };
}

/**
 * What a pull brought in: the commits `source` (the branch pulled, as it is
 * now) has that HEAD did not have `before` — so a rebase's rewritten local
 * commits are not counted — and the files HEAD changed since.
 */
export async function countPulled(
  core: Core,
  repo: RepoHandle,
  before: string,
  source: string,
): Promise<{ commits: number; files: number }> {
  if (before.length === 0) return { commits: 0, files: 0 };
  const countRes = await core.git.exec(repo.root, ['rev-list', '--count', `${before}..${source}`], {
    allowNonZeroExit: true,
  });
  const commits = countRes.exitCode === 0 ? Number(countRes.stdout.trim()) || 0 : 0;
  if (commits === 0) return { commits: 0, files: 0 };
  const filesRes = await core.git.exec(repo.root, ['diff', '--name-only', '-z', before, 'HEAD'], {
    allowNonZeroExit: true,
  });
  const files =
    filesRes.exitCode === 0
      ? filesRes.stdout.split('\0').filter((p) => p.length > 0).length
      : 0;
  return { commits, files };
}

export interface ReportOptions {
  /**
   * The strategy the user just answered the question with. Set only when a
   * question was actually asked: it puts `Don't Ask Again` on the result,
   * where IntelliJ has a `Don't show again` checkbox in the dialog — a native
   * message box cannot hold a checkbox (D30).
   */
  dontAskAgain?: UpdateStrategy;
  /**
   * The repository updated, so `Show in Log` filters *its* log. Without it the
   * range went to whichever repository the log happened to show, where in a
   * multi-root workspace neither end of it need exist.
   */
  root?: string;
  /**
   * POST-P14bm: the fetch failed but there is an upstream fetched earlier, so
   * the failure offers `Update Without Fetching` — offline, or the VPN down,
   * the update need not wait on a network that is not there. Needs `root`.
   */
  offerWithoutFetch?: boolean;
  /**
   * POST-P14bx: what a failure is reported under, the run's title (`runTitle`):
   * `Update api: Couldn't fetch …`. `Update Project` without it.
   */
  title?: string;
}

/**
 * The result notification standing in for IntelliJ's `Update Info` tab (D9):
 * what came in, and a "Show in Log" that opens the log filtered to exactly the
 * fetched range.
 */
export function reportUpdate(outcome: UpdateOutcome, options: ReportOptions = {}): void {
  const showConflicts = vscode.l10n.t('Show Conflicts');
  if (!outcome.ok) {
    const message = `${options.title ?? updateTitle('project', [])}: ${outcome.message.split('\n', 1)[0] ?? outcome.message}`;
    // Stopped on conflicts is not a failure to report but work to finish: the
    // merge is in progress, and the conflict lifecycle's own toast is held back
    // in favour of this one, which names the files.
    if (outcome.conflicts === true) {
      notifyWarning(message, showConflictsAction());
      return;
    }
    const details = vscode.l10n.t('Show Details');
    const withoutFetch = vscode.l10n.t('Update Without Fetching');
    const root = options.root;
    const offer = options.offerWithoutFetch === true && outcome.fetchFailed !== undefined && root !== undefined;
    const buttons = offer ? [withoutFetch, details] : [details];
    void vscode.window.showErrorMessage(message, ...buttons).then(async (choice) => {
      if (choice === details) await vscode.commands.executeCommand('gittree.log.showConsole');
      if (choice === withoutFetch) await vscode.commands.executeCommand(UPDATE_WITHOUT_FETCH_COMMAND, root);
    });
    return;
  }
  const showInLog = vscode.l10n.t('Show in Log');
  const dontAsk = vscode.l10n.t("Don't Ask Again");
  const actions = outcome.commitsPulled > 0 ? [showInLog] : [];
  if ((outcome.restoreConflicts ?? 0) > 0) actions.unshift(showConflicts);
  const remember = options.dontAskAgain;
  if (remember !== undefined) actions.push(dontAsk);
  // Deliberately not awaited: a notification carrying an action button stays
  // pending until the user dismisses it, and the update is already finished —
  // awaiting it would leave `showUpdateDialog` hanging on the notification.
  // A conflicted restore is a warning, not a success toast: the update landed,
  // but the user now has conflict markers in files they were editing.
  const shown =
    (outcome.restoreConflicts ?? 0) > 0
      ? vscode.window.showWarningMessage(outcome.message, ...actions)
      : vscode.window.showInformationMessage(outcome.message, ...actions);
  void shown.then(async (choice) => {
    if (choice === showConflicts) {
      await vscode.commands.executeCommand('gittree.conflicts.focus');
      return;
    }
    if (choice === showInLog) {
      if (options.root !== undefined) {
        await showRangeInLog(outcome, options.root);
      } else {
        await vscode.commands.executeCommand('gittree.log.openTab', {
          sort: 'topo',
          range: { a: outcome.from, b: outcome.to },
        });
      }
      return;
    }
    if (choice === dontAsk && remember !== undefined) {
      await rememberDontAskAgain(remember);
    }
  });
}

/** Show Conflicts, as the conflict lifecycle's own toast offers it. */
function showConflictsAction(): NotificationAction {
  return {
    title: vscode.l10n.t('Show Conflicts'),
    run: () => vscode.commands.executeCommand('gittree.conflicts.focus'),
  };
}

/**
 * The update of one named repository: a repository's own menu or button
 * (`Update Repository…`). Asks Merge or Rebase unless the user chose `Don't Ask
 * Again`, in which case that strategy runs directly — IntelliJ's behaviour, and
 * restorable through `gittree.update.configure`.
 *
 * POST-P14bm: `fetch: false` is Update Repository Without Fetching.
 * POST-P14bx: titled by the repository (`Update api`), not `Update Project`.
 */
export async function showUpdateDialog(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  options: { readonly fetch?: boolean } = {},
): Promise<UpdateOutcome | undefined> {
  const snap = repo.model.snapshot;
  if (snap.upstream === undefined) {
    showInfo(
      vscode.l10n.t('"{0}" has no upstream branch to update from.', snap.headRef ?? ''),
    );
    return undefined;
  }
  const fetch = options.fetch !== false;
  return updateOne(deps, repo, [], fetch, runTitle(deps, 'named', [repo], !fetch));
}

/**
 * One repository: exact commands, `Reset` offered, `Show in Log` for it.
 *
 * POST-P14aw: fetched before anything is asked, so the question says what is
 * coming in. With nothing to pull it is not asked: `Already up to date`.
 * POST-P14bm: without `fetch`, measured against the upstream as last fetched.
 * POST-P14bx: `title` is the run's, the question's and a failure's (`runTitle`).
 */
async function updateOne(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
  skipped: readonly SkippedRepo[],
  fetch: boolean,
  title: string,
): Promise<UpdateOutcome | undefined> {
  const hold = holdConflictNotices(deps.core, [repo]);
  try {
    const setting = readSetting();
    const progress = beginOperationProgress(vscode.l10n.t('Updating {0}', branchName(repo)));
    let fetched: FetchedUpdate;
    try {
      if (fetch) {
        progress.report(vscode.l10n.t('Fetching…'));
        fetched = await fetchForUpdate(deps, repo, progress);
        // Cancelled while fetching: a killed fetch reports nothing worth asking about.
        if (progress.token.isCancellationRequested) return undefined;
      } else {
        fetched = await lastFetched(deps, repo);
      }
      const settled = isPullable(fetched) ? undefined : outcomeWithoutUpdate(fetched);
      if (settled !== undefined) {
        if (fetched.notFetched === true && fetched.after === undefined) {
          // Never fetched: nothing went wrong, there is just nothing to update from.
          showInfo(settled.message);
        } else {
          reportUpdate(settled, {
            root: repo.root,
            title,
            // An upstream fetched before is there to update from, network or not.
            ...(fetched.fetchError !== undefined && fetched.before !== '' ? { offerWithoutFetch: true } : {}),
          });
        }
        return settled;
      }
      if (setting !== 'ask') {
        // Nobody is asked, so one progress covers the fetch and the merge.
        const outcome = await integrateFetched(deps, fetched, setting, progress);
        reportUpdate(outcome, { root: repo.root, title });
        return outcome;
      }
    } finally {
      // Taken down before the question, which would otherwise sit over it.
      progress.done();
    }

    const prompt = buildUpdatePrompt(
      deps,
      {
        fetched: [fetched],
        skipped,
        ...(fetch ? {} : { withoutFetch: true }),
      },
      title,
    );
    if (!prompt) return undefined;
    const choice = await askUpdate(prompt);
    if (choice === undefined) return undefined;

    if (choice === 'reset') {
      const outcome = await resetFetched(deps, fetched);
      reportUpdate(outcome, { root: repo.root, title });
      return outcome;
    }

    // Saved before the update runs, as IntelliJ saves the radio on OK: the answer
    // is the user's choice whether or not this particular update succeeds.
    await rememberStrategy(deps.state, choice);
    const integrating = beginOperationProgress(vscode.l10n.t('Updating {0}', branchName(repo)));
    let outcome: UpdateOutcome;
    try {
      outcome = await integrateFetched(deps, fetched, choice, integrating);
    } finally {
      integrating.done();
    }
    reportUpdate(outcome, { dontAskAgain: choice, root: repo.root, title });
    return outcome;
  } finally {
    hold.dispose();
  }
}

/** What a project-wide update did, repository by repository. */
export interface ProjectUpdateResult {
  /** Every repository it fetched, in workspace order, with what became of it. */
  results: Array<{ repo: RepoHandle; outcome: UpdateOutcome }>;
  skipped: SkippedRepo[];
  /** Fetched, then cancelled before their turn to merge came. */
  notAttempted?: RepoHandle[];
}

/** Fetches every target at once, a few at a time, under one progress. */
async function fetchAllForUpdate(
  deps: UpdateDialogDeps,
  targets: readonly RepoHandle[],
  progress: OperationProgress,
  label: (repo: RepoHandle) => string,
): Promise<FetchedUpdate[]> {
  const byRoot = new Map<string, FetchedUpdate>();
  progress.report(vscode.l10n.t('Fetching {0} repositories…', targets.length));
  await runFetchAll(
    targets.map((repo) => ({ repo, root: repo.root, name: label(repo) })),
    async (target) => {
      byRoot.set(target.root, await fetchForUpdate(deps, target.repo, progress));
    },
    {
      isCancelled: () => progress.token.isCancellationRequested,
      onSettled: (_outcome, done, total) => {
        progress.report(vscode.l10n.t('Fetched {0} of {1} repositories…', done, total));
      },
    },
  );
  return targets.map(
    (repo) =>
      byRoot.get(repo.root) ?? {
        repo,
        branch: branchName(repo),
        upstream: repo.model.snapshot.upstream ?? '',
        remote: undefined,
        before: '',
        after: undefined,
        behind: 0,
        ahead: 0,
        fetchError: vscode.l10n.t('cancelled'),
      },
  );
}

/**
 * `Ctrl+T` and `Update Project…` with no repository named: the **project**,
 * as IntelliJ's Update Project is (POST-P14ae).
 *
 * POST-P14aw, in three steps:
 * 1. **Fetch every repository**, together. One that cannot be fetched is left
 *    out of the rest, and said so; it used to end the run.
 * 2. **Ask, now that the question can say what comes in** — one line per
 *    repository, `3 to pull` or `up to date` — and not at all when nothing is
 *    coming in anywhere.
 * 3. **Merge or rebase each one with something to pull**, in order. A conflict
 *    or a failure in one does not stop the rest: each is its own merge in its
 *    own repository, and IntelliJ's update goes on past a conflict too. One
 *    summary says what became of every repository, worst news first.
 *
 * With a single repository to update the flow is exactly the one-repository
 * one, so a single-root workspace — and a multi-root one where only one
 * repository tracks anything — sees no difference at all.
 *
 * POST-P14bm: `fetch: false` is Update Project Without Fetching — step 1
 * becomes measuring each repository against what it fetched last, which
 * skips one whose upstream was never fetched; steps 2 and 3 are unchanged.
 *
 * POST-P14bx: `covers: 'named'` is some of the project, the repositories the
 * Repositories panel shows (`Update 2 Repositories…`), or those a run could not
 * fetch: the same steps, titled by them rather than `Update Project`.
 */
export async function showProjectUpdate(
  deps: UpdateDialogDeps,
  repos: readonly RepoHandle[],
  options: { readonly fetch?: boolean; readonly covers?: UpdateCovers } = {},
): Promise<ProjectUpdateResult | undefined> {
  const fetch = options.fetch !== false;
  const scope = updateScope(repos);
  const label = labelsFor(deps.core);
  const title = runTitle(deps, options.covers ?? 'project', repos, !fetch);
  if (scope.targets.length === 0) {
    showInfo(
      scope.skipped.length === 1 && scope.skipped[0] !== undefined
        ? vscode.l10n.t(
            'Nothing to update: {0} — {1}.',
            label(scope.skipped[0].repo),
            scope.skipped[0].reason,
          )
        : vscode.l10n.t('Nothing to update: no repository tracks a remote branch.'),
    );
    return undefined;
  }
  const first = scope.targets[0];
  if (scope.targets.length === 1 && first !== undefined) {
    const outcome = await updateOne(deps, first, scope.skipped, fetch, title);
    return outcome
      ? { results: [{ repo: first, outcome }], skipped: scope.skipped }
      : undefined;
  }

  const hold = holdConflictNotices(deps.core, scope.targets);
  try {
    let found: FetchedScope;
    if (fetch) {
      const fetching = beginOperationProgress(title);
      try {
        found = { fetched: await fetchAllForUpdate(deps, scope.targets, fetching, label), skipped: scope.skipped };
      } finally {
        fetching.done();
      }
      if (fetching.token.isCancellationRequested) {
        showInfo(`${title} cancelled: nothing was merged or rebased.`);
        return undefined;
      }
    } else {
      found = await measureWithoutFetch(deps, scope);
    }
    const fetched = found.fetched;
    const skipped = [...found.skipped];

    const pullable = fetched.filter(isPullable);
    if (pullable.length === 0) {
      const result: ProjectUpdateResult = {
        results: fetched.map((f) => ({ repo: f.repo, outcome: outcomeWithoutUpdate(f) })),
        skipped,
      };
      reportProjectUpdate(deps, result, 'merge', undefined, !fetch);
      return result;
    }

    const setting = readSetting();
    let strategy: UpdateStrategy;
    let asked = false;
    if (setting !== 'ask') {
      strategy = setting;
    } else {
      const prompt = buildUpdatePrompt(deps, found, title);
      if (!prompt) return undefined;
      const choice = await askUpdate(prompt);
      // `reset` is never offered across several repositories; treat anything
      // else the same as Cancel rather than trust an answer nobody was shown.
      if (choice !== 'merge' && choice !== 'rebase') return undefined;
      await rememberStrategy(deps.state, choice);
      strategy = choice;
      asked = true;
    }

    const outcomes = new Map<RepoHandle, UpdateOutcome>();
    const notAttempted: RepoHandle[] = [];
    const integrating = beginOperationProgress(title);
    try {
      for (const [i, f] of pullable.entries()) {
        // Cancel stops the next one from starting, never one half-way through.
        if (integrating.token.isCancellationRequested) {
          notAttempted.push(f.repo);
          continue;
        }
        const named = vscode.l10n.t('{0} ({1} of {2})', label(f.repo), i + 1, pullable.length);
        outcomes.set(f.repo, await integrateFetched(deps, f, strategy, integrating, named));
      }
    } finally {
      integrating.done();
    }

    const result: ProjectUpdateResult = {
      results: fetched
        .filter((f) => !notAttempted.includes(f.repo))
        .map((f) => ({ repo: f.repo, outcome: outcomes.get(f.repo) ?? outcomeWithoutUpdate(f) })),
      skipped,
      ...(notAttempted.length > 0 ? { notAttempted } : {}),
    };
    reportProjectUpdate(deps, result, strategy, asked ? strategy : undefined, !fetch);
    return result;
  } finally {
    hold.dispose();
  }
}

/** One repository's outcome, as the summary words it. */
function resultRow(name: string, outcome: UpdateOutcome, strategy: UpdateStrategy): RepoUpdateResult {
  if (outcome.ok) {
    return outcome.commitsPulled > 0
      ? {
          kind: 'updated',
          name,
          commits: outcome.commitsPulled,
          files: outcome.filesChanged,
          ...((outcome.restoreConflicts ?? 0) > 0 ? { restoreConflicts: true } : {}),
        }
      : { kind: 'upToDate', name };
  }
  if (outcome.conflicts === true) {
    return { kind: 'conflicts', name, operation: strategy, files: outcome.conflictFiles ?? [] };
  }
  if (outcome.fetchFailed !== undefined) {
    return {
      kind: 'failed',
      name,
      during: 'fetch',
      reason: outcome.fetchFailed.reason,
      ...(outcome.fetchFailed.remote !== undefined ? { remote: outcome.fetchFailed.remote } : {}),
    };
  }
  return { kind: 'failed', name, during: 'update', reason: outcome.message.split('\n', 1)[0] ?? outcome.message };
}

/**
 * One notification for the whole run — N toasts for N repositories would bury
 * the one that matters. Its words are `summarizeProjectUpdate`'s: conflicts
 * and failures first, then what came in, what had nothing to pull and what
 * was never in scope. `Show in Log` is offered only when exactly one
 * repository received commits: the log shows one repository at a time (D24),
 * and a range spanning several has nowhere to go.
 *
 * POST-P14bm: `withoutFetch` words "up to date" as of the last fetch. When
 * some fetches failed, `Update Without Fetching` updates those repositories
 * from what they fetched before — the ones that have an upstream to update from.
 */
function reportProjectUpdate(
  deps: UpdateDialogDeps,
  result: ProjectUpdateResult,
  strategy: UpdateStrategy,
  dontAskAgain: UpdateStrategy | undefined,
  withoutFetch = false,
): void {
  const label = labelsFor(deps.core);
  const rows: RepoUpdateResult[] = result.results.map(({ repo, outcome }) =>
    resultRow(label(repo), outcome, strategy),
  );
  for (const repo of result.notAttempted ?? []) rows.push({ kind: 'notAttempted', name: label(repo) });
  for (const s of result.skipped) rows.push({ kind: 'skipped', name: label(s.repo), reason: s.reason });
  const summary = summarizeProjectUpdate(rows, { withoutFetch });

  const actions: NotificationAction[] = [];
  if (summary.conflicts) actions.push(showConflictsAction());
  const pulled = result.results.filter((r) => r.outcome.commitsPulled > 0 && r.outcome.ok);
  const single = pulled.length === 1 ? pulled[0] : undefined;
  if (single !== undefined) {
    actions.push({
      title: vscode.l10n.t('Show in Log'),
      run: () => showRangeInLog(single.outcome, single.repo.root),
    });
  }
  const unreachable = unreachableWithUpstream(result);
  if (unreachable.length > 0) {
    actions.push({
      title: vscode.l10n.t('Update Without Fetching'),
      // Those repositories, titled by them (POST-P14bx): not the whole project again.
      run: () => showProjectUpdate(deps, unreachable, { fetch: false, covers: 'named' }),
    });
  }
  if (summary.failures) {
    // git's own words, every line of them, for what one sentence could not hold.
    actions.push({
      title: vscode.l10n.t('Show Details'),
      run: () => vscode.commands.executeCommand('gittree.log.showConsole'),
    });
  } else if (dontAskAgain !== undefined) {
    actions.push({ title: vscode.l10n.t("Don't Ask Again"), run: () => rememberDontAskAgain(dontAskAgain) });
  }
  if (summary.kind === 'warning') notifyWarning(summary.message, ...actions);
  else notifySuccess(summary.message, ...actions);
}

/**
 * POST-P14bm: the repositories whose fetch failed but which fetched their
 * upstream at some point before — what `Update Without Fetching` can update.
 */
export function unreachableWithUpstream(result: ProjectUpdateResult): RepoHandle[] {
  return result.results
    .filter((r) => r.outcome.fetchFailed !== undefined && r.outcome.from !== '')
    .map((r) => r.repo);
}

/**
 * The log, filtered to exactly what one update brought in — in *that*
 * repository, and in a Log tab of its own, so the filters of the tab you were
 * using survive.
 */
export async function showRangeInLog(outcome: UpdateOutcome, root: string): Promise<void> {
  await vscode.commands.executeCommand(
    'gittree.log.openTab',
    { sort: 'topo', range: { a: outcome.from, b: outcome.to } },
    root,
  );
}

async function rememberDontAskAgain(strategy: UpdateStrategy): Promise<void> {
  await setUpdateStrategy(strategy);
  // Say how to undo it: the question will not be there to remind anyone.
  showInfo(
    strategy === 'rebase'
      ? vscode.l10n.t(
          'Update Project will rebase without asking. Change this with "GitTree: Update Project Strategy…".',
        )
      : vscode.l10n.t(
          'Update Project will merge without asking. Change this with "GitTree: Update Project Strategy…".',
        ),
  );
}

/**
 * Update without asking (POST-P14ad): the remembered strategy — the setting,
 * else the last answer, else Merge — as IntelliJ's branch `Update` uses its
 * saved update method. What a branch row's `Update` runs on the checked-out
 * branch; `Update Project…` is the one that asks.
 */
export async function runRememberedUpdate(
  deps: UpdateDialogDeps,
  repo: RepoHandle,
): Promise<UpdateOutcome | undefined> {
  const snap = repo.model.snapshot;
  if (snap.upstream === undefined) {
    showInfo(
      vscode.l10n.t('"{0}" has no upstream branch to update from.', snap.headRef ?? ''),
    );
    return undefined;
  }
  const hold = holdConflictNotices(deps.core, [repo]);
  try {
    const outcome = await applyUpdateResult(deps, repo, {
      action: 'update',
      strategy: rememberedUpdateStrategy(deps.state),
    });
    // A failure is reported under the repository's name (POST-P14bx), not the project's.
    reportUpdate(outcome, { root: repo.root, title: runTitle(deps, 'named', [repo], false) });
    return outcome;
  } finally {
    hold.dispose();
  }
}

/** What `Ctrl+T` will do right now — `ask` means the question is still asked. */
export function currentUpdateStrategy(): UpdateStrategySetting {
  return readSetting();
}

/**
 * The persistence half of the gear, separated from the QuickPick so tests (and
 * the result's `Don't Ask Again`) drive the same code path the picker does.
 */
export async function setUpdateStrategy(value: UpdateStrategySetting): Promise<void> {
  await writeSetting('gittree', 'update.strategy', value);
}

/**
 * The "gear" that brings the question back after `Don't Ask Again` — IntelliJ
 * puts this in Settings; here it is a command, and the setting itself stays
 * editable in the Settings UI.
 */
export async function configureUpdateStrategy(): Promise<UpdateStrategySetting | undefined> {
  const current = readSetting();
  interface Choice extends vscode.QuickPickItem {
    value: UpdateStrategySetting;
  }
  const items: Choice[] = [
    {
      label: vscode.l10n.t('Ask every time'),
      description: vscode.l10n.t('Ask Merge or Rebase on every update'),
      value: 'ask',
    },
    {
      label: vscode.l10n.t('Merge'),
      description: vscode.l10n.t('Merge incoming changes into the current branch'),
      value: 'merge',
    },
    {
      label: vscode.l10n.t('Rebase'),
      description: vscode.l10n.t('Rebase the current branch on top of incoming changes'),
      value: 'rebase',
    },
  ];
  for (const item of items) if (item.value === current) item.picked = true;
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Update Project strategy (currently: {0})', current),
  });
  if (!picked) return undefined;
  await setUpdateStrategy(picked.value);
  return picked.value;
}

/** Shared by the command and the tests: the repo an update acts on. */
export function repoForUpdate(core: Core, arg?: unknown): RepoHandle | undefined {
  if (typeof arg === 'string' && arg.length > 0) {
    return core.repos.find((r) => canonicalKey(r.root) === canonicalKey(arg));
  }
  return undefined;
}
