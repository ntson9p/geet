/**
 * POST-P14cr: Geet: Getting Started Walkthrough opens the walkthrough of the
 * extension that is running, whatever its publisher and name. It named
 * `gittree.gittree`, which the Marketplace's `ntson9p.geet` is not.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WALKTHROUGH, walkthroughId } from '../../../src/onboarding/walkthrough';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
  name: string;
  publisher: string;
  contributes: { walkthroughs: Array<{ id: string }> };
};

describe('walkthroughId', () => {
  it('is the extension ID, then # and the walkthrough package.json contributes', () => {
    // The walkthrough's own id starts with `geet.`, as every contributed ID does (POST-P14cy).
    expect(walkthroughId('ntson9p.geet')).toBe('ntson9p.geet#geet.gettingStarted');
    expect(walkthroughId('someone.geet')).toBe('someone.geet#geet.gettingStarted');
  });

  it("names the manifest's walkthrough, and the manifest's extension ID makes the one VS Code knows", () => {
    expect(pkg.contributes.walkthroughs.map((w) => w.id)).toContain(WALKTHROUGH);
    expect(walkthroughId(`${pkg.publisher}.${pkg.name}`)).toBe(`${pkg.publisher}.${pkg.name}#${WALKTHROUGH}`);
  });
});
