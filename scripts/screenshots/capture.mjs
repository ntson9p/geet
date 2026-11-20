/**
 * `npm run screenshots`: takes the README's screenshots again
 * (docs/screenshots.md). It builds the extension, builds the demo
 * repositories (demo.mjs), opens them in a scratch VS Code with this checkout
 * as the extension under development (vscode.mjs), plays the scenes
 * (scenes.mjs) and writes their PNGs to docs/images/. VS Code and the demo
 * are thrown away afterwards; your own VS Code, settings and git
 * configuration are never used.
 *
 *   npm run screenshots                       every scene
 *   npm run screenshots -- --only log,merge   some of them (the set-up they need still runs)
 *   npm run screenshots -- --no-build         use dist/ as it is
 *   npm run screenshots -- --keep             leave VS Code's profile and the demo for a look
 *   npm run screenshots -- --work <folder>    where the demo and the profile go (default:
 *                                             C:\geet-screenshots on Windows, so no path
 *                                             in the images names you; <temp>/geet-screenshots
 *                                             elsewhere)
 *
 * An image that comes out the same is written byte for byte the same, so git
 * shows only the ones that really changed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upperDriveLetter } from '../driveLetter.mjs';
import { buildDemo, clearDemoFolder, defaultWorkFolder } from './demo.mjs';
import { createDriver } from './driver.mjs';
import { SCENES, prepare } from './scenes.mjs';
import { emulateViewport, launch, stop, VIEWPORT, VSCODE_VERSION, vscodeExecutable } from './vscode.mjs';

const root = upperDriveLetter(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
/** Where the images go: the README links them from here. */
export const IMAGES = path.join(root, 'docs', 'images');

const started = Date.now();
const log = (...a) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`, ...a);

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { only: /** @type {string[] | undefined} */ (undefined), build: true, keep: false, work: defaultWorkFolder() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--no-build') args.build = false;
    else if (a === '--keep') args.keep = true;
    else if (a === '--work') args.work = path.resolve(argv[++i] ?? '');
    else throw new Error(`unknown argument ${a} (see the top of scripts/screenshots/capture.mjs)`);
  }
  return args;
}

/** The production build VS Code runs: the extension and its webviews. */
function build() {
  for (const [what, cmd] of [
    ['extension', 'node esbuild.mjs --production'],
    ['webviews', 'npm run build:webviews'],
  ]) {
    log(`building the ${what}: ${cmd}`);
    const r = spawnSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error(`${cmd} failed`);
  }
}

/** @param {string} dir */
function readImages(dir) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) if (name.endsWith('.png')) out.set(name, fs.readFileSync(path.join(dir, name)));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = new Set(SCENES.map((s) => s.name));
  for (const name of args.only ?? []) if (!known.has(name)) throw new Error(`no scene "${name}"; there are: ${[...known].join(', ')}`);
  const scenes = args.only ? SCENES.filter((s) => args.only?.includes(s.name)) : SCENES;

  if (args.build) build();
  const before = readImages(IMAGES);
  log(`building the demo repositories in ${args.work}`);
  const demo = buildDemo(args.work);
  const exe = await vscodeExecutable(root);
  log(`starting VS Code ${VSCODE_VERSION} at ${VIEWPORT.width}×${VIEWPORT.height}, scale ${VIEWPORT.scale}`);
  const vscode = await launch({ root, exe, folder: demo.workspace, workDir: path.join(args.work, 'vscode'), env: demo.env });
  /** @type {string[]} */
  const failed = [];
  try {
    const cdp = await emulateViewport(vscode.page);
    const d = createDriver({ page: vscode.page, cdp, demo, outDir: IMAGES, log });
    await prepare(d, scenes);
    for (const scene of scenes) {
      log(`scene ${scene.name}: ${scene.title}`);
      try {
        await scene.run(d);
      } catch (error) {
        failed.push(scene.name);
        log(`scene ${scene.name} FAILED:`, error);
        await d.shot(path.join(args.work, `failed-${scene.name}.png`)).catch(() => undefined);
      }
      // Puts back what the scene changed, for the scenes after it.
      await scene.cleanUp?.(d).catch((error) => log(`scene ${scene.name}: its clean-up failed:`, error));
    }
  } finally {
    await stop(vscode);
  }
  // Kept after a failure, for its failed-<scene>.png and VS Code's logs.
  if (!args.keep && failed.length === 0) clearDemoFolder(args.work);

  const after = readImages(IMAGES);
  for (const scene of scenes) {
    for (const file of scene.files) {
      const now = after.get(file);
      const was = before.get(file);
      const state = !now ? 'MISSING' : !was ? 'new' : was.equals(now) ? 'unchanged' : 'changed';
      log(`${file.padEnd(20)} ${state}${now ? ` (${Math.round(now.length / 1024)} KB)` : ''}`);
    }
  }
  if (failed.length > 0) {
    log(`failed: ${failed.join(', ')} — the window at each failure is in ${path.join(args.work, 'failed-<scene>.png')}, and VS Code's logs in ${path.join(args.work, 'vscode', 'user-data', 'logs')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
