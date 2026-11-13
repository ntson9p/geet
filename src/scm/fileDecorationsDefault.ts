/**
 * Whether GitTree decorates files (`gittree.decorations.fileExplorer`) before
 * anyone sets it: off (POST-P14bz). Pure and vscode-free, so the default is
 * unit-tested against package.json's, which must say the same.
 *
 * A file decoration is shown wherever VS Code shows that file: its Explorer,
 * its editor tabs and breadcrumbs, and its own Source Control view. No API
 * keeps an extension's decoration out of any of them, and VS Code joins two
 * providers' badges for one file. With the built-in Git extension running, as
 * it does by default, GitTree's were a second copy of its own everywhere:
 * `U, U`, `M, M`. Off, GitTree adds nothing to VS Code's views.
 */
export const EXPLORER_DECORATIONS_DEFAULT = false;
