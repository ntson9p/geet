/**
 * Marketplace icon capture (P10-T3) — NOT part of the test gate.
 * Run manually with GEET_CAPTURE=1 to (re)generate media/icon.png from
 * media/icon.svg, and each stored alternative's icon.png from its icon.svg
 * (docs/icon-alternatives/, POST-P14cz).
 *
 * The README's screenshots are no longer taken here, against the mock hosts:
 * `npm run screenshots` takes them in a real VS Code with real repositories
 * (docs/screenshots.md, POST-P14cs).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, test } from '@playwright/test';

const capture = process.env['GEET_CAPTURE'] === '1';
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const out = (...p: string[]): string => path.resolve(testsDir, '..', '..', ...p);

/** Renders `dir`/icon.svg to `dir`/icon.png at 256px. */
async function renderIcon(page: Page, dir: string): Promise<void> {
  // Rasterises the SVG rather than restating it, so the PNG cannot drift
  // away from the vector the rest of the icon family is cut from.
  const svg = await readFile(path.join(dir, 'icon.svg'), 'utf8');
  await page.setViewportSize({ width: 256, height: 256 });
  await page.setContent(
    `<!doctype html><body style="margin:0">
     <style>svg { display: block; width: 256px; height: 256px }</style>
     ${svg}</body>`,
  );
  // The tile is a rounded rect: keep its corners transparent, not page-white.
  await page.screenshot({ path: path.join(dir, 'icon.png'), omitBackground: true });
}

test.describe('asset capture (manual: GEET_CAPTURE=1)', () => {
  test.skip(!capture, 'asset capture is a manual, on-demand step');

  test('marketplace icon (svg → 256px png)', async ({ page }) => {
    await renderIcon(page, out('media'));
  });

  test('stored icon alternatives (svg → 256px png)', async ({ page }) => {
    const store = out('docs', 'icon-alternatives');
    const folders = (await readdir(store, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const folder of folders) await renderIcon(page, path.join(store, folder.name));
  });
});
