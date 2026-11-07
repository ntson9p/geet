/**
 * `gittree.commit.groupBy`: what the Commit window puts at the top of its tree
 * in a workspace of several repositories. The window's View Options › Group By
 * and the two palette commands write it; the window reads it on every push.
 */
import * as vscode from 'vscode';
import { writeSetting } from '../../ui/writeSetting';
import { commitGroupByOf, type CommitGroupBy } from '../../shared/protocol';

export function readCommitGroupBy(): CommitGroupBy {
  return commitGroupByOf(vscode.workspace.getConfiguration('gittree.commit').get<string>('groupBy'));
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
