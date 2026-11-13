/**
 * How the Commit window arranges its changes:
 * - `gittree.commit.groupBy`: whether changelists are rows, and with several
 *   repositories what comes first when they are (`none` by default, POST-P14cb);
 * - `gittree.commit.groupByDirectory`: folder rows over the files, or a flat
 *   list (off by default, POST-P14cb).
 * The window's View Options › Group By and the palette commands write them; the
 * window reads them on every push.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../../ui/writeSetting';
import { commitGroupByOf, type CommitGroupBy } from '../../shared/protocol';
import { GROUP_BY_DIRECTORY_DEFAULT } from './groupByDefaults';

export function readCommitGroupBy(): CommitGroupBy {
  return commitGroupByOf(vscode.workspace.getConfiguration('gittree.commit').get<string>('groupBy'));
}

export function readCommitGroupByDirectory(): boolean {
  return (
    vscode.workspace.getConfiguration('gittree.commit').get<boolean>('groupByDirectory', GROUP_BY_DIRECTORY_DEFAULT) ===
    true
  );
}

/**
 * Saved where `writeSetting` decides: the workspace if the user keeps the
 * setting there already, else the user's own settings — a new value never goes
 * into the repository's `.vscode/settings.json` (POST-QA).
 */
export async function writeCommitGroupBy(value: CommitGroupBy): Promise<void> {
  // POST-QA: not into the repository's .vscode/settings.json (`writeSetting`).
  await writeSetting('gittree', 'commit.groupBy', value);
}

/** POST-P14cb: the folder rows, saved as the grouping is. */
export async function writeCommitGroupByDirectory(on: boolean): Promise<void> {
  await writeSetting('gittree', 'commit.groupByDirectory', on);
}
