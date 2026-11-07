/**
 * Counted nouns, singular or plural — IntelliJ's `{0,choice,1#file|2#files}`,
 * as two strings each so a translation can word both (POST-QA: messages read
 * `1 file(s)`). Where a verb agrees with the count, the caller keeps two whole
 * sentences instead.
 */
import * as vscode from 'vscode';

/** `1 file` / `3 files`. */
export function filesCount(n: number): string {
  return n === 1 ? vscode.l10n.t('1 file') : vscode.l10n.t('{0} files', n);
}

/** `1 conflicted file` / `3 conflicted files`. */
export function conflictedFilesCount(n: number): string {
  return n === 1 ? vscode.l10n.t('1 conflicted file') : vscode.l10n.t('{0} conflicted files', n);
}

/** `1 untracked file` / `3 untracked files`. */
export function untrackedFilesCount(n: number): string {
  return n === 1 ? vscode.l10n.t('1 untracked file') : vscode.l10n.t('{0} untracked files', n);
}

/** `1 commit` / `3 commits`. */
export function commitsCount(n: number): string {
  return n === 1 ? vscode.l10n.t('1 commit') : vscode.l10n.t('{0} commits', n);
}
