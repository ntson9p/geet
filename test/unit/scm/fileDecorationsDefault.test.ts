/**
 * POST-P14bz: GitTree's file decorations are off until asked for. VS Code shows
 * every extension's decorations in every view, its own Source Control view
 * included, and joins two badges for one file: with the built-in Git extension
 * running, GitTree's doubled every letter there (`U, U`).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLORER_DECORATIONS_DEFAULT } from '../../../src/scm/fileDecorationsDefault';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { configuration: Array<{ properties: Record<string, { type?: string; default?: unknown; description?: string }> }> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
const setting = manifest.contributes.configuration
  .map((section) => section.properties['gittree.decorations.fileExplorer'])
  .find((s) => s !== undefined);

describe('GitTree file decorations (POST-P14bz)', () => {
  it('are off by default, in the code as in package.json', () => {
    expect(EXPLORER_DECORATIONS_DEFAULT).toBe(false);
    expect(setting?.type).toBe('boolean');
    expect(setting?.default).toBe(EXPLORER_DECORATIONS_DEFAULT);
  });

  it('say where they show, why they start off, and when to turn them on', () => {
    const key = /^%(.+)%$/u.exec(setting?.description ?? '')?.[1];
    const text = key !== undefined ? nls[key] : undefined;
    expect(text).toBeDefined();
    expect(text).toContain("VS Code's own Source Control view");
    expect(text).toContain('U, U');
    expect(text).toContain('Turn it on if you disable the built-in Git extension');
  });
});
