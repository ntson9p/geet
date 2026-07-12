/**
 * Rebase plan → todo-list serialization (P5-T1 step 2). Pure — no vscode —
 * so the encoding rules are unit-testable.
 *
 * Message edits never rely on GIT_EDITOR: every reword / squash-with-message
 * becomes a `pick`/`fixup` group followed by
 * `exec git commit --amend --no-verify -F "<msg file>"`, with the message
 * written to a file beforehand. Deterministic and prompt-free on every OS.
 */

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface RebasePlanEntry {
  /** Full sha (never abbreviated — todo files survive gc that way). */
  sha: string;
  action: RebaseAction;
  /**
   * New commit message. Required for `reword`; for `squash` it is the
   * combined message (the last message provided within a squash group wins).
   * Ignored for `fixup` and `drop`.
   */
  message?: string;
}

export interface RebasePlan {
  /** Rebase onto this sha — entries cover `baseSha..HEAD`, oldest first. */
  baseSha: string;
  entries: RebasePlanEntry[];
}

export interface SerializedPlan {
  /** Content of the todo file handed to git via the sequence-editor shim. */
  todo: string;
  /** Message files to write next to the plan (name → content). */
  messageFiles: Array<{ name: string; content: string }>;
}

/**
 * Validation shared with the T2 dialog. Returns human-readable issues;
 * an empty array means the plan is serializable.
 */
export function validatePlan(plan: RebasePlan): string[] {
  const issues: string[] = [];
  if (plan.entries.length === 0) {
    issues.push('The plan is empty.');
    return issues;
  }
  if (plan.entries.every((e) => e.action === 'drop')) {
    issues.push('All commits are dropped — nothing would remain to rebase.');
  }
  // Squash/fixup targets the previous kept row; rows before the first kept
  // pick have nothing to squash into.
  const firstKept = plan.entries.find((e) => e.action !== 'drop');
  if (firstKept !== undefined && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
    issues.push('The first commit cannot be squashed or fixed up — there is nothing before it.');
  }
  for (const e of plan.entries) {
    if (!/^[0-9a-f]{40,64}$/.test(e.sha)) {
      issues.push(`"${e.sha}" is not a full commit sha.`);
    }
    if (e.action === 'reword' && (e.message === undefined || e.message.trim().length === 0)) {
      issues.push(`Reword of ${e.sha.slice(0, 7)} has no message.`);
    }
  }
  return issues;
}

/**
 * Serializes the plan. `msgDirPosix` is the forward-slash absolute directory
 * the message files will live in (forward slashes work in git's sh on every
 * platform, including `C:/...` on Windows).
 *
 * Encoding rules:
 * - `pick`   → `pick <sha>`
 * - `drop`   → `drop <sha>`
 * - `reword` → `pick <sha>` + exec-amend with its message file
 * - `squash`/`fixup` → `fixup <sha>` attached to the previous non-drop row;
 *   if any squash in the group carries a message, one exec-amend with the
 *   combined message follows the group (fixup-only groups keep the target's
 *   message and get no exec line).
 */
export function serializePlan(plan: RebasePlan, msgDirPosix: string): SerializedPlan {
  const issues = validatePlan(plan);
  if (issues.length > 0) {
    throw new Error(`invalid rebase plan: ${issues.join(' ')}`);
  }

  const lines: string[] = [];
  const messageFiles: Array<{ name: string; content: string }> = [];

  const execAmend = (message: string): string => {
    const name = `msg-${messageFiles.length + 1}.txt`;
    messageFiles.push({ name, content: message.endsWith('\n') ? message : `${message}\n` });
    return `exec git commit --amend --no-verify -F "${msgDirPosix}/${name}"`;
  };

  // A "group" is a kept head (pick/reword) plus its squash/fixup members.
  // Drop lines may interleave — git's fixup targets the previous *picked*
  // commit, so a drop between members does not end the group.
  let inGroup = false;
  let pendingMessage: string | undefined;
  const flushGroup = (): void => {
    if (inGroup && pendingMessage !== undefined) {
      lines.push(execAmend(pendingMessage));
    }
    inGroup = false;
    pendingMessage = undefined;
  };

  for (const e of plan.entries) {
    switch (e.action) {
      case 'drop':
        lines.push(`drop ${e.sha}`);
        break;
      case 'pick':
      case 'reword':
        flushGroup();
        // Head rows are always emitted as `pick`; rewording happens via exec.
        lines.push(`pick ${e.sha}`);
        inGroup = true;
        if (e.action === 'reword') pendingMessage = e.message;
        break;
      case 'squash':
      case 'fixup':
        lines.push(`fixup ${e.sha}`);
        if (e.action === 'squash' && e.message !== undefined && e.message.trim().length > 0) {
          pendingMessage = e.message; // last provided combined message wins
        }
        break;
    }
  }
  flushGroup();

  return { todo: lines.join('\n') + '\n', messageFiles };
}
