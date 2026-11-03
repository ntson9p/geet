import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockBranchesHostScript } from './mockBranchesHost';

/**
 * The Repositories panel (new-way-4; once titled Branches), against the in-page
 * mock host: three repositories — `api`, `shared` (mid-rebase) and `web` — or
 * `web` alone. The branches sit under Recent, Local, Remote and Tags tabs, and
 * the panel opens on Recent.
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

type TabName = 'Recent' | 'Local' | 'Remote' | 'Tags';
/** A tab over the branch list, the one in the list rather than its pinned copy. */
const tabButton = (page: Page, name: TabName): Locator =>
  row(page, 'tabs').locator('[role="tab"]', { hasText: new RegExp(`^${name}`, 'u') });
async function showTab(page: Page, name: TabName): Promise<void> {
  await tabButton(page, name).click();
  await expect(tabButton(page, name)).toHaveAttribute('aria-selected', 'true');
}

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
    await showTab(page, 'Local');
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
    await showTab(page, 'Local');
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
    await showTab(page, 'Local');
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
    await showTab(page, 'Local');
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
    await showTab(page, 'Local');
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
    await showTab(page, 'Local');
    await row(page, 'br:local:local:develop').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for develop' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Checkout', "New Branch from 'develop'…", 'More']);
    // A New Branch entry opens the panel's own form, starting there.
    await menu.getByRole('menuitem', { name: "New Branch from 'develop'…" }).click();
    await expect(page.getByRole('form', { name: 'New branch' })).toContainText('New branch from develop');
  });
});

test.describe('one branch in every repository (POST-P14ax)', () => {
  test('More Actions offers a checkout across every repository in view, and asks the host for the picker', async ({
    page,
  }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Checkout Branch in All Repositories…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'checkoutAcross', roots: [API, SHARED, WEB] },
    });
  });

  test('narrowed to some repositories, it says how many', async ({ page }) => {
    await openPanel(page);
    await row(page, `repo:${WEB}`).click();
    await row(page, `repo:${API}`).click({ modifiers: ['Control'] });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Checkout Branch in 2 Repositories…' }).click();
    const run = (await requests(page, 'branches/run')).at(-1)?.['run'] as { roots?: string[] } | undefined;
    expect([...(run?.roots ?? [])].sort()).toEqual([API, WEB]);
  });

  test('one repository has nothing to check out across', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Checkout Branch in/u })).toHaveCount(0);
  });

  test("a branch's menu and card are asked for with every repository in view", async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await row(page, 'br:local:local:develop').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Actions for develop' })).toBeVisible();
    expect((await requests(page, 'branches/menu')).at(-1)?.['scope']).toEqual([API, SHARED, WEB]);
    await page.keyboard.press('Escape');
    await row(page, 'br:local:local:develop').click();
    await expect.poll(async () => (await requests(page, 'branches/details')).at(-1)?.['scope']).toEqual([API, SHARED, WEB]);
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

  test('From picks where it starts, and the repositories that lack it are left out (POST-P14ax)', async ({ page }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'New Branch' }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    const from = form.getByLabel('Start point');
    await expect(from).toHaveValue('');
    await expect(from).toHaveAttribute('placeholder', 'each repository’s current branch');
    // The suggestions: what most of them share comes first.
    const options = await page.locator('#gtp-from-points option').evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value),
    );
    expect(options.slice(0, 2)).toEqual(['main', 'origin/main']);

    await form.getByLabel('Branch name').fill('feature/from-develop');
    await from.fill('develop');
    await expect(form).toContainText('New branch from develop');
    // shared has no develop: it cannot take a branch from it.
    await expect(form.getByRole('button', { name: 'shared' })).toBeDisabled();
    await form.getByRole('button', { name: 'Create' }).click();
    expect((await requests(page, 'branches/create')).at(-1)).toEqual({
      name: 'feature/from-develop',
      from: 'develop',
      roots: [API, WEB],
      checkout: true,
    });
  });

  test('clearing From goes back to each repository’s own current branch', async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await row(page, 'br:local:local:develop').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Actions for develop' }).getByRole('menuitem', { name: "New Branch from 'develop'…" }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    await expect(form.getByLabel('Start point')).toHaveValue('develop');
    await form.getByLabel('Start point').fill('');
    await expect(form).toContainText('each repository’s current branch');
    await form.getByLabel('Branch name').fill('feature/own-heads');
    await form.getByRole('button', { name: 'Create' }).click();
    expect((await requests(page, 'branches/create')).at(-1)?.['from']).toBe('HEAD');
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

test.describe('what a branch tracks', () => {
  const MISTRACKED = 'br:local:local:feature/mistracked';

  test('a branch tracking a remote branch of another name says so on its row', async ({ page }) => {
    await openPanel(page, { single: true });
    // A branch tracking its own name has nothing to warn about.
    await expect(row(page, 'br:recent:local:develop')).toBeVisible();
    await expect(row(page, 'br:recent:local:develop').locator('.gtp-elsewhere')).toHaveCount(0);
    await showTab(page, 'Local');
    const chip = row(page, MISTRACKED).locator('.gtp-chip.gtp-elsewhere');
    await expect(chip).toHaveText('→ origin/develop');
    await expect(chip).toHaveAttribute('title', /a push goes there/u);
    await expect(row(page, MISTRACKED)).toHaveAttribute(
      'aria-label',
      'feature/mistracked, tracks origin/develop',
    );
  });

  test("its card's Stop tracking asks the host to cut the link, and nothing else", async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Local');
    const mistracked = row(page, MISTRACKED);
    await mistracked.click();
    const card = mistracked.locator('.gtp-card');
    await expect(card.locator('.gtp-elsewhere')).toContainText('origin/develop');
    await card.getByRole('button', { name: 'Stop tracking' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: {
        type: 'action',
        target: { kind: 'local', name: 'feature/mistracked', roots: [WEB] },
        action: 'stopTracking',
      },
    });
    await expect(card).toBeVisible();
  });

  test('a card asks for its buttons again once the branch stops tracking', async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Local');
    const mistracked = row(page, MISTRACKED);
    await mistracked.click();
    await expect(mistracked.locator('.gtp-card').getByRole('button', { name: 'Stop tracking' })).toBeVisible();
    const asked = (await requests(page, 'branches/details')).length;
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<{ locals: Array<{ name: string; upstream?: string; ahead?: number }> }> };
        __pushState: () => void;
      };
      const branch = w.__mockState.repos[0]!.locals.find((l) => l.name === 'feature/mistracked')!;
      delete branch.upstream;
      delete branch.ahead;
      w.__pushState();
    });
    // No longer tracking: no chip, no link, and `Update` must not linger on the card.
    await expect(mistracked.locator('.gtp-elsewhere')).toHaveCount(0);
    await expect(mistracked.locator('.gtp-card').getByRole('button', { name: 'Stop tracking' })).toHaveCount(0);
    await expect(mistracked.locator('.gtp-card')).toContainText('Not published');
    await expect.poll(async () => (await requests(page, 'branches/details')).length).toBeGreaterThan(asked);
  });

  test('a branch tracking its own name still offers Stop tracking on its card', async ({ page }) => {
    await openPanel(page, { single: true });
    const develop = row(page, 'br:recent:local:develop');
    await develop.click();
    await develop.locator('.gtp-card').getByRole('button', { name: 'Stop tracking' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'action', target: { kind: 'local', name: 'develop', roots: [WEB] }, action: 'stopTracking' },
    });
  });

  test('a branch tracking nothing has no link', async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Local');
    await row(page, 'dir:local:bugfix/').click();
    const header = row(page, 'br:local:local:bugfix/header');
    await header.click();
    await expect(header.locator('.gtp-card')).toContainText('Not published');
    await expect(header.locator('.gtp-card').getByRole('button', { name: 'Stop tracking' })).toHaveCount(0);
  });

  test('across repositories, the line that tracks elsewhere is the one with the link', async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<{ root: string; locals: Array<{ name: string; upstream?: string }> }> };
        __pushState: () => void;
      };
      const api = w.__mockState.repos.find((r) => r.root === '/work/api')!;
      api.locals.find((l) => l.name === 'develop')!.upstream = 'origin/main';
      w.__pushState();
    });
    await showTab(page, 'Local');
    const develop = row(page, 'br:local:local:develop');
    await expect(develop.locator('.gtp-chip.gtp-elsewhere')).toHaveText('→ origin/main');
    await develop.click();
    const links = develop.locator('.gtp-card').getByRole('button', { name: 'Stop tracking' });
    await expect(links).toHaveCount(1);
    await links.click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: {
        type: 'action',
        target: { kind: 'local', name: 'develop', roots: [API, WEB] },
        action: 'stopTracking',
        root: API,
      },
    });
  });

  test("the current branch's row warns too, and says 'not tracking' rather than 'not published'", async ({
    page,
  }) => {
    await openPanel(page, { single: true });
    const head = row(page, `head:${WEB}`);
    const setHead = async (upstream: string | undefined): Promise<void> => {
      await page.evaluate((u) => {
        const w = window as unknown as {
          __mockState: {
            repos: Array<{
              upstream?: string;
              head?: string;
              locals: Array<{ name: string; upstream?: string; current?: boolean }>;
            }>;
          };
          __pushState: () => void;
        };
        const web = w.__mockState.repos[0]!;
        const current = web.locals.find((l) => l.current === true)!;
        if (u === null) {
          delete web.upstream;
          delete current.upstream;
        } else {
          web.upstream = u;
          current.upstream = u;
        }
        w.__pushState();
      }, upstream ?? null);
    };
    await setHead('origin/develop');
    await expect(head.locator('.gtp-elsewhere')).toHaveText('→ origin/develop');
    await setHead(undefined);
    await expect(head.locator('.gtp-elsewhere')).toHaveCount(0);
    // origin/feature/login exists: the branch is published, it just isn't tracked.
    await expect(head).toContainText('not tracking origin/feature/login');
  });

  test('the New Branch form says what the new branch will track', async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Remote');
    await row(page, 'br:remote:remote:origin/develop').click({ button: 'right' });
    await page.getByRole('menuitem', { name: "New Branch from 'origin/develop'…" }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    const note = form.locator('.gtp-form-note');
    await expect(note).toHaveText('It will track nothing: your first push creates a branch of its own on origin.');
    await form.getByLabel('Branch name').fill('mine');
    await expect(note).toHaveText('It will track nothing: your first push creates a branch of its own on origin.');
    // `develop` is taken here, so the name problem shows as well; the note still answers.
    await form.getByLabel('Branch name').fill('develop');
    await expect(note).toHaveText('It will track origin/develop, the remote branch of the same name.');
  });

  test('a local start point raises no question', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'New Branch' }).click();
    const form = page.getByRole('form', { name: 'New branch' });
    await form.getByLabel('Branch name').fill('mine');
    await expect(form.locator('.gtp-form-note')).toHaveCount(0);
  });
});

test.describe('searching', () => {
  test('looks in every kind at once, marks the matches, and Escape brings the tabs back', async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Tags');
    const filter = page.getByLabel('Filter branches');
    await filter.fill('log');
    // The tabs step aside: the search is not just the tab on show.
    await expect(row(page, 'tabs')).toHaveCount(0);
    await expect(row(page, 'sec:local')).toBeVisible();
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
    // Back as they were: Tags, as picked before the search.
    await expect(tabButton(page, 'Tags')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'sec:local')).toHaveCount(0);
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
    await expect(row(page, 'tabs')).toBeFocused();
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

  test('Local folds into folders, opening the one the current branch is in; Remote groups by remote', async ({
    page,
  }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Local');
    await expect(row(page, 'dir:local:feature/')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'dir:local:bugfix/')).toHaveAttribute('aria-expanded', 'false');
    await showTab(page, 'Remote');
    await expect(row(page, 'rem:origin')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'dir:local:feature/')).toHaveCount(0);
  });

  test('More Actions changes a setting on the host', async ({ page }) => {
    await openPanel(page, { single: true });
    await expect(tabButton(page, 'Tags')).toHaveCount(1);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Tags' }).click();
    expect((await requests(page, 'branches/setting')).at(-1)).toEqual({ key: 'showTags', value: false });
    // Tags hidden: no Tags tab either.
    await expect(tabButton(page, 'Tags')).toHaveCount(0);
  });

  test('Collapse All shuts every folder of the tab, the ones opened by hand too', async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Local');
    await row(page, 'dir:local:bugfix/').click();
    await expect(row(page, 'dir:local:bugfix/')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Collapse All' }).click();
    await expect(row(page, 'dir:local:bugfix/')).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'dir:local:feature/')).toHaveAttribute('aria-expanded', 'false');
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

test.describe('the tabs over the branches', () => {
  test('Recent, Local, Remote and Tags are tabs over one list, and the one picked is kept', async ({ page }) => {
    await openPanel(page, { single: true });
    // It opens on Recent: the starred and the recently used.
    await expect(tabButton(page, 'Recent')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'br:recent:local:develop')).toBeVisible();
    await expect(row(page, 'dir:local:bugfix/')).toHaveCount(0);
    // Each counts what it holds, and its hover says so in words.
    await expect(tabButton(page, 'Recent')).toHaveAttribute('title', '3 recent branches');
    await expect(tabButton(page, 'Local')).toHaveAttribute('title', '7 local branches');
    await expect(tabButton(page, 'Tags')).toHaveAttribute('title', '2 tags');

    await showTab(page, 'Local');
    await expect(row(page, 'dir:local:bugfix/')).toBeVisible();
    await expect(row(page, 'br:recent:local:develop')).toHaveCount(0);
    await showTab(page, 'Tags');
    await expect(row(page, 'br:tags:tag:v1.1')).toBeVisible();
    await expect(row(page, 'dir:local:bugfix/')).toHaveCount(0);
    // Kept with the view's state, for the next time it starts.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __mockVsState?: { tab?: string } }).__mockVsState?.tab))
      .toBe('tags');
  });

  test('the panel starts again on the tab last picked', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockVsState: unknown }).__mockVsState = { tab: 'remote' };
    });
    await openPanel(page, { single: true });
    await expect(tabButton(page, 'Remote')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'rem:origin')).toBeVisible();
  });

  test('on the tabs, Left and Right switch them, round the ends, and Down goes into the list', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.getByLabel('Filter branches').press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const tabs = row(page, 'tabs');
    await expect(tabs).toBeFocused();
    await expect(tabs).toHaveAttribute('aria-label', 'Recent tab, 1 of 4. Left and Right switch.');
    await page.keyboard.press('ArrowRight');
    await expect(tabButton(page, 'Local')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(tabButton(page, 'Tags')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveAttribute('aria-label', 'Tags tab, 4 of 4. Left and Right switch.');
    // Newest first.
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'br:tags:tag:v1.1')).toBeFocused();
  });

  test('the tabs stay in view once the list scrolls past them, and a click there starts the list under them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 320 });
    await openPanel(page, { single: true });
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<{ locals: Array<Record<string, unknown>> }> };
        __pushState: () => void;
      };
      const web = w.__mockState.repos[0]!;
      for (let i = 1; i <= 30; i++) {
        const name = `topic-${String(i).padStart(2, '0')}`;
        web.locals.push({ name, sha: 'f'.repeat(40), date: 1_800_000_000 - i * 3600, subject: `Work on ${name}` });
      }
      w.__pushState();
    });
    await showTab(page, 'Local');
    await expect(row(page, 'br:local:local:topic-01')).toBeVisible();
    const pinned = page.locator('.gtp-pinned');
    await expect(pinned).toHaveCount(0);

    await page.locator('.gtp-list').evaluate((el) => {
      el.scrollTop = 400;
    });
    await expect(pinned).toBeVisible();
    await expect(pinned.locator('[role="tab"]', { hasText: /^Local/u })).toHaveAttribute('aria-selected', 'true');
    // It covers the list's top edge, and leaves the scrollbar free.
    const [list, strip] = await Promise.all([page.locator('.gtp-list').boundingBox(), pinned.boundingBox()]);
    expect(strip!.y).toBe(list!.y);
    expect(strip!.width).toBeLessThanOrEqual(list!.width);

    await pinned.locator('[role="tab"]', { hasText: /^Remote/u }).click();
    await expect(tabButton(page, 'Remote')).toHaveAttribute('aria-selected', 'true');
    await expect(pinned).toHaveCount(0);
    await expect(row(page, 'tabs')).toBeFocused();
    await expect(row(page, 'rem:origin')).toBeVisible();
  });

  test('a narrow sidebar drops the counts before it cuts a tab off', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.addStyleTag({ content: 'body { --vscode-font-family: Arial, sans-serif; --vscode-font-size: 13px; }' });
    const strip = row(page, 'tabs').locator('.gtp-tabs');
    const lastTabFits = (): Promise<boolean> =>
      strip.evaluate((el) => {
        const tabs = el.querySelectorAll('[role="tab"]');
        return tabs[tabs.length - 1]!.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5;
      });
    await page.setViewportSize({ width: 600, height: 600 });
    await expect(strip).toHaveAttribute('data-fit', 'full');
    await expect(strip.locator('.gtp-tab-count').first()).toBeVisible();
    for (const width of [320, 260, 220]) {
      await page.setViewportSize({ width, height: 600 });
      await expect.poll(lastTabFits).toBe(true);
    }
    await expect(strip).not.toHaveAttribute('data-fit', 'full');
    await expect(strip.locator('.gtp-tab-count').first()).toBeHidden();
    // The hover still counts.
    await expect(tabButton(page, 'Local')).toHaveAttribute('title', '7 local branches');
  });

  test('a tab with nothing in it says what would fill it', async ({ page }) => {
    await openPanel(page, { single: true });
    await showTab(page, 'Recent');
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<{ recent: string[]; favorites: string[] }> };
        __pushState: () => void;
      };
      const web = w.__mockState.repos[0]!;
      web.recent = [];
      web.favorites = [];
      w.__pushState();
    });
    await expect(row(page, 'hint:recent')).toContainText('No recent branches yet');
    await expect(tabButton(page, 'Recent')).toHaveAttribute('title', '0 recent branches');
  });

  test('with several repositories, the tabs sit under them', async ({ page }) => {
    await openPanel(page);
    const order = await page.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    expect(order.indexOf('tabs')).toBeGreaterThan(order.indexOf(`repo:${WEB}`));
    expect(order.indexOf('tabs')).toBeGreaterThan(order.indexOf(`op:${SHARED}`));
    await expect(row(page, 'sec:repos')).toBeVisible();
  });
});
