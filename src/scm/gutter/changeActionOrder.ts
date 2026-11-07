/**
 * The keyboard change popup's actions, in order (POST-QA). vscode-free.
 *
 * The first is what Enter does in a QuickPick, and Enter on this list used to
 * roll the change back. Rollback comes last, set apart; what comes first only
 * stages or looks.
 */
export type ChangeAction =
  | { readonly kind: 'action'; readonly id: 'stage' | 'commitView' | 'rollback'; readonly command: string }
  | { readonly kind: 'separator' };

export const CHANGE_ACTIONS: readonly ChangeAction[] = [
  { kind: 'action', id: 'stage', command: 'gittree.hunk.stage' },
  { kind: 'action', id: 'commitView', command: 'gittree.hunk.openCommitView' },
  { kind: 'separator' },
  { kind: 'action', id: 'rollback', command: 'gittree.hunk.rollback' },
];
