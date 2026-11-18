/**
 * GitTree's extension ID as VS Code knows it: `<publisher>.<name>` from the
 * package.json above this file. Read, not written down, so a change of
 * publisher (`gittree` until the Marketplace release, POST-P14cr) cannot leave
 * a suite looking for an extension that is no longer there.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function readExtensionId(): string {
  // Compiled to out/test/…, so the manifest is a few folders up.
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; publisher?: unknown };
      if (pkg.name === 'gittree' && typeof pkg.publisher === 'string') return `${pkg.publisher}.${pkg.name}`;
    }
    if (path.dirname(dir) === dir) throw new Error(`GitTree's package.json not found above ${__dirname}`);
  }
}

export const EXTENSION_ID: string = readExtensionId();
