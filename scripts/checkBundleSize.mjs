/**
 * Bundle-size budget (P10-T5, master §13-adjacent): the packaged VSIX must
 * stay under 2.5 MB excluding images. Runs automatically after every
 * `npm run package` (postpackage hook) and in the release workflow.
 *
 * "Sans images" is implemented by subtracting the on-disk size of media/
 * raster assets (png) that vsce included — screenshots are marketing, not
 * runtime payload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_BYTES = 2.5 * 1024 * 1024;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vsix = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.vsix'))
  .map((f) => path.join(root, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

if (!vsix) {
  console.error('checkBundleSize: no .vsix found — run npm run package first');
  process.exit(1);
}

const vsixBytes = fs.statSync(vsix).size;

let imageBytes = 0;
const screens = path.join(root, 'media');
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(png|jpe?g|gif)$/i.test(e.name)) imageBytes += fs.statSync(full).size;
  }
};
if (fs.existsSync(screens)) walk(screens);

const effective = Math.max(0, vsixBytes - imageBytes);
const mb = (n) => (n / (1024 * 1024)).toFixed(2);
console.log(
  `checkBundleSize: ${path.basename(vsix)} = ${mb(vsixBytes)} MB (${mb(imageBytes)} MB images) → ${mb(effective)} MB effective, budget ${mb(BUDGET_BYTES)} MB`,
);
if (effective > BUDGET_BYTES) {
  console.error('checkBundleSize: OVER BUDGET');
  process.exit(1);
}
