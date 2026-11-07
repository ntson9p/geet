/**
 * `gittree.commit.groupBy`: what the Commit window puts at the top of its tree
 * in a workspace of several repositories. The window's View Options › Group By
 * and the two palette commands write it; the window reads it on every push.
 */
import * as vscode from 'vscode';
import { commitGroupByOf, type CommitGroupBy } from '../../shared/protocol';

export function readCommitGroupBy(): CommitGroupBy {
  return commitGroupByOf(vscode.workspace.getConfiguration('gittree.commit').get<string>('groupBy'));
}

/**
 * Saved for the workspace, as IntelliJ keeps its grouping per project and as
 * GitTree saves its other view options (the Repositories panel's Show items,
 * the commit paradigm). A window with no folder open has no workspace to keep
 * it in, so it goes to the user's settings there.
 */
export async function writeCommitGroupBy(value: CommitGroupBy): Promise<void> {
  const target =
    (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('gittree').update('commit.groupBy', value, target);
}
