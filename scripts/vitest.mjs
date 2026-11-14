/**
 * `npm run test:unit`: Vitest, started from the upper-case form of the drive
 * letter.
 *
 * On Windows, Vitest 4 loads two copies of its own runtime when the working
 * directory's drive letter is lower case (`d:\Code\…`), as Git Bash and the
 * terminal of a VS Code window can give it. It then finds no tests in any
 * file, or fails each with "Vitest failed to find the current suite"
 * (vitest-dev/vitest#10692 and #11872, open). Node keeps one module per URL,
 * and `file:///d:/…` is not `file:///D:/…`. Vitest 3 had been fixed for this
 * (#6779); Vitest 4's module runner brought it back. Anywhere else, and with
 * an upper-case drive letter, this changes nothing.
 *
 * Go back to plain `vitest run` once Vitest keeps one casing itself.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { upperDriveLetter } from './driveLetter.mjs';

const cwd = process.cwd();
const root = upperDriveLetter(cwd);
if (root !== cwd) process.chdir(root);

// Vitest's own entry, found from the upper-case root so its URL has that casing too.
const require = createRequire(path.join(root, 'package.json'));
const manifest = require.resolve('vitest/package.json');
const { bin } = require(manifest);
const entry = path.join(path.dirname(manifest), typeof bin === 'string' ? bin : bin.vitest);
await import(pathToFileURL(entry).href);
