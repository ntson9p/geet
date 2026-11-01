import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockBranchesHostScript } from './mockBranchesHost';

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

const ALPHA = '/work/alpha';

async function openBranches(page: Page): Promise<void> {
  await page.addInitScript(mockBranchesHostScript);
  await page.goto('/branches.html');
  await expect(repoRow(page, 'alpha')).toBeVisible();
}

async function requests(page: Page, method: string): Promise<Array<Record<string, unknown>>> {
  const all = (await page.evaluate(
    () => (window as unknown as { __postedMessages?: unknown }).__postedMessages ?? [],
  )) as PostedMsg[];
  return all.filter((m) => m.kind === 'req' && m.method === method).map((m) => m.params ?? {});
}

const repoRow = (page: Page, name: string): Locator => page.getByRole('treeitem', { name, exact: true });

/** Dispatches a right-click the way the browser would; true when the default (VS Code's menu) survived. */
async function contextMenuDefaultKept(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 10,
        clientY: box.top + 5,
      }),
    );
  });
}

test.describe('Branches section: a repository row\'s right-click menu', () => {
  test("right-clicking a repository opens that repository's own menu", async ({ page }) => {
    await openBranches(page);
    await repoRow(page, 'alpha').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for alpha' });
    await expect(menu).toBeVisible();
    // The Repositories section's menu, without Checkout Branch… (this list is that).
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Update Project…',
      'Push…',
      'Fetch',
      'Commit',
      'New Branch…',
      'Checkout Tag or Revision…',
      'Stash Changes…',
      'Unstash Changes…',
      'Manage Remotes…',
    ]);
    await expect(menu.getByRole('separator')).toHaveCount(4);
    expect(await requests(page, 'branches/actions')).toEqual([{ id: `repo:${ALPHA}` }]);
  });

  test('Fetch runs for that repository alone, and its row turns until it is done', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockFetchMs?: number }).__mockFetchMs = 800;
    });
    await openBranches(page);
    await repoRow(page, 'alpha').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Fetch' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await requests(page, 'branches/runAction')).toEqual([
      { id: `repo:${ALPHA}`, action: 'gittree.fetch' },
    ]);

    const busy = page.getByRole('treeitem', { name: 'alpha, fetching' });
    await expect(busy).toBeVisible();
    await expect(busy.locator('.codicon-sync.codicon-modifier-spin')).toHaveCount(1);
    // Only the repository being fetched.
    await expect(repoRow(page, 'beta').locator('.codicon-modifier-spin')).toHaveCount(0);

    await expect(repoRow(page, 'alpha')).toBeVisible();
    await expect(repoRow(page, 'alpha').locator('.codicon-modifier-spin')).toHaveCount(0);
    await expect(repoRow(page, 'alpha').locator('.codicon-repo')).toHaveCount(1);
  });

  test('the context-menu key opens the menu under the focused repository row', async ({ page }) => {
    await openBranches(page);
    const beta = repoRow(page, 'beta');
    await beta.click();
    await expect(beta).toBeFocused();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Actions for beta' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toHaveText('Update Project…');
    const row = (await beta.boundingBox())!;
    const box = (await menu.boundingBox())!;
    // Under the row unless there is no room below it, then above.
    expect(box.y >= row.y + row.height - 1 || box.y + box.height <= row.y + 1).toBe(true);
    expect(await requests(page, 'branches/actions')).toEqual([{ id: 'repo:/work/beta' }]);
  });

  test('a click still opens and closes a repository; it has no › of its own', async ({ page }) => {
    await openBranches(page);
    await expect(repoRow(page, 'alpha').getByRole('button', { name: 'Branch actions' })).toHaveCount(0);
    await repoRow(page, 'alpha').click();
    expect(await requests(page, 'branches/toggle')).toEqual([{ id: `repo:${ALPHA}` }]);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test.describe('Branches section: right-click on the other rows', () => {
  test("a branch row's right-click opens the same menu as its ›", async ({ page }) => {
    await openBranches(page);
    const branch = page.getByRole('treeitem', { name: 'feature/x' });
    await branch.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for feature/x' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Checkout', 'Rename…']);
    await page.keyboard.press('Escape');

    await branch.hover();
    await branch.getByRole('button', { name: 'Branch actions' }).click();
    await expect(page.getByRole('menu', { name: 'Actions for feature/x' }).getByRole('menuitem')).toHaveText([
      'Checkout',
      'Rename…',
    ]);
    const asked = await requests(page, 'branches/actions');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toEqual(asked[1]);
  });

  test("a common branch's right-click asks the host for its all-repositories menu", async ({ page }) => {
    await openBranches(page);
    await page.getByRole('treeitem', { name: 'Common Local Branches' }).waitFor();
    const common = page.locator('[data-gt-row]').filter({ hasText: /^main$/u }).last();
    await common.click({ button: 'right' });
    expect(await requests(page, 'branches/activate')).toEqual([{ id: 'common:local|main' }]);
  });

  test("rows without a menu keep VS Code's menu shut; the search field keeps Cut/Copy/Paste", async ({ page }) => {
    await openBranches(page);
    expect(await contextMenuDefaultKept(page.getByRole('treeitem', { name: 'Local Branches in alpha' }))).toBe(false);
    expect(await contextMenuDefaultKept(page.getByRole('treeitem', { name: 'Update Project…' }))).toBe(false);
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(await contextMenuDefaultKept(page.getByLabel('Search branches in this repository'))).toBe(true);
  });
});
