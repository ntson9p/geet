import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockBranchesHostScript } from './mockBranchesHost';

/**
 * The Branches panel (new-way-4), against the in-page mock host: three
 * repositories — `api`, `shared` (mid-rebase) and `web` — or `web` alone.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openPanel(
  page: Page,
  opts: { single?: boolean; holdFetch?: boolean; holdRun?: boolean } = {},
): Promise<void> {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    if (o.single === true) w['__mockSingleRepo'] = true;
    if (o.holdFetch === true) w['__mockHoldFetch'] = true;
    if (o.holdRun === true) w['__mockHoldRun'] = true;
  }, opts);
  await page.addInitScript(mockBranchesHostScript);
  await page.goto('/branches.html');
  await expect(page.locator('[data-row-id]').first()).toBeVisible();
}

async function requests(page: Page, method: string): Promise<Array<Record<string, unknown>>> {
  const all = (await page.evaluate(
    () => (window as unknown as { __postedMessages?: unknown }).__postedMessages ?? [],
  )) as PostedMsg[];
  return all.filter((m) => m.kind === 'req' && m.method === method).map((m) => m.params ?? {});
}

const row = (page: Page, id: string): Locator => page.locator(`[data-row-id="${id}"]`);
const WEB = '/work/web';
const API = '/work/api';
const SHARED = '/work/shared';

test.describe('several repositories', () => {
  test('lists each repository with what it has checked out, and a banner for the one mid-rebase', async ({
    page,
  }) => {
    await openPanel(page);
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-label', 'api, on feature/login');
    await expect(row(page, `repo:${SHARED}`)).toHaveAttribute('aria-label', 'shared, on main');
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-label', 'web, on feature/login');
    // web is ahead of its upstream and has local changes.
    await expect(row(page, `repo:${WEB}`).locator('.gtp-ahead')).toHaveText('↑2');
    await expect(row(page, `repo:${WEB}`).locator('.gtp-changes')).toHaveText('3');
    const banner = row(page, `op:${SHARED}`);
    await expect(banner.getByRole('status')).toContainText('Rebasing 2/5 · 2 conflicts');
    await banner.getByRole('button', { name: 'Continue' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.rebase.continue', root: SHARED },
    });
  });

  test('a branch several repositories have is one row, with a marker for each', async ({ page }) => {
    await openPanel(page);
    await expect(row(page, 'br:local:local:main')).toHaveCount(1);
    const markers = row(page, 'br:local:local:main').locator('.gtp-markers .gtp-marker');
    // api has it, shared has it checked out, web has it — in the panel's order.
    await expect(markers).toHaveCount(3);
    expect(await markers.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual([
      'has',
      'current',
      'has',
    ]);
    // A branch only shared has: one ringed slot, two empty ones.
    await row(page, 'dir:local:refactor/').click();
    const only = row(page, 'br:local:local:refactor/types').locator('.gtp-marker');
    expect(await only.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).toEqual([
      'none',
      'has',
      'none',
    ]);
  });

  test('clicking a repository narrows the list to it; the pill widens it again', async ({ page }) => {
    await openPanel(page);
    await row(page, 'dir:local:refactor/').click();
    await expect(row(page, 'br:local:local:refactor/types')).toBeVisible();

    await row(page, `repo:${WEB}`).click();
    await expect(page.getByLabel('Filter branches')).toHaveAttribute('placeholder', 'Filter branches in web');
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'br:local:local:refactor/types')).toHaveCount(0);
    // One repository in view: no markers.
    await expect(page.locator('.gtp-markers')).toHaveCount(0);

    // Ctrl+click adds another.
    await row(page, `repo:${SHARED}`).click({ modifiers: ['Control'] });
    await expect(page.getByLabel('Filter branches')).toHaveAttribute(
      'placeholder',
      'Filter branches in 2 repositories',
    );
    await expect(row(page, 'br:local:local:refactor/types')).toBeVisible();

    await page.getByRole('button', { name: /^Narrowed to 2 repositories/u }).click();
    await expect(page.getByLabel('Filter branches')).toHaveAttribute(
      'placeholder',
      'Filter branches in 3 repositories',
    );
  });

  test("a branch's card shows each repository's side, and its button acts in all of them", async ({ page }) => {
    await openPanel(page);
    const develop = row(page, 'br:local:local:develop');
    await develop.click();
    const card = develop.locator('.gtp-card');
    await expect(card).toBeVisible();
    await expect(develop).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.gtp-card-repo')).toHaveText(['api', 'web']);
    expect((await requests(page, 'branches/details')).at(-1)).toEqual({
      target: { kind: 'local', name: 'develop', roots: [API, WEB] },
    });
    // Opening a card ran nothing.
    expect(await requests(page, 'branches/run')).toHaveLength(0);

    await card.getByRole('button', { name: 'Checkout in 2' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'action', target: { kind: 'local', name: 'develop', roots: [API, WEB] }, action: 'checkout' },
    });

    // A second click on the row shuts the card.
    await develop.locator('.gtp-branch').click();
    await expect(card).toHaveCount(0);
  });

  test("a card's button turns until the host has done its action", async ({ page }) => {
    await openPanel(page, { holdRun: true });
    const develop = row(page, 'br:local:local:develop');
    await develop.click();
    const button = develop.locator('.gtp-card').getByRole('button', { name: 'Checkout in 2' });
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeDisabled();
    await expect(button.locator('.gt-spin')).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { __releaseRun: () => void }).__releaseRun());
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeEnabled();
  });

  test("a row's own buttons: Checkout in every repository that has it, and the star", async ({ page }) => {
    await openPanel(page);
    const develop = row(page, 'br:local:local:develop');
    await develop.hover();
    await develop.getByRole('button', { name: 'Checkout in 2 repositories' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'action', target: { kind: 'local', name: 'develop', roots: [API, WEB] }, action: 'checkout' },
    });

    const main = row(page, 'br:local:local:main');
    await main.hover();
    await main.getByRole('button', { name: 'Add to Favorites' }).click();
    expect((await requests(page, 'branches/favorite')).at(-1)).toEqual({
      target: { kind: 'local', name: 'main', roots: [API, SHARED, WEB] },
      on: true,
    });
  });

  test("a repository's Fetch spins on its row until the host is done", async ({ page }) => {
    await openPanel(page);
    const web = row(page, `repo:${WEB}`);
    await web.hover();
    await web.getByRole('button', { name: 'Fetch' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.fetch', root: WEB },
    });
    await expect(web).toHaveAttribute('aria-label', /fetching$/u);
    await expect(web.locator('.gt-spin')).toHaveCount(1);
    await expect(web).toHaveAttribute('aria-label', 'web, on feature/login');
  });

  test('Fetch all turns until the host says every repository is done', async ({ page }) => {
    await openPanel(page, { holdFetch: true });
    const fetch = page.locator('.gtp-toolbar').getByRole('button', { name: 'Fetch' });
    await fetch.click();
    await expect(fetch).toHaveAttribute('aria-busy', 'true');
    await fetch.click();
    expect(await requests(page, 'branches/fetchAll')).toHaveLength(1);
    await page.evaluate(() => (window as unknown as { __releaseFetch: () => void }).__releaseFetch());
    await expect(fetch).not.toHaveAttribute('aria-busy', 'true');
  });

  test("right-click opens the host's menu for the branch, with its submenus", async ({ page }) => {
    await openPanel(page);
    await row(page, 'br:local:local:develop').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for develop' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Checkout', "New Branch from 'develop'…", 'More']);
    // A New Branch entry opens the panel's own form, starting there.
    await menu.getByRole('menuitem', { name: "New Branch from 'develop'…" }).click();
    await expect(page.getByRole('form', { name: 'New branch' })).toContainText('New branch from develop');
  });
});

test.describe('the New Branch form', () => {
  test('says what is wrong before Create, and creates in the repositories ticked', async ({ page }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'New Branch' }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    const name = form.getByLabel('Branch name');
    await expect(name).toBeFocused();
    await expect(form).toContainText('each repository’s current branch');

    await name.fill('main');
    await expect(form.getByRole('alert')).toHaveText('api, shared, web already have a branch named “main”.');
    await expect(form.getByRole('button', { name: 'Create' })).toBeDisabled();

    // Typing is cleaned as IntelliJ's field cleans it.
    await name.fill('');
    await name.pressSequentially('feature/new thing');
    await expect(name).toHaveValue('feature/new_thing');

    await form.getByRole('button', { name: 'shared' }).click();
    await form.getByRole('button', { name: 'Create' }).click();
    expect((await requests(page, 'branches/create')).at(-1)).toEqual({
      name: 'feature/new_thing',
      from: 'HEAD',
      roots: [API, WEB],
      checkout: true,
    });
    await expect(form).toHaveCount(0);
  });

  test("the host's refusal stays in the form", async ({ page }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'New Branch' }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    await form.getByLabel('Branch name').fill('refused');
    await form.getByLabel('Branch name').press('Enter');
    await expect(form.getByRole('alert')).toHaveText('web: fatal: something git said');
    await form.getByLabel('Branch name').press('Escape');
    await expect(form).toHaveCount(0);
  });
});

test.describe('searching', () => {
  test('flattens the list, marks the matches, and Escape clears it', async ({ page }) => {
    await openPanel(page);
    const filter = page.getByLabel('Filter branches');
    await filter.fill('log');
    await expect(row(page, 'sec:recent')).toHaveCount(0);
    await expect(row(page, 'br:local:local:feature/login')).toBeVisible();
    await expect(row(page, 'br:local:local:feature/login').locator('.gtp-match')).toHaveText('log');
    await expect(row(page, 'br:remote:remote:origin/feature/login')).toBeVisible();
    // Enter goes to the first match and opens it.
    await filter.press('Enter');
    await expect(row(page, 'br:local:local:feature/login')).toBeFocused();
    await expect(row(page, 'br:local:local:feature/login')).toHaveAttribute('aria-expanded', 'true');
    await filter.focus();
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(row(page, 'sec:recent')).toBeVisible();
  });

  test('a name nobody has is offered for creation', async ({ page }) => {
    await openPanel(page);
    await page.getByLabel('Filter branches').fill('feature/brand-new');
    await page.getByRole('button', { name: 'Create branch “feature/brand-new”' }).click();
    await expect(page.getByRole('form', { name: 'New branch' }).getByLabel('Branch name')).toHaveValue(
      'feature/brand-new',
    );
  });
});

test.describe('one repository', () => {
  test('starts with the current branch, whose card says where it stands', async ({ page }) => {
    await openPanel(page, { single: true });
    const head = row(page, `head:${WEB}`);
    await expect(head).toHaveAttribute('aria-label', 'Current branch feature/login');
    await expect(page.locator('[data-row-id^="repo:"]')).toHaveCount(0);
    await head.click();
    await expect(head.locator('.gtp-card')).toContainText('2 to push · origin/feature/login');
  });

  test('keyboard: arrows move, Right opens a card, Left shuts it, typing filters', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.getByLabel('Filter branches').press('ArrowDown');
    await expect(row(page, `head:${WEB}`)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'sec:recent')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const develop = row(page, 'br:recent:local:develop');
    await expect(develop).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(develop).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(develop).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('m');
    await expect(page.getByLabel('Filter branches')).toBeFocused();
    await expect(page.getByLabel('Filter branches')).toHaveValue('m');
  });

  test('Remote and Tags start shut, and a folder opens where the current branch is', async ({ page }) => {
    await openPanel(page, { single: true });
    await expect(row(page, 'sec:remote')).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'sec:tags')).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'dir:local:feature/')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'dir:local:bugfix/')).toHaveAttribute('aria-expanded', 'false');
    await row(page, 'sec:remote').click();
    await expect(row(page, 'rem:origin')).toBeVisible();
  });

  test('More Actions changes a setting on the host', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Tags' }).click();
    expect((await requests(page, 'branches/setting')).at(-1)).toEqual({ key: 'showTags', value: false });
    await expect(row(page, 'sec:tags')).toHaveCount(0);
  });

  test('a branch dragged onto another asks the host what to do', async ({ page }) => {
    await openPanel(page, { single: true });
    await row(page, 'br:recent:local:develop')
      .locator('.gtp-branch')
      .dragTo(row(page, 'br:recent:local:main').locator('.gtp-branch'));
    expect((await requests(page, 'branches/drop')).at(-1)).toEqual({
      source: { kind: 'local', name: 'develop', roots: [WEB] },
      target: { kind: 'local', name: 'main', roots: [WEB] },
    });
  });
});
