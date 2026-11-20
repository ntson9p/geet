/**
 * `npm run package`: `vsce package` on the channel package.json's version
 * names (POST-P14cr) — `--pre-release` for an odd minor, none for an even one
 * (`releaseChannel.mjs`). It used to pass `--pre-release` always, so a stable
 * release's VSIX would have been marked pre-release. Extra arguments go on to
 * vsce (`npm run package -- -o out.vsix`); `postpackage` then checks the
 * bundle budget on the VSIX this writes to the project's root.
 *
 * Started from the upper-case form of the drive letter: vsce runs `npm list`,
 * which crashes from a lower-case one on Windows (docs/releasing.md).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upperDriveLetter } from './driveLetter.mjs';
import { releaseChannel } from './releaseChannel.mjs';

const root = upperDriveLetter(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const channel = releaseChannel(version);

const require = createRequire(path.join(root, 'package.json'));
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const args = ['package', ...(channel === 'pre-release' ? ['--pre-release'] : []), ...process.argv.slice(2)];

console.log(`package: ${version} is a ${channel} (${channel === 'pre-release' ? 'odd' : 'even'} minor): vsce ${args.join(' ')}`);
const result = spawnSync(process.execPath, [vsce, ...args], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
