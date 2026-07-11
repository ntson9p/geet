/**
 * File-level operations & diff commands (P1-T4). Every git call goes through
 * the repo's OperationQueue; destructive ones declare the P9 snapshot labels.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { StatusEntry } from '../core/model/statusEntry';
import { diffTitle, makeRevUri } from '../core/vdocs/revContentProvider';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import { GitTreeResourceState } from './sourceControl';

interface Selection {
  repo: RepoHandle;
  entries: StatusEntry[];
}

/** scm/resourceGroup/context passes the group object; unwrap its states. */
function statesFrom(args: unknown[]): GitTreeResourceState[] {
  const out: GitTreeResourceState[] = [];
  for (const a of args) {
    if (a instanceof GitTreeResourceState) {
      out.push(a);
    } else if (
      typeof a === 'object' &&
      a !== null &&
      'resourceStates' in a &&
      Array.isArray(a.resourceStates)
    ) {
      for (const s of a.resourceStates as unknown[]) {
        if (s instanceof GitTreeResourceState) out.push(s);
      }
    }
  }
  return out;
}

/** SCM menus pass the selected resource states spread as arguments. */
function normalize(core: Core, args: unknown[]): Selection | undefined {
  const states = statesFrom(args);
  if (states.length > 0) {
    const repo = core.getRepo(states[0]!.repoRoot);
    if (!repo) return undefined;
    return { repo, entries: states.map((s) => s.entry) };
  }
  const uri = args.find((a): a is vscode.Uri => a instanceof vscode.Uri) ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') return undefined;
  const repo = core.repoForUri(uri);
  if (!repo) return undefined;
  const rel = path.relative(repo.root, uri.fsPath).replace(/\\/g, '/');
  const entry = repo.model.snapshot.statusEntries.find((e) => e.path === rel);
  return entry ? { repo, entries: [entry] } : { repo, entries: [] };
}

function absPaths(repo: RepoHandle, entries: readonly StatusEntry[]): string[] {
  return entries.map((e) => path.join(repo.root, e.path));
}

async function runGit(
  repo: RepoHandle,
  label: string,
  args: string[],
  destructive?: { snapshotLabel: string; snapshotPaths?: string[] },
): Promise<void> {
  await repo.queue.enqueue({
    label,
    kind: 'mutate',
    ...(destructive ? { isDestructive: true, ...destructive } : {}),
    run: async (git, token) => {
      await git.exec(repo.root, args, { token });
    },
  });
}

export async function openDiffForResource(core: Core, state: GitTreeResourceState): Promise<void> {
  const repo = core.getRepo(state.repoRoot);
  if (!repo) return;
  const entry = state.entry;
  const fileUri = vscode.Uri.file(path.join(repo.root, entry.path));

  if (state.group === 'untracked') {
    await vscode.window.showTextDocument(fileUri, { preview: true });
    return;
  }
  if (state.group === 'staged') {
    // Index ↔ HEAD; staged rename diffs old name at HEAD vs new in index.
    const headRel = entry.origPath ?? entry.path;
    const left = makeRevUri(repo.root, headRel, 'HEAD');
    const right =
      entry.x === 'D' ? makeRevUri(repo.root, entry.path, 'HEAD') : makeRevUri(repo.root, entry.path, ':0');
    if (entry.x === 'D') {
      await vscode.window.showTextDocument(right, { preview: true });
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, diffTitle(entry.path, 'index'));
    return;
  }
  // changes/merge: index ↔ working tree.
  if (entry.y === 'D') {
    await vscode.window.showTextDocument(makeRevUri(repo.root, entry.path, ':0'), { preview: true });
    return;
  }
  const left = makeRevUri(repo.root, entry.path, ':0');
  await vscode.commands.executeCommand('vscode.diff', left, fileUri, diffTitle(entry.path, 'working-tree'));
}

export function registerFileOps(context: vscode.ExtensionContext, core: Core): void {
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('gittree.openDiff', async (...args) => {
    const state = args.find((a): a is GitTreeResourceState => a instanceof GitTreeResourceState);
    if (state) {
      await openDiffForResource(core, state);
      return;
    }
    // Palette/editor invocation: diff the active file against the index.
    const sel = normalize(core, args);
    if (!sel || sel.entries.length === 0) return;
    await openDiffForResource(
      core,
      new GitTreeResourceState(sel.repo.root, sel.entries[0]!, 'changes'),
    );
  });

  register('gittree.openDiffHead', async (...args) => {
    const sel = normalize(core, args);
    if (!sel || sel.entries.length === 0) return;
    const entry = sel.entries[0]!;
    const fileUri = vscode.Uri.file(path.join(sel.repo.root, entry.path));
    const left = makeRevUri(sel.repo.root, entry.origPath ?? entry.path, 'HEAD');
    await vscode.commands.executeCommand('vscode.diff', left, fileUri, diffTitle(entry.path, 'head'));
  });

  register('gittree.openFile', async (...args) => {
    const sel = normalize(core, args);
    const state = args.find((a): a is GitTreeResourceState => a instanceof GitTreeResourceState);
    const target = state
      ? vscode.Uri.file(path.join(state.repoRoot, state.entry.path))
      : sel && sel.entries.length > 0
        ? vscode.Uri.file(path.join(sel.repo.root, sel.entries[0]!.path))
        : undefined;
    if (target) await vscode.window.showTextDocument(target, { preview: false });
  });

  register('gittree.add', async (...args) => {
    const sel = normalize(core, args);
    if (!sel || sel.entries.length === 0) return;
    await runGit(sel.repo, vscode.l10n.t('Stage {0} file(s)', sel.entries.length), [
      'add',
      '-A',
      '--',
      ...sel.entries.map((e) => e.path),
    ]);
  });

  register('gittree.unstage', async (...args) => {
    const sel = normalize(core, args);
    if (!sel || sel.entries.length === 0) return;
    const paths = sel.entries.map((e) => e.path);
    await sel.repo.queue.enqueue({
      label: vscode.l10n.t('Unstage {0} file(s)', paths.length),
      kind: 'mutate',
      run: async (git, token) => {
        const r = await git.exec(sel.repo.root, ['restore', '--staged', '--', ...paths], {
          token,
          allowNonZeroExit: true,
        });
        if (r.exitCode !== 0) {
          // Unborn HEAD: restore --staged needs a commit; rm --cached doesn't.
          await git.exec(sel.repo.root, ['rm', '--cached', '-r', '-q', '--', ...paths], { token });
        }
      },
    });
  });

  register('gittree.rollbackFile', async (...args) => {
    const sel = normalize(core, args);
    if (!sel || sel.entries.length === 0) return;
    const tracked = sel.entries.filter((e) => e.kind !== 'untracked');
    const untracked = sel.entries.filter((e) => e.kind === 'untracked');
    const fileList = sel.entries.map((e) => e.path).join('\n');
    const ok = await confirmModal(
      vscode.l10n.t('Roll back changes in {0} file(s)?', sel.entries.length),
      vscode.l10n.t(
        '{0}\n\nTracked files return to HEAD; untracked files are deleted. A Local History snapshot is taken first.',
        fileList,
      ),
      vscode.l10n.t('Roll Back'),
    );
    if (!ok) return;

    await sel.repo.queue.enqueue({
      label: vscode.l10n.t('Rollback {0} file(s)', sel.entries.length),
      kind: 'mutate',
      isDestructive: true,
      snapshotLabel: SNAPSHOT_LABELS.rollback,
      snapshotPaths: absPaths(sel.repo, sel.entries),
      run: async (git, token) => {
        if (tracked.length > 0) {
          await git.exec(
            sel.repo.root,
            ['restore', '--source=HEAD', '--worktree', '--staged', '--', ...tracked.map((e) => e.path)],
            { token },
          );
        }
        for (const e of untracked) {
          await vscode.workspace.fs.delete(vscode.Uri.file(path.join(sel.repo.root, e.path)), {
            useTrash: false,
          });
        }
      },
    });
  });

  register('gittree.cleanUntracked', async (...args) => {
    const sel = normalize(core, args);
    const repo = sel?.repo ?? core.repos[0];
    if (!repo) return;
    const untracked = repo.model.snapshot.statusEntries.filter((e) => e.kind === 'untracked');
    if (untracked.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No untracked files to clean.'));
      return;
    }
    const ok = await confirmModal(
      vscode.l10n.t('Delete {0} untracked file(s)?', untracked.length),
      untracked.map((e) => e.path).join('\n'),
      vscode.l10n.t('Delete'),
    );
    if (!ok) return;
    await runGit(
      repo,
      vscode.l10n.t('Clean {0} untracked file(s)', untracked.length),
      ['clean', '-f', '-q', '--', ...untracked.map((e) => e.path)],
      {
        snapshotLabel: SNAPSHOT_LABELS.cleanUntracked,
        snapshotPaths: absPaths(repo, untracked),
      },
    );
  });

  register('gittree.refresh', async () => {
    await Promise.all(core.repos.map((r) => r.refresher.refreshNow()));
  });
}
