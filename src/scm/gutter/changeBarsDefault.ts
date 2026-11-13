/**
 * POST-P14cc: GitTree's change bars are not drawn unless asked for
 * (`gittree.changeBars.enabled`). VS Code's built-in Git draws its own bars on
 * the same changed lines (`scm.diffDecorations: all`, its default), so with
 * both every changed line had two, and the two could disagree: VS Code calling
 * a line modified where GitTree called it added. GitTree's change actions (its
 * popup, `Ctrl+Alt+G H`, and Next / Previous Change) read the changes, not the
 * bars, and work either way.
 *
 * Not "on unless the built-in extension is running": D22 rejected GitTree
 * changing its behaviour by another extension's state. Free of `vscode`, so a
 * unit test holds package.json's default to it.
 */
export const CHANGE_BARS_SETTING = 'changeBars.enabled';
export const CHANGE_BARS_DEFAULT = false;
