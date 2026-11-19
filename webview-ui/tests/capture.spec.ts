/**
 * Marketplace icon capture (P10-T3) — NOT part of the test gate.
 * Run manually with GITTREE_CAPTURE=1 to (re)generate media/icon.png from
 * media/icon.svg.
 *
 * The README's screenshots are no longer taken here, against the mock hosts:
 * `npm run screenshots` takes them in a real VS Code with real repositories
 * (docs/screenshots.md, POST-P14cs).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const capture = process.env['GITTREE_CAPTURE'] === '1';
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const out = (...p: string[]): string => path.resolve(testsDir, '..', '..', ...p);

test.describe('asset capture (manual: GITTREE_CAPTURE=1)', () => {
  test.skip(!capture, 'asset capture is a manual, on-demand step');

  test('marketplace icon (svg → 256px png)', async ({ page }) => {
    // Rasterises media/icon.svg rather than restating it, so the PNG cannot
    // drift away from the vector the rest of the icon family is cut from.
    const svg = await readFile(out('media', 'icon.svg'), 'utf8');
    await page.setViewportSize({ width: 256, height: 256 });
    await page.setContent(
      `<!doctype html><body style="margin:0">
       <style>svg { display: block; width: 256px; height: 256px }</style>
       ${svg}</body>`,
    );
    // The tile is a rounded rect: keep its corners transparent, not page-white.
    await page.screenshot({ path: out('media', 'icon.png'), omitBackground: true });
  });
});
