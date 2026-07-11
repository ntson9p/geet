/**
 * Status-entry → SCM resource decoration mapping (P1-T1). ThemeIcon +
 * gitDecoration theme colors keep light/dark/high-contrast correct without
 * shipping SVGs.
 */
import * as vscode from 'vscode';
import { shortCode, type StatusEntry } from '../core/model/statusEntry';

export type GroupId = 'merge' | 'staged' | 'changes' | 'untracked';

function themeIcon(id: string, colorId?: string): vscode.ThemeIcon {
  return colorId ? new vscode.ThemeIcon(id, new vscode.ThemeColor(colorId)) : new vscode.ThemeIcon(id);
}

interface Visual {
  icon: vscode.ThemeIcon;
  strikeThrough?: boolean;
  faded?: boolean;
  letter: string;
}

/** The staged/unstaged side being rendered decides which x/y char matters. */
function visualFor(entry: StatusEntry, group: GroupId): Visual {
  if (entry.kind === 'unmerged') {
    return { icon: themeIcon('warning', 'gitDecoration.conflictingResourceForeground'), letter: shortCode(entry) };
  }
  if (entry.kind === 'untracked') {
    return { icon: themeIcon('diff-added', 'gitDecoration.untrackedResourceForeground'), letter: 'U' };
  }
  if (entry.kind === 'ignored') {
    return { icon: themeIcon('diff-ignored', 'gitDecoration.ignoredResourceForeground'), faded: true, letter: '!' };
  }
  const code = group === 'staged' ? entry.x : entry.y;
  switch (code) {
    case 'A':
      return { icon: themeIcon('diff-added', 'gitDecoration.addedResourceForeground'), letter: 'A' };
    case 'D':
      return {
        icon: themeIcon('diff-removed', 'gitDecoration.deletedResourceForeground'),
        strikeThrough: true,
        letter: 'D',
      };
    case 'R':
      return { icon: themeIcon('diff-renamed', 'gitDecoration.renamedResourceForeground'), letter: 'R' };
    case 'C':
      return { icon: themeIcon('diff-added', 'gitDecoration.renamedResourceForeground'), letter: 'C' };
    default:
      return { icon: themeIcon('diff-modified', 'gitDecoration.modifiedResourceForeground'), letter: 'M' };
  }
}

export function tooltipFor(entry: StatusEntry, group: GroupId): string {
  const code = shortCode(entry);
  const rename = entry.origPath !== undefined ? ` ← ${entry.origPath}` : '';
  const groupName =
    group === 'merge'
      ? vscode.l10n.t('Merge conflict')
      : group === 'staged'
        ? vscode.l10n.t('Staged')
        : group === 'untracked'
          ? vscode.l10n.t('Untracked')
          : vscode.l10n.t('Changed');
  return `${entry.path}${rename} — ${groupName} (${code})`;
}

export function decorationsFor(entry: StatusEntry, group: GroupId): vscode.SourceControlResourceDecorations {
  const v = visualFor(entry, group);
  const deco: vscode.SourceControlResourceDecorations & {
    iconPath?: vscode.ThemeIcon;
    light?: { iconPath: vscode.ThemeIcon };
    dark?: { iconPath: vscode.ThemeIcon };
  } = {
    strikeThrough: v.strikeThrough ?? false,
    faded: v.faded ?? false,
    tooltip: tooltipFor(entry, group),
    iconPath: v.icon,
  };
  return deco;
}

/** contextValue for menu `when` clauses, e.g. `file:staged:R`. */
export function contextValueFor(entry: StatusEntry, group: GroupId): string {
  const v = visualFor(entry, group);
  return `file:${group}:${v.letter}`;
}
