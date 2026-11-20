/**
 * P14-T6 one-shot migration: hand `git.enabled` back.
 *
 * Until P14, consenting to "takeover" wrote `"git.enabled": false` into the
 * workspace settings so the built-in Git extension would stop competing for
 * VS Code's SCM surfaces. Geet no longer wants those surfaces, so the
 * override has no purpose — and deleting `ModeManager` without undoing it
 * would strand those workspaces with the built-in extension permanently off
 * and nothing left in the codebase that knows why.
 *
 * This is the ONLY `git.*` write Geet still performs, it exists solely to
 * undo an earlier one of its own, and it is deleted along with this module a
 * release later. It never sets `git.enabled` to a value — only removes the
 * override, so a user who set `false` themselves at a different scope keeps it.
 */

/** Where `ModeManager` persisted its decision. */
export const MODE_STATE_KEY = 'gittree.mode';
/** Set once the migration has run, so later activations cost nothing. */
export const MIGRATION_DONE_KEY = 'gittree.migration.unsetGitEnabled';

export type MigrationOutcome = 'already-done' | 'nothing-to-undo' | 'restored';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface UnsetGitEnabledDeps {
  workspaceState: MementoLike;
  /**
   * Removes Geet's workspace `git.enabled` override. Injected rather than
   * called directly so the state machine is unit-testable without a window.
   */
  clearBuiltinGitEnabled(): Promise<void>;
  /** Non-modal — this is an explanation, not a question. */
  notify(message: string): void;
  trace?(line: string): void;
}

export async function migrateUnsetGitEnabled(
  deps: UnsetGitEnabledDeps,
): Promise<MigrationOutcome> {
  if (deps.workspaceState.get<boolean>(MIGRATION_DONE_KEY) === true) return 'already-done';

  const mode = deps.workspaceState.get<string>(MODE_STATE_KEY);
  if (mode !== 'takeover') {
    // This workspace never consented, so nothing was ever written. Record
    // completion anyway: the check should not run on every activation forever.
    await deps.workspaceState.update(MIGRATION_DONE_KEY, true);
    return 'nothing-to-undo';
  }

  // Order matters: clear the override first. If that write fails the migration
  // is not marked done, so the next activation tries again rather than leaving
  // the user with the built-in extension silently disabled.
  await deps.clearBuiltinGitEnabled();
  await deps.workspaceState.update(MODE_STATE_KEY, undefined);
  await deps.workspaceState.update(MIGRATION_DONE_KEY, true);
  deps.trace?.('takeover migration: git.enabled override removed');
  deps.notify(
    'Geet no longer needs the built-in Git extension disabled — it has its own views, ' +
      'change bars and commit window now. The "git.enabled" override this workspace was ' +
      'carrying has been removed.',
  );
  return 'restored';
}
