/**
 * The Getting Started walkthrough's full ID, which `workbench.action.openWalkthrough`
 * takes: `<extension ID>#<walkthrough id>`. Vscode-free, for the unit tests.
 */

/** `contributes.walkthroughs[0].id` in package.json. */
export const WALKTHROUGH = 'geet.gettingStarted';

/**
 * The extension ID is the running one's, never written down: it is
 * `<publisher>.<name>`, and both changed for the Marketplace (the publisher in
 * POST-P14cr, the name with the rename to Geet in POST-P14ct), which left the
 * old literal opening nothing. Not even this comment names an ID: a unit test
 * (`marketplace.test.ts`) fails on any in src/.
 */
export function walkthroughId(extensionId: string): string {
  return `${extensionId}#${WALKTHROUGH}`;
}
