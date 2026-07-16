/**
 * Marketplace/README asset capture (P10-T3) — NOT part of the test gate.
 * Run manually with GITTREE_CAPTURE=1 to (re)generate:
 *   media/screens/log.png, media/screens/rebase.png, media/icon.png
 * Renders the real webview bundles against the mock hosts under a dark
 * VS Code variable set, so the images are the product's actual UI.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type Page } from '@playwright/test';
import { mockLogHostScript } from './mockLogHost';
import { mockRebaseHostScript } from './mockRebaseHost';

const capture = process.env['GITTREE_CAPTURE'] === '1';
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const out = (...p: string[]): string => path.resolve(testsDir, '..', '..', ...p);

/** The --vscode-* palette of the Dark Modern theme (subset the apps use). */
const DARK_VARS = `
  body {
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1f1f1f;
    --vscode-font-family: "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-icon-foreground: #cccccc;
    --vscode-focusBorder: #0078d4;
    --vscode-panel-border: #2b2b2b;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-input-placeholderForeground: #989898;
    --vscode-badge-background: #616161;
    --vscode-badge-foreground: #f8f8f8;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-activeSelectionBackground: #04395e;
    --vscode-list-activeSelectionForeground: #ffffff;
    --vscode-toolbar-hoverBackground: #2a2d2e;
    --vscode-inputOption-activeBackground: #2489db66;
    --vscode-inputOption-activeForeground: #ffffff;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-textLink-foreground: #4daafc;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-editorError-foreground: #f14c4c;
  }
`;

async function darken(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.className = 'vscode-dark';
  });
  await page.addStyleTag({ content: DARK_VARS });
}

test.describe('asset capture (manual: GITTREE_CAPTURE=1)', () => {
  test.skip(!capture, 'asset capture is a manual, on-demand step');

  test('log screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript(mockLogHostScript);
    await page.goto('/log.html');
    await darken(page);
    await page.getByTestId('log-row-0').waitFor();
    await page.locator('[data-gt-row="1"]').click();
    await page.getByTestId('details-panel').waitFor();
    await page.waitForTimeout(400); // graph canvas settles
    await page.screenshot({ path: out('media', 'screens', 'log.png') });
  });

  test('rebase screenshot', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript(mockRebaseHostScript);
    await page.goto('/rebase.html');
    await darken(page);
    await page.getByRole('listbox', { name: 'Rebase plan' }).waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ path: out('media', 'screens', 'rebase.png') });
  });

  test('marketplace icon (svg → 256px png)', async ({ page }) => {
    await page.setViewportSize({ width: 256, height: 256 });
    await page.setContent(`<!doctype html><body style="margin:0">
      <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
        <rect width="256" height="256" rx="56" fill="#1e2227"/>
        <g fill="none" stroke-linecap="round">
          <path d="M88 56v144" stroke="#0072b2" stroke-width="14"/>
          <path d="M88 104c0 36 80 22 80 56v40" stroke="#e69f00" stroke-width="14"/>
          <circle cx="88" cy="56" r="20" fill="#0072b2"/>
          <circle cx="88" cy="200" r="20" fill="#0072b2"/>
          <circle cx="168" cy="200" r="20" fill="#e69f00"/>
        </g>
      </svg></body>`);
    await page.screenshot({ path: out('media', 'icon.png') });
  });
});
