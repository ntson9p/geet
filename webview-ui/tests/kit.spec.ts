import { expect, test, type Page } from '@playwright/test';

/**
 * P11-T1 UI kit acceptance. The kit harness (`kit.html`) is dev-only; the kit
 * itself ships inside the commit window (P11-T2) and the dialogs (P11-T7, P13).
 */

async function openKit(page: Page, tab?: string): Promise<void> {
  await page.goto('/kit.html');
  if (tab !== undefined) await page.getByRole('tab', { name: tab }).click();
}

function row(page: Page, name: string) {
  return page.getByRole('treeitem', { name, exact: true });
}

test.describe('P11-T1 tree: folders, counts, tri-state', () => {
  test('collapses single-child chains and counts files on every node', async ({ page }) => {
    await openKit(page);
    // `src` -> `main` -> `java` renders as one row, which is what keeps
    // IntelliJ's trees shallow (gap analysis S12).
    await expect(row(page, 'src/main/java, 3 files')).toBeVisible();
    await expect(row(page, 'Changes, 5 files')).toBeVisible();
    await expect(row(page, 'api, 2 files')).toBeVisible();
    await expect(row(page, 'docs, 1 file')).toBeVisible();
    await expect(row(page, 'ArticleDataController.java')).toBeVisible();
  });

  test('a partially ticked directory reports mixed on every ancestor', async ({ page }) => {
    await openKit(page);
    const file = row(page, 'ArticleDataController.java');
    await file.locator('.gt-tree-check').click();

    await expect(page.getByTestId('checked-count')).toHaveText('checked: 1');
    await expect(file).toHaveAttribute('aria-checked', 'true');
    // This is the state TreeItemCheckboxState cannot express (S11).
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-checked', 'mixed');
    await expect(row(page, 'src/main/java, 3 files')).toHaveAttribute('aria-checked', 'mixed');
    await expect(row(page, 'Changes, 5 files')).toHaveAttribute('aria-checked', 'mixed');
    await expect(row(page, 'CommentController.java')).toHaveAttribute('aria-checked', 'false');
  });

  test('ticking a partial directory ticks its whole subtree, never the reverse', async ({ page }) => {
    await openKit(page);
    await row(page, 'ArticleDataController.java').locator('.gt-tree-check').click();
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-checked', 'mixed');

    await row(page, 'api, 2 files').locator('.gt-tree-check').click();
    await expect(page.getByTestId('checked-list')).toHaveText(
      'src/main/java/api/ArticleDataController.java,src/main/java/api/CommentController.java',
    );
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-checked', 'true');

    // Ticking the whole tree from the root, then clearing it.
    await row(page, 'Changes, 5 files').locator('.gt-tree-check').click();
    await expect(page.getByTestId('checked-count')).toHaveText('checked: 5');
    await row(page, 'Changes, 5 files').locator('.gt-tree-check').click();
    await expect(page.getByTestId('checked-count')).toHaveText('checked: 0');
  });

  test('ticking does not disturb a multi-selection', async ({ page }) => {
    await openKit(page);
    await row(page, 'ArticleDataController.java').click();
    await row(page, 'CommentController.java').click({ modifiers: ['Control'] });
    await expect(page.getByTestId('selection-list')).toHaveText(
      'src/main/java/api/ArticleDataController.java,src/main/java/api/CommentController.java',
    );

    await row(page, 'Strings.java').locator('.gt-tree-check').click();
    await expect(page.getByTestId('checked-count')).toHaveText('checked: 1');
    await expect(page.getByTestId('selection-list')).toHaveText(
      'src/main/java/api/ArticleDataController.java,src/main/java/api/CommentController.java',
    );
  });

  test('keyboard alone reaches, expands, collapses and ticks', async ({ page }) => {
    await openKit(page);
    await row(page, 'Changes, 5 files').click();

    // Left collapses the focused directory; the subtree leaves the DOM.
    await page.keyboard.press('ArrowLeft');
    await expect(row(page, 'docs, 1 file')).toHaveCount(0);
    await expect(row(page, 'Changes, 5 files')).toHaveAttribute('aria-expanded', 'false');

    // Right re-expands, Down walks into it.
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Changes, 5 files')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('checked-list')).toHaveText('docs/guide.md');

    // Left from a leaf moves to the parent rather than collapsing anything.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await expect(row(page, 'docs, 1 file')).toBeFocused();
  });

  test('rows expose tree semantics with level and selection', async ({ page }) => {
    await openKit(page);
    await expect(page.getByRole('tree', { name: 'Changed files' })).toBeVisible();
    await expect(row(page, 'Changes, 5 files')).toHaveAttribute('aria-level', '1');
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-level', '3');
    await expect(row(page, 'ArticleDataController.java')).toHaveAttribute('aria-level', '4');
  });
});

test.describe('P11-T1 menu', () => {
  test('opens submenus with the keyboard and returns a selection', async ({ page }) => {
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    await expect(menu).toBeVisible();

    // Down to the submenu row, Right to open it, Down+Enter to pick.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Compare' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('menu-picked')).toHaveText('compare-with');
    await expect(menu).toHaveCount(0);
  });

  test('a click picks an item in a submenu', async ({ page }) => {
    // The menu used to close on the press, since a submenu is drawn beside
    // its menu and not inside it, and the click then landed on nothing.
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    await menu.getByRole('menuitem', { name: 'Compare' }).click();
    const sub = page.getByRole('menu', { name: 'Compare' });
    await expect(sub).toBeVisible();
    await sub.getByRole('menuitem', { name: 'Show Diff with Working Tree' }).click();
    await expect(page.getByTestId('menu-picked')).toHaveText('diff-working');
    await expect(menu).toHaveCount(0);
    await expect(sub).toHaveCount(0);
  });

  test('a click outside a menu with a submenu open still closes both', async ({ page }) => {
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    await page.getByRole('menu', { name: 'Branch actions' }).getByRole('menuitem', { name: 'Compare' }).hover();
    await expect(page.getByRole('menu', { name: 'Compare' })).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.getByRole('menu', { name: 'Branch actions' })).toHaveCount(0);
    await expect(page.getByRole('menu', { name: 'Compare' })).toHaveCount(0);
    await expect(page.getByTestId('menu-picked')).not.toHaveText('diff-working');
  });

  test('interpolated labels, accelerators and disabled items render', async ({ page }) => {
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    // The direction of the operation must be unambiguous (gap analysis S3).
    await expect(page.getByRole('menuitem', { name: "Merge 'feature/f1-1' into 'master'" })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Rename...' })).toContainText('F2');
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  test('Escape dismisses without selecting', async ({ page }) => {
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Branch actions' })).toHaveCount(0);
    await expect(page.getByTestId('menu-picked')).toHaveText('');
  });
});

/**
 * new-way-6: a menu is drawn inside its webview and cannot leave it. A branch's
 * menu across twenty repositories ran off the foot of the sidebar, its last
 * rows out of the pointer's reach; past the webview's edges a menu scrolls,
 * and its labels end in `…`.
 */
test.describe('a menu bigger than its webview', () => {
  test('scrolls inside it, and the arrows bring the row they reach into view', async ({ page }) => {
    // 120px: room for five of the menu's rows, so its last ones are below the fold.
    await page.setViewportSize({ width: 360, height: 120 });
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(4 - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(120 - 4 + 0.5);
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // End: the last row that can be picked (Delete is disabled), scrolled into view.
    await page.keyboard.press('End');
    await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const rename = menu.getByRole('menuitem', { name: /^Rename/u });
    await expect(rename).toHaveClass(/gt-active/u);
    const row = (await rename.boundingBox())!;
    const shown = (await menu.boundingBox())!;
    expect(row.y).toBeGreaterThanOrEqual(shown.y - 0.5);
    expect(row.y + row.height).toBeLessThanOrEqual(shown.y + shown.height + 0.5);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('menu-picked')).toHaveText('rename');
  });

  test('Home goes back to the top of it', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 120 });
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    await page.keyboard.press('End');
    await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(() => menu.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(menu.getByRole('menuitem', { name: 'Checkout' })).toHaveClass(/gt-active/u);
  });

  test('a submenu whose row scrolls away closes', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 160 });
    await openKit(page, 'Menu');
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    await menu.getByRole('menuitem', { name: 'Compare' }).hover();
    await expect(page.getByRole('menu', { name: 'Compare' })).toBeVisible();
    await menu.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByRole('menu', { name: 'Compare' })).toHaveCount(0);
    await expect(menu).toBeVisible();
  });

  test('a narrow one ends long labels in … rather than running off its side', async ({ page }) => {
    // The kit's own tabs need the room; the menu is opened once the page is narrow.
    await openKit(page, 'Menu');
    await page.setViewportSize({ width: 200, height: 400 });
    await page.getByTestId('open-menu').click();
    const menu = page.getByRole('menu', { name: 'Branch actions' });
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(4 - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(200 - 4 + 0.5);
    const merge = menu.getByRole('menuitem', { name: "Merge 'feature/f1-1' into 'master'" });
    expect(await merge.locator('.gt-menu-label').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The accelerator at the row's end is still on show.
    const rename = (await menu.getByRole('menuitem', { name: /^Rename/u }).locator('.gt-menu-accel').boundingBox())!;
    expect(rename.x + rename.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  });
});

test.describe('P11-T1 splitter', () => {
  test('resizes from the keyboard and resets on double-click', async ({ page }) => {
    await openKit(page);
    const sash = page.getByRole('separator', { name: 'Tree and readout splitter' });
    await expect(page.getByTestId('ratio')).toHaveText('ratio: 0.62');

    // The rendered pane must follow the ratio, not just the readout: the pane
    // is deliberately unshrinkable so content cannot move it, and a frozen
    // pane would still report the right number while never actually resizing.
    const paneWidth = async () =>
      (await page.locator('.gt-split-pane').first().boundingBox())!.width;
    const wide = await paneWidth();

    await sash.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('ratio')).toHaveText('ratio: 0.58');
    expect(await paneWidth()).toBeLessThan(wide - 1);

    await sash.dblclick();
    await expect(page.getByTestId('ratio')).toHaveText('ratio: 0.62');
    expect(await paneWidth()).toBeCloseTo(wide, 1);
  });
});

test.describe('P11-T1 dialog', () => {
  test('focuses its body, traps Tab, and cancels on Escape', async ({ page }) => {
    await openKit(page, 'Dialog');
    await page.getByTestId('open-dialog').click();
    const dialog = page.getByRole('dialog', { name: 'Push Commits to demo-git' });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Initial focus lands in the body, not on the title bar's close button.
    await expect(page.getByTestId('dialog-input')).toBeFocused();

    // Tab from the last focusable wraps to the first — nothing escapes.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('dialog-input')).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-result')).toHaveText('cancel');
  });

  test('Enter fires the default action from a single-line field', async ({ page }) => {
    await openKit(page, 'Dialog');
    await page.getByTestId('open-dialog').click();
    await page.getByTestId('dialog-input').press('Enter');
    await expect(page.getByTestId('dialog-result')).toHaveText('push');
  });

  test('the split button opens its menu and dispatches', async ({ page }) => {
    await openKit(page, 'Dialog');
    await page.getByTestId('open-dialog').click();
    await page.getByRole('button', { name: 'Push options' }).click();
    await page.getByRole('menuitem', { name: 'Force Push...' }).click();
    await expect(page.getByTestId('dialog-result')).toHaveText('force-push');
  });

  test('footer carries options and a help affordance', async ({ page }) => {
    await openKit(page, 'Dialog');
    await page.getByTestId('open-dialog').click();
    await expect(page.getByRole('checkbox', { name: 'Run Git hooks' })).toBeChecked();
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.getByTestId('dialog-result')).toHaveText('help');
  });
});

test.describe('P11-T1 inline diff', () => {
  test('counts differences and included changes', async ({ page }) => {
    await openKit(page, 'Diff');
    await expect(page.getByTestId('diff-counter')).toHaveText('2 differences, 1 included');
  });

  test('per-change checkboxes drive the inclusion set', async ({ page }) => {
    await openKit(page, 'Diff');
    await page.getByTestId('diff-include-1').click();
    await expect(page.getByTestId('included-list')).toHaveText('0,1');
    await expect(page.getByTestId('diff-counter')).toHaveText('2 differences, 2 included');

    await page.getByTestId('diff-include-0').click();
    await expect(page.getByTestId('included-list')).toHaveText('1');
    await expect(page.getByTestId('diff-counter')).toHaveText('2 differences, 1 included');
  });

  test('aligns insertions against blank left-hand rows', async ({ page }) => {
    await openKit(page, 'Diff');
    await expect(page.locator('.gt-diff-added')).toHaveCount(2);
    await expect(page.locator('.gt-diff-context')).toHaveCount(3);
  });
});

test.describe('P11-T1 accessibility', () => {
  test('tri-state survives forced colors and reduced motion', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await openKit(page);
    await row(page, 'ArticleDataController.java').locator('.gt-tree-check').click();
    // The partial state draws a dash, so it is not carried by fill alone.
    const partial = row(page, 'api, 2 files').locator('.gt-tricheck-partial .gt-tricheck-dash');
    await expect(partial).toBeVisible();
  });

  test('tabs follow the ARIA tabs pattern', async ({ page }) => {
    await openKit(page);
    const tablist = page.getByRole('tablist', { name: 'Kit sections' });
    await expect(tablist).toBeVisible();
    await page.getByRole('tab', { name: 'Tree' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('diff-counter')).toBeVisible();
  });

  test('toolbar is one tab stop with arrow navigation', async ({ page }) => {
    await openKit(page);
    await page.getByRole('button', { name: 'Expand all' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Collapse all' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('button', { name: 'Expand all' })).toBeFocused();
  });
});

test.describe('Toolbar buttons answer the click', () => {
  test('a pressed toolbar button gives under the mouse and comes back on release', async ({ page }) => {
    await openKit(page);
    const button = page.getByRole('button', { name: 'Refresh', exact: true });
    const icon = button.locator('.codicon');
    const box = await button.boundingBox();
    if (!box) throw new Error('the Refresh button has no box');
    const transform = () => icon.evaluate((el) => getComputedStyle(el).transform);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Scaled down while held: matrix(0.85, 0, 0, 0.85, 0, 0) once settled.
    await expect.poll(transform).toMatch(/^matrix\(0\.85,/);
    await page.mouse.up();
    await expect.poll(transform).toBe('none');
  });
});
