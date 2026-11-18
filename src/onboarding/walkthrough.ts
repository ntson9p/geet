/**
 * The Getting Started walkthrough's full ID, which `workbench.action.openWalkthrough`
 * takes: `<extension ID>#<walkthrough id>`. Vscode-free, for the unit tests.
 */

/** `contributes.walkthroughs[0].id` in package.json. */
export const WALKTHROUGH = 'gittree.gettingStarted';

/**
 * The extension ID is the running one's, never written down: it is
 * `<publisher>.gittree`, and the publisher changed for the Marketplace
 * (`gittree` → `ntson9p`, POST-P14cr), which left the old literal opening nothing.
 */
export function walkthroughId(extensionId: string): string {
  return `${extensionId}#${WALKTHROUGH}`;
}
