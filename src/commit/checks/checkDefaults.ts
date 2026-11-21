/**
 * What the commit-options popup's check boxes read before anyone has ticked
 * them (pure; vscode-free). IntelliJ ticks Analyze code and Check TODO; Geet
 * ticks none, so a commit runs no check until the user asks for one (D38).
 * package.json's `geet.commit.checks.*` defaults must say the same.
 */
import type { CommitOptionsDto } from '../../shared/protocol';

export type CheckId = keyof CommitOptionsDto['checks'];

export const CHECK_DEFAULTS: Readonly<CommitOptionsDto['checks']> = Object.freeze({
  reformat: false,
  optimizeImports: false,
  cleanup: false,
  analyze: false,
  todo: false,
});

/**
 * *Run advanced checks after a commit is done* (`geet.commit.checks.deferAdvanced`)
 * before anyone has ticked it: unticked (POST-P14bv, the owner's request; IntelliJ
 * ticks it). A ticked Analyze code or Check TODO then runs before the commit, as
 * the other checks do, and a finding asks Review… / Commit Anyway / Cancel. It
 * is no check itself, so it is not in `CHECK_DEFAULTS`. package.json's default
 * must say the same.
 */
export const DEFER_ADVANCED_DEFAULT = false;
