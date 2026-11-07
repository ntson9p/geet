/**
 * What the commit-options popup's check boxes read before anyone has ticked
 * them (pure; vscode-free). IntelliJ ticks Analyze code and Check TODO; GitTree
 * ticks none, so a commit runs no check until the user asks for one (D38).
 * package.json's `gittree.commit.checks.*` defaults must say the same.
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
