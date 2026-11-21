/**
 * The base a change bar is measured against (P14-T3), and the read that
 * fetches it. Shared by the bars, the change popup and the hunk actions so all
 * three can never disagree about what "the original" means — a rollback
 * computed against a different base than the bar the user clicked would revert
 * the wrong text.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../../core/core';
import { revObjectSpec } from '../../core/vdocs/revContentProvider';

export type ChangeBarsBase = 'index' | 'head';

/**
 * `geet.changeBars.base`, with a read-through fallback to the P1 name.
 * The old key stays honoured for one release so an upgrade does not silently
 * change what a user's bars mean.
 */
export function changeBarsBase(): ChangeBarsBase {
  const cfg = vscode.workspace.getConfiguration('geet');
  const next = cfg.inspect<string>('changeBars.base');
  const explicit =
    next?.workspaceFolderValue ?? next?.workspaceValue ?? next?.globalValue ?? undefined;
  const legacy = cfg.get<string>('quickDiff.base');
  const value = explicit ?? legacy ?? cfg.get<string>('changeBars.base', 'index');
  return value === 'head' ? 'head' : 'index';
}

/** The base text for one file, or undefined when it has none (untracked). */
export async function readBaseText(repo: RepoHandle, rel: string): Promise<string | undefined> {
  const ref = changeBarsBase() === 'head' ? 'HEAD' : ':0';
  const result = await repo.queue.enqueue({
    label: `show base for ${rel}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['show', revObjectSpec(ref, rel)], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}
