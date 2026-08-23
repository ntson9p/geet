/**
 * Push dialog, host half (P13-T1, gap analysis S4): builds the per-repo
 * sections (outgoing commits + the changed-file set of the push), serves
 * retargeting recomputes, and turns the accepted result into real `git push`
 * invocations through each repo's operation queue.
 *
 * The §2A shape lives in `webview-ui/src/dialogs/Push.tsx`; argv assembly is
 * the vscode-free `pushArgs.ts` so the flag matrix is unit-tested. Force keeps
 * the P5 safety rule: `--force-with-lease` (+ `--force-if-includes` when the
 * git build has it) behind an explicit confirmation, never `--force`.
 *
 * All reads are local (`git remote`, local tracking refs, `log`/`diff`) — the
 * dialog never talks to a remote until the user pushes.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { makeRevUri } from '../../core/vdocs/revContentProvider';
import { parseNameStatusZ } from '../../branches/parsing';
import {
  PUSH_DIALOG_METHODS,
  type PushCommitDto,
  type PushDialogParamsDto,
  type PushDialogResultDto,
  type PushFileDto,
  type PushRepoSectionDto,
} from '../../shared/protocol';
import { confirmModal } from '../../ui/confirm';
import { openDialog } from '../../ui/dialogHost';
import { statusColorOverrides } from '../../ui/statusColors';
import { buildPushArgs, formatGitCommand, shouldSetUpstream, splitUpstream } from './pushArgs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const COMMIT_CAP = 100;

export interface PushDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
}

async function listRemotes(core: Core, repo: RepoHandle): Promise<string[]> {
  const res = await core.git.exec(repo.root, ['remote']);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Branch names under `refs/remotes/<remote>` — completions for the target field. */
async function listRemoteBranches(
  core: Core,
  repo: RepoHandle,
  remote: string,
): Promise<string[]> {
  const res = await core.git.exec(repo.root, [
    'for-each-ref',
    '--format=%(refname:lstrip=3)',
    `refs/remotes/${remote}`,
  ]);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    // `origin/HEAD` is a symref, not a push target.
    .filter((l) => l.length > 0 && l !== 'HEAD');
}

async function trackingRefExists(
  core: Core,
  repo: RepoHandle,
  remote: string,
  branch: string,
): Promise<boolean> {
  const res = await core.git.exec(
    repo.root,
    ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`],
    { allowNonZeroExit: true },
  );
  return res.exitCode === 0;
}

interface Outgoing {
  commits: PushCommitDto[];
  totalCommits: number;
  files: PushFileDto[];
  targetExists: boolean;
  base: string;
}

/**
 * The outgoing set for one target: commits `<tracking>..HEAD` when the
 * tracking ref exists, else everything not on that remote; the file tree is
 * the exact `diff <base>..HEAD` (base = tracking ref, or the span's boundary
 * parent, or the empty tree for a root-spanning push — the P12-T3 rule).
 */
async function computeOutgoing(
  core: Core,
  repo: RepoHandle,
  remote: string,
  branch: string,
): Promise<Outgoing> {
  const targetExists = await trackingRefExists(core, repo, remote, branch);
  const range = targetExists
    ? [`refs/remotes/${remote}/${branch}..HEAD`]
    : ['HEAD', '--not', `--remotes=${remote}`];
  const logRes = await core.git.exec(repo.root, [
    'log',
    '--format=%H%x00%s%x00%an%x00%at',
    ...range,
  ]);
  const lines = logRes.stdout.split('\n').filter((l) => l.length > 0);
  const commits: PushCommitDto[] = [];
  for (const line of lines.slice(0, COMMIT_CAP)) {
    const [sha, subject, authorName, at] = line.split('\0');
    if (sha === undefined || subject === undefined) continue;
    commits.push({
      sha,
      subject,
      authorName: authorName ?? '',
      authorTime: Number(at ?? '0') || 0,
    });
  }

  let base: string;
  if (targetExists) {
    base = `refs/remotes/${remote}/${branch}`;
  } else if (lines.length === 0) {
    base = 'HEAD'; // nothing outgoing — empty diff
  } else {
    const oldestLine = lines[lines.length - 1];
    const oldest = oldestLine === undefined ? '' : (oldestLine.split('\0')[0] ?? '');
    const parentProbe = await core.git.exec(
      repo.root,
      ['rev-parse', '--verify', '--quiet', `${oldest}^`],
      { allowNonZeroExit: true },
    );
    base = parentProbe.exitCode === 0 ? `${oldest}^` : EMPTY_TREE;
  }
  const diffRes = await core.git.exec(repo.root, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    base,
    'HEAD',
  ]);
  const files: PushFileDto[] = parseNameStatusZ(diffRes.stdout).map((e) => ({
    status: e.status,
    path: e.path,
    ...(e.origPath !== undefined ? { origPath: e.origPath } : {}),
  }));
  return { commits, totalCommits: lines.length, files, targetExists, base };
}

async function buildRepoSection(
  core: Core,
  repo: RepoHandle,
  target?: { remote: string; remoteBranch: string },
): Promise<PushRepoSectionDto | undefined> {
  const snap = repo.model.snapshot;
  const branch = snap.headRef;
  if (branch === undefined || snap.detached || snap.initial) return undefined;
  const remotes = await listRemotes(core, repo);
  if (remotes.length === 0) return undefined;

  const upstream = snap.upstream !== undefined ? splitUpstream(snap.upstream, remotes) : undefined;
  // A retarget to a remote that has since disappeared falls back to the default.
  const wanted = target !== undefined && remotes.includes(target.remote) ? target : undefined;
  const remote = wanted?.remote ?? upstream?.remote ?? remotes[0]!;
  const remoteBranch =
    wanted !== undefined && wanted.remoteBranch.length > 0
      ? wanted.remoteBranch
      : (upstream?.branch ?? branch);
  const [outgoing, remoteBranchOptions] = await Promise.all([
    computeOutgoing(core, repo, remote, remoteBranch),
    listRemoteBranches(core, repo, remote),
  ]);
  return {
    root: repo.root,
    label: path.basename(repo.root),
    branch,
    remotes,
    remote,
    remoteBranch,
    hasUpstream: upstream !== undefined,
    targetExists: outgoing.targetExists,
    remoteBranchOptions,
    base: outgoing.base,
    commits: outgoing.commits,
    totalCommits: outgoing.totalCommits,
    files: outgoing.files,
    checked: true,
  };
}

export async function buildPushParams(
  core: Core,
  repos: readonly RepoHandle[],
): Promise<PushDialogParamsDto> {
  const cfg = vscode.workspace.getConfiguration('gittree');
  const sections: PushRepoSectionDto[] = [];
  for (const repo of repos) {
    const section = await buildRepoSection(core, repo);
    if (section) sections.push(section);
  }
  const tagsSetting = cfg.get<string>('push.tags', 'none');
  return {
    repos: sections,
    tags: tagsSetting === 'all' || tagsSetting === 'follow' ? tagsSetting : 'none',
    runHooks: cfg.get<boolean>('push.runHooks', true),
    showCommandLine: cfg.get<boolean>('dialogs.showCommandLine', true),
    forceIfIncludes: core.git.caps.forceIfIncludes,
    colors: statusColorOverrides(),
  };
}

/**
 * The pane toolbar's "show diff" — `<base>:<origPath>` ↔ `HEAD:<path>` through
 * the P1 `gittree-rev:` provider, with the add/delete one-sided cases the log's
 * Changed Files pane already handles the same way.
 */
async function openPushedDiff(
  repoRoot: string,
  file: { status: string; path: string; origPath?: string },
  base: string,
): Promise<void> {
  const name = path.posix.basename(file.path);
  if (file.status.startsWith('A')) {
    await vscode.window.showTextDocument(makeRevUri(repoRoot, file.path, 'HEAD'), {
      preview: true,
    });
    return;
  }
  if (file.status.startsWith('D')) {
    await vscode.window.showTextDocument(makeRevUri(repoRoot, file.path, base), { preview: true });
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    makeRevUri(repoRoot, file.origPath ?? file.path, base),
    makeRevUri(repoRoot, file.path, 'HEAD'),
    `${name} (${base === EMPTY_TREE ? 'root' : base}..HEAD)`,
  );
}

/**
 * The dialog's request handlers, built here so integration tests can exercise
 * them without a panel — the P11-T3 lesson that a missing handler fails in
 * total silence is why the whole surface is asserted, not just `retarget`.
 */
export function pushDialogHandlers(
  deps: PushDialogDeps,
): Record<string, (params: unknown) => unknown> {
  const repoFor = (root: string): RepoHandle | undefined =>
    // Canonical-key resolution with NO fallback — the P12-T2 lesson.
    deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
  return {
    [PUSH_DIALOG_METHODS.retarget]: async (raw): Promise<PushRepoSectionDto | undefined> => {
      const p = raw as { root: string; remote: string; remoteBranch: string };
      const repo = repoFor(p.root);
      if (!repo) return undefined;
      return buildRepoSection(deps.core, repo, {
        remote: p.remote,
        remoteBranch: p.remoteBranch,
      });
    },
    [PUSH_DIALOG_METHODS.openDiff]: async (raw): Promise<{ ok: boolean }> => {
      const p = raw as {
        root: string;
        base: string;
        status: string;
        path: string;
        origPath?: string;
      };
      const repo = repoFor(p.root);
      if (!repo) return { ok: false };
      await openPushedDiff(repo.root, p, p.base);
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
  };
}

/**
 * The accept half, separated so integration tests drive it with exactly the
 * payload the webview posts (the dialog UI itself is Playwright-covered).
 * Returns the per-repo outcome messages, for tests and the notification.
 */
export async function applyPushResult(
  deps: PushDialogDeps,
  result: PushDialogResultDto,
): Promise<string[]> {
  const { core } = deps;
  const outcomes: string[] = [];

  // Plan first so the force confirmation can name the exact commands — a
  // "rewrites the remote" warning that hides its own argv is not a warning.
  const plan: Array<{ repo: RepoHandle; branch: string; target: (typeof result.repos)[number]; args: string[] }> = [];
  for (const target of result.repos) {
    // Canonical-key resolution with NO fallback — the P12-T2 lesson.
    const repo = core.repos.find((r) => canonicalKey(r.root) === canonicalKey(target.root));
    if (!repo) {
      outcomes.push(`${target.root}: repository not found`);
      continue;
    }
    const branch = repo.model.snapshot.headRef;
    if (branch === undefined) {
      outcomes.push(`${target.root}: no branch`);
      continue;
    }
    plan.push({
      repo,
      branch,
      target,
      args: buildPushArgs({
        remote: target.remote,
        localBranch: branch,
        remoteBranch: target.remoteBranch,
        setUpstream: shouldSetUpstream(
          repo.model.snapshot.upstream !== undefined,
          branch,
          target.remoteBranch,
        ),
        tags: result.tags,
        runHooks: result.runHooks,
        force: result.force,
        forceIfIncludes: result.force && core.git.caps.forceIfIncludes,
      }),
    });
  }

  if (result.force && plan.length > 0) {
    const ok = await confirmModal(
      vscode.l10n.t('Force-push (with lease) {0} repository(ies)?', plan.length),
      `${vscode.l10n.t('Rewrites the remote branch to match your local history.')}\n\n${plan
        .map((p) => formatGitCommand(p.args))
        .join('\n')}`,
      vscode.l10n.t('Force Push'),
    );
    if (!ok) return [];
  }

  for (const { repo, branch, target, args } of plan) {
    try {
      await repo.queue.enqueue({
        label: vscode.l10n.t('Push {0}', branch),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(repo.root, args, { token });
        },
      });
      await repo.refresher.refreshNow();
      outcomes.push(
        `${branch} → ${target.remote}/${target.remoteBranch}: ${vscode.l10n.t('pushed')}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push(`${branch} → ${target.remote}/${target.remoteBranch}: ${message}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Push failed: {0}', message.split('\n', 1)[0] ?? message),
      );
    }
  }
  return outcomes;
}

/** Opens the dialog; resolves true when at least one push ran. */
export async function showPushDialog(
  deps: PushDialogDeps,
  repos: readonly RepoHandle[],
): Promise<boolean> {
  const params = await buildPushParams(deps.core, repos);
  if (params.repos.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Nothing to push: no repository has a branch and a remote.'),
    );
    return false;
  }
  const result = await openDialog<PushDialogParamsDto, PushDialogResultDto>({
    app: 'dialogs',
    dialog: 'push',
    title: vscode.l10n.t(
      'Push Commits to {0}',
      params.repos.map((r) => r.label).join(', '),
    ),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
    handlers: pushDialogHandlers(deps),
  });
  if (!result || result.repos.length === 0) return false;

  // Remember the footer options for next time.
  const cfg = vscode.workspace.getConfiguration('gittree');
  await cfg.update('push.tags', result.tags, vscode.ConfigurationTarget.Workspace);
  await cfg.update('push.runHooks', result.runHooks, vscode.ConfigurationTarget.Workspace);

  const outcomes = await applyPushResult(deps, result);
  if (outcomes.length > 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Push: {0}', outcomes.join(' · ')));
  }
  return outcomes.length > 0;
}
