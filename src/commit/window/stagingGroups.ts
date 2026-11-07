/**
 * The Commit window's tree in the staging paradigm (POST-QA F5): IntelliJ's
 * staging-area nodes — Merge Conflicts, Staged, Unstaged, Unversioned Files —
 * instead of changelists.
 *
 * The window kept drawing changelists and their ticks in staging mode while
 * Commit committed the index: "7 of 10 files" ticked, one staged file
 * committed. Here nothing is ticked; a file is in the commit by being in the
 * Staged node, and a file staged in part sits in both Staged and Unstaged, as
 * in IntelliJ. Pure and vscode-free: the names come in already translated.
 */
import {
  isConflicted,
  isStaged,
  isUnstaged,
  isUntracked,
  shortCode,
  type StatusEntry,
} from '../../core/model/statusEntry';
import {
  CONFLICTS_GROUP_ID,
  STAGED_GROUP_ID,
  UNSTAGED_GROUP_ID,
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitGroupDto,
} from '../../shared/protocol';

export interface StagingGroupNames {
  readonly conflicts: string;
  readonly staged: string;
  readonly unstaged: string;
  readonly unversioned: string;
}

/** One side's status letter as a row colour: the index's for Staged, the worktree's for Unstaged. */
function kindOf(code: string): CommitChangeDto['kind'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

function group(id: string, name: string, changes: CommitChangeDto[]): CommitGroupDto {
  return { id, name, isActive: false, isDefault: false, checkable: false, changes };
}

/**
 * The staging-mode groups for one repository's status, empty groups left out.
 * Staged rows are the ones counted as "in the commit" (`checked`), which is
 * what the window's counter and its Commit button read.
 */
export function stagingGroups(entries: readonly StatusEntry[], names: StagingGroupNames): CommitGroupDto[] {
  const path = (p: string): string => p.replace(/\\/g, '/');
  const conflicts: CommitChangeDto[] = [];
  const staged: CommitChangeDto[] = [];
  const unstaged: CommitChangeDto[] = [];
  const unversioned: CommitChangeDto[] = [];
  for (const e of entries) {
    if (isConflicted(e)) {
      conflicts.push({ path: path(e.path), code: shortCode(e), kind: 'conflicted', checked: false });
      continue;
    }
    if (isUntracked(e)) {
      unversioned.push({ path: path(e.path), code: '??', kind: 'untracked', checked: false });
      continue;
    }
    if (isStaged(e)) {
      staged.push({
        path: path(e.path),
        code: `${e.x}.`,
        kind: kindOf(e.x),
        checked: true,
        ...(e.origPath !== undefined ? { origPath: path(e.origPath) } : {}),
      });
    }
    if (isUnstaged(e)) {
      unstaged.push({ path: path(e.path), code: `.${e.y}`, kind: kindOf(e.y), checked: false });
    }
  }
  const out: CommitGroupDto[] = [];
  if (conflicts.length > 0) out.push(group(CONFLICTS_GROUP_ID, names.conflicts, conflicts));
  if (staged.length > 0) out.push(group(STAGED_GROUP_ID, names.staged, staged));
  if (unstaged.length > 0) out.push(group(UNSTAGED_GROUP_ID, names.unstaged, unstaged));
  if (unversioned.length > 0) out.push(group(UNVERSIONED_GROUP_ID, names.unversioned, unversioned));
  return out;
}
