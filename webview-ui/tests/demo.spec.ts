import { expect, test, type Page } from '@playwright/test';
import { mockVsCodeApiScript } from './mockVsCode';

async function openDemo(page: Page, bodyClass = 'vscode-dark'): Promise<void> {
  await page.addInitScript(mockVsCodeApiScript);
  await page.goto('/demo.html');
  await page.evaluate((cls) => {
    document.body.className = cls;
  }, bodyClass);
}

test.describe('P0-T9 webview platform kit', () => {
  test('renders theme-correct UI in dark, light and high contrast', async ({ page }) => {
    await openDemo(page, 'vscode-dark');
    await expect(page.getByTestId('theme-banner')).toContainText('dark');

    await page.evaluate(() => (document.body.className = 'vscode-light'));
    await expect(page.getByTestId('theme-banner')).toContainText('light');

    await page.evaluate(() => (document.body.className = 'vscode-high-contrast'));
    await expect(page.getByTestId('theme-banner')).toContainText('high-contrast');

    await page.evaluate(() => (document.body.className = 'vscode-high-contrast-light'));
    await expect(page.getByTestId('theme-banner')).toContainText('high-contrast-light');
  });

  test('RPC echo round-trips through the mocked host', async ({ page }) => {
    await openDemo(page);
    await page.getByRole('button', { name: 'Echo over RPC' }).click();
    await expect(page.getByTestId('echo-result')).toContainText('ping @');
  });

  test('VirtualList renders 100k rows windowed and scrolls smoothly', async ({ page }) => {
    await openDemo(page);
    const list = page.getByRole('listbox', { name: 'Demo rows' });
    await expect(list).toBeVisible();

    // Windowing: only a screenful of the 100k rows is in the DOM.
    const renderedCount = await list.locator('[data-gt-row]').count();
    expect(renderedCount).toBeLessThan(60);
    await expect(page.getByTestId('row-0')).toBeVisible();

    // Jump to the end via the imperative handle (toolbar button).
    await page.getByRole('button', { name: 'Jump to row 99,999' }).click();
    await expect(page.getByTestId('row-99999')).toBeVisible();
    await expect(page.getByTestId('focus-readout')).toHaveText('focused: 99999');

    // Smooth scrolling pass: sweep the middle of the list.
    await list.evaluate((el) => {
      el.scrollTop = 50_000 * 22;
    });
    await expect(page.getByTestId('row-50000')).toBeVisible();
    const midCount = await list.locator('[data-gt-row]').count();
    expect(midCount).toBeLessThan(60);
  });

  test('keyboard navigation: roving tabindex, arrows, Home/End', async ({ page }) => {
    await openDemo(page);
    await page.getByRole('button', { name: 'Jump to top' }).click();
    await expect(page.getByTestId('focus-readout')).toHaveText('focused: 0');

    const focusedRow = page.locator('[data-gt-row].gt-focused');
    await expect(focusedRow).toHaveAttribute('tabindex', '0');

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('focus-readout')).toHaveText('focused: 1');
    await page.keyboard.press('PageDown');
    const afterPage = await page.getByTestId('focus-readout').textContent();
    expect(Number(afterPage?.replace('focused: ', ''))).toBeGreaterThan(1);

    await page.keyboard.press('End');
    await expect(page.getByTestId('focus-readout')).toHaveText('focused: 99999');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('focus-readout')).toHaveText('focused: 0');
  });

  test('rows carry data-vscode-context for native menus', async ({ page }) => {
    await openDemo(page);
    const row0 = page.locator('[data-gt-row="0"]');
    await expect(row0).toHaveAttribute('data-vscode-context', JSON.stringify({ row: 0 }));
  });

  test('state persists through getState/setState', async ({ page }) => {
    await openDemo(page);
    await page.getByRole('switch', { name: 'Even rows only' }).click();
    const state = await page.evaluate(() => window.acquireVsCodeApi?.().getState());
    expect((state as { filterOn?: boolean }).filterOn).toBe(true);
  });
});
