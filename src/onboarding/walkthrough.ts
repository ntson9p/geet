/**
 * The Getting Started walkthrough's full ID, which `workbench.action.openWalkthrough`
 * takes: `<extension ID>#<walkthrough id>`. Vscode-free, for the unit tests.
 */

/** `contributes.walkthroughs[0].id` in package.json. */
export const WALKTHROUGH = 'gittree.gettingStarted';

/**
 * The extension ID is the running one's, never written down: it is
 * `<publisher>.<name>`, and both changed for the Marketplace (`gittree.gittree`
 * → `ntson9p.gittree`, POST-P14cr, → `ntson9p.geet`, POST-P14ct), which left the
 * old literal opening nothing.
 */
export function walkthroughId(extensionId: string): string {
  return `${extensionId}#${WALKTHROUGH}`;
}
