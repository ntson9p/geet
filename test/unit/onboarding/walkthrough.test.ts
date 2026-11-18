/**
 * POST-P14cr: GitTree: Getting Started Walkthrough opens the walkthrough of the
 * extension that is running, whatever its publisher. It named `gittree.gittree`,
 * which the Marketplace's `ntson9p.gittree` is not.
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
    expect(walkthroughId('ntson9p.gittree')).toBe('ntson9p.gittree#gittree.gettingStarted');
    expect(walkthroughId('someone.gittree')).toBe('someone.gittree#gittree.gettingStarted');
  });

  it("names the manifest's walkthrough, and the manifest's extension ID makes the one VS Code knows", () => {
    expect(pkg.contributes.walkthroughs.map((w) => w.id)).toContain(WALKTHROUGH);
    expect(walkthroughId(`${pkg.publisher}.${pkg.name}`)).toBe(`${pkg.publisher}.${pkg.name}#${WALKTHROUGH}`);
  });
});
