/**
 * POST-P14cr: the Marketplace channel a version is for — odd minor pre-release,
 * even minor stable (docs/releasing.md) — as `npm run package` and the release
 * workflow's verify job both read it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseChannel } from '../../../scripts/releaseChannel.mjs';

const root = path.resolve(__dirname, '../../..');

describe('releaseChannel', () => {
  it('an odd minor is a pre-release', () => {
    expect(releaseChannel('0.1.0')).toBe('pre-release');
    expect(releaseChannel('0.3.12')).toBe('pre-release');
    expect(releaseChannel('2.11.0')).toBe('pre-release');
  });

  it('an even minor is a stable release, 0 included', () => {
    expect(releaseChannel('0.2.0')).toBe('stable');
    expect(releaseChannel('0.0.1')).toBe('stable');
    expect(releaseChannel('1.0.0')).toBe('stable');
    expect(releaseChannel('0.10.3')).toBe('stable');
  });

  it('refuses what the Marketplace refuses: a suffix, or not three numbers', () => {
    for (const bad of ['0.1.0-beta.1', '0.2.0+build.5', '0.1', '1', 'v0.1.0', '01.1.0', '0.1.0 ', '']) {
      expect(() => releaseChannel(bad), bad).toThrow(/major\.minor\.patch/u);
    }
  });

  it("package.json's version is one the Marketplace takes, packaged on its channel by npm run package", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
      scripts: Record<string, string>;
    };
    expect(() => releaseChannel(pkg.version)).not.toThrow();
    // Not `vsce package --pre-release` whatever the version, as it was.
    expect(pkg.scripts['package']).toBe('node scripts/package.mjs');
    expect(pkg.scripts['postpackage']).toBe('node scripts/checkBundleSize.mjs');
  });
});
