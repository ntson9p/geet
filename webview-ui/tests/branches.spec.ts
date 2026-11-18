import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockBranchesHostScript } from './mockBranchesHost';

/**
 * The Repositories and Branches panels (new-way-4; one panel, titled
 * Repositories, until POST-P14co split it), against the in-page mock host:
 * three repositories — `api`, `shared` (mid-rebase) and `web` — or `web` alone.
 * A page is one panel: the Branches panel unless `role` says Repositories. The
 * branches sit under Recent, Local, Remote and Tags tabs, and the panel opens
 * on Recent. Two pages of one test are the two panels of one host.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

type Role = 'repositories' | 'branches';

interface PanelOptions {
  single?: boolean;
  holdFetch?: boolean;
  holdRun?: boolean;
  dots?: boolean;
  /** Which panel the page is; the Branches panel by default. */
  role?: Role;
  /** The repositories the host kept picked when the page opens (POST-P14ce). */
  scope?: string[];
}

async function openPanel(page: Page, opts: PanelOptions = {}): Promise<void> {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    if (o.single === true) w['__mockSingleRepo'] = true;
    if (o.holdFetch === true) w['__mockHoldFetch'] = true;
    if (o.holdRun === true) w['__mockHoldRun'] = true;
    // Repository Dots start on (they are off by default).
    if (o.dots === true) w['__mockDots'] = true;
    if (o.role !== undefined) w['__mockRole'] = o.role;
    if (o.scope !== undefined) w['__mockScope'] = o.scope;
  }, opts);
  await page.addInitScript(mockBranchesHostScript);
  await page.goto('/branches.html');
  await expect(page.locator('[data-row-id]:visible').first()).toBeVisible();
}

/**
 * Both panels, as VS Code shows them (POST-P14co): the Repositories panel in
 * `page`, the Branches panel in a second page of the same browser, joined by
 * the mock host as the two webviews are by the real one.
 */
async function openBoth(page: Page, opts: Omit<PanelOptions, 'role'> = {}): Promise<{ repos: Page; branches: Page }> {
  const branches = await page.context().newPage();
  await openPanel(page, { ...opts, role: 'repositories' });
  await openPanel(branches, { ...opts, role: 'branches' });
  return { repos: page, branches };
}

/** A pick made in another panel (or the Commit window), as the host passes it on. */
async function pickElsewhere(page: Page, roots: string[]): Promise<void> {
  await page.evaluate((r) => (window as unknown as { __mockPickElsewhere(r: string[]): void }).__mockPickElsewhere(r), roots);
}

/** What the Branches panel's filter says before anything is typed (POST-P14co: and what `@` does). */
const filterIn = (what: string): string => `Filter branches in ${what} (type @ to pick repositories)`;

async function requests(page: Page, method: string): Promise<Array<Record<string, unknown>>> {
  const all = (await page.evaluate(
    () => (window as unknown as { __postedMessages?: unknown }).__postedMessages ?? [],
  )) as PostedMsg[];
  return all.filter((m) => m.kind === 'req' && m.method === method).map((m) => m.params ?? {});
}

const row = (page: Page, id: string): Locator => page.locator(`[data-row-id="${id}"]`);
/** VS Code's own 13px, which the panel's narrow rules are measured in. */
const VS_CODE_FONT = 'body { --vscode-font-family: Arial, sans-serif; --vscode-font-size: 13px; }';
/** Text cut short: an ellipsis, or nothing shown past the box's edge. */
const isCut = (l: Locator): Promise<boolean> => l.evaluate((el) => el.scrollWidth > el.clientWidth + 0.5);
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
    await openPanel(page, { role: 'repositories' });
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
    await openPanel(page, { dots: true });
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

  test('Repository Dots are off by default; the toolbar button shows them and tells the host', async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await expect(page.locator('.gtp-markers')).toHaveCount(0);
    const toggle = page.locator('.gtp-toolbar').getByRole('button', { name: 'Repository Dots' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toHaveAttribute('title', 'Show Repository Dots');

    await toggle.click();
    expect((await requests(page, 'branches/setting')).at(-1)).toEqual({ key: 'showRepositoryDots', value: true });
    await expect(row(page, 'br:local:local:main').locator('.gtp-markers .gtp-marker')).toHaveCount(3);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('title', 'Hide Repository Dots');

    await toggle.click();
    expect((await requests(page, 'branches/setting')).at(-1)).toEqual({ key: 'showRepositoryDots', value: false });
    await expect(page.locator('.gtp-markers')).toHaveCount(0);
  });

  test('More Actions › Show › Repository Dots is the same switch', async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    const item = page.getByRole('menuitemcheckbox', { name: 'Repository Dots' });
    await expect(item).toHaveAttribute('aria-checked', 'false');
    await item.click();
    expect((await requests(page, 'branches/setting')).at(-1)).toEqual({ key: 'showRepositoryDots', value: true });
    await expect(row(page, 'br:local:local:main').locator('.gtp-markers')).toHaveCount(1);
    await expect(
      page.locator('.gtp-toolbar').getByRole('button', { name: 'Repository Dots' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Repository Dots' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test("More Actions' menu closes when the webview loses focus, as after a click elsewhere in VS Code", async ({
    page,
  }) => {
    // Such a click never reaches the webview's document; its window's blur does.
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.locator('.gt-menu')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('.gt-menu')).toHaveCount(0);
  });

  test("a row's hover buttons come before its counts, dots and age, so none of them moves", async ({ page }) => {
    await openPanel(page, { dots: true });
    await showTab(page, 'Local');
    const main = row(page, 'br:local:local:main');
    const x = async (selector: string): Promise<number> => (await main.locator(selector).boundingBox())!.x;
    const at = { sync: await x('.gtp-sync'), dots: await x('.gtp-markers'), age: await x('.gtp-age') };

    await main.hover();
    await expect(main.getByRole('button', { name: 'Checkout in 3 repositories' })).toBeVisible();
    expect({ sync: await x('.gtp-sync'), dots: await x('.gtp-markers'), age: await x('.gtp-age') }).toEqual(at);
    // The age stays in view: the buttons no longer take its place.
    await expect(main.locator('.gtp-age')).toBeVisible();
    const buttons = (await main.locator('.gtp-row-buttons').boundingBox())!;
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(at.sync + 0.5);

    // Selected rather than hovered: the same.
    await page.mouse.move(0, 0);
    await main.click();
    expect({ sync: await x('.gtp-sync'), dots: await x('.gtp-markers'), age: await x('.gtp-age') }).toEqual(at);
  });

  test("a repository's menu opens with the ways of looking at it, Show in New Log Tab among them", async ({
    page,
  }) => {
    await openPanel(page, { role: 'repositories' });
    await row(page, `repo:${WEB}`).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for web' });
    await expect(menu).toBeVisible();
    // The first two rows together, with no rule between them; the rule comes after.
    const firstRows = await menu.evaluate((el) =>
      [...el.querySelectorAll('[role="menuitem"], [role="separator"]')]
        .slice(0, 4)
        .map((e) => (e.getAttribute('role') === 'separator' ? '—' : (e.textContent ?? '').trim())),
    );
    expect(firstRows).toEqual(['Show Only This Repository', 'Show in New Log Tab', '—', 'Update Repository…']);

    await menu.getByRole('menuitem', { name: 'Show in New Log Tab' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.repositories.showInLog', root: WEB },
    });
  });

  test("a repository's own update says it is the repository's, from its menu and its button (POST-P14bx)", async ({
    page,
  }) => {
    await openPanel(page, { role: 'repositories' });
    // Its menu: Update Repository… and Without Fetching, each run for that repository.
    await row(page, `repo:${WEB}`).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for web' });
    await expect(menu.getByRole('menuitem', { name: 'Update Project…' })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Update Repository Without Fetching…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.update.repositoryWithoutFetch', root: WEB },
    });
    await row(page, `repo:${WEB}`).click({ button: 'right' });
    await page.getByRole('menu', { name: 'Actions for web' }).getByRole('menuitem', { name: 'Update Repository…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.update.repository', root: WEB },
    });

    // Its row's ↓ button.
    const web = row(page, `repo:${WEB}`);
    await web.hover();
    await expect(web.getByRole('button', { name: 'Update Project…' })).toHaveCount(0);
    await web.getByRole('button', { name: 'Update Repository…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.update.repository', root: WEB },
    });
  });

  test('the ⋯ menu updates, commits and pushes what is in view: the project, the repository picked, or the repositories picked (POST-P14bx, POST-P14by)', async ({
    page,
  }) => {
    await openPanel(page);
    // The IntelliJ keymap on, so the items name their keys.
    await page.evaluate(() => {
      const w = window as unknown as { __mockState: { intellijKeymap?: boolean }; __pushState: () => void };
      w.__mockState.intellijKeymap = true;
      w.__pushState();
    });
    const more = page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' });
    const menu = page.getByRole('menu', { name: 'More actions' });
    /** The first four rows (Update, Without Fetching, Commit, Push): their words, and a key where one is named. */
    const firstRows = async (): Promise<string[]> => {
      await more.click();
      await expect(menu).toBeVisible();
      const items = menu.locator('[role="menuitem"]');
      const rows: string[] = [];
      for (let i = 0; i < 4; i++) {
        const label = ((await items.nth(i).locator('.gt-menu-label').textContent()) ?? '').trim();
        const accel = items.nth(i).locator('.gt-menu-accel');
        rows.push((await accel.count()) > 0 ? `${label} [${await accel.textContent()}]` : label);
      }
      return rows;
    };
    const lastRun = async (): Promise<unknown> => (await requests(page, 'branches/run')).at(-1);

    // Every repository in view: the project's, which Ctrl+T, Ctrl+K and Ctrl+Shift+K run too.
    expect(await firstRows()).toEqual([
      'Update Project… [Ctrl+T]',
      'Update Project Without Fetching…',
      'Commit… [Ctrl+K]',
      'Push… [Ctrl+Shift+K]',
    ]);
    await menu.getByRole('menuitem', { name: /^Update Project…/u }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'update', roots: [] } });
    await more.click();
    await menu.getByRole('menuitem', { name: /^Commit…/u }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'commit', roots: [] } });

    // One picked (in the Repositories panel): that one, the words say so, and the
    // keys, which run the project's, are gone.
    await pickElsewhere(page, [WEB]);
    expect(await firstRows()).toEqual([
      'Update Repository…',
      'Update Repository Without Fetching…',
      'Commit Repository…',
      'Push Repository…',
    ]);
    await menu.getByRole('menuitem', { name: 'Update Repository…' }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'update', roots: [WEB] } });
    await more.click();
    await menu.getByRole('menuitem', { name: 'Commit Repository…' }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'commit', roots: [WEB] } });

    // Two of three (a Ctrl+click there): those two, which they used to leave for every repository.
    await pickElsewhere(page, [WEB, API]);
    expect(await firstRows()).toEqual([
      'Update 2 Repositories…',
      'Update 2 Repositories Without Fetching…',
      'Commit 2 Repositories…',
      'Push 2 Repositories…',
    ]);
    await menu.getByRole('menuitem', { name: 'Update 2 Repositories Without Fetching…' }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'updateWithoutFetch', roots: [API, WEB] } });
    await more.click();
    await menu.getByRole('menuitem', { name: 'Commit 2 Repositories…' }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'commit', roots: [API, WEB] } });
    await more.click();
    await menu.getByRole('menuitem', { name: 'Push 2 Repositories…' }).click();
    expect(await lastRun()).toEqual({ run: { type: 'inView', verb: 'push', roots: [API, WEB] } });

    // Every one shown again: the project's again.
    await page.getByRole('button', { name: /^Narrowed to 2 repositories/u }).click();
    expect(await firstRows()).toEqual([
      'Update Project… [Ctrl+T]',
      'Update Project Without Fetching…',
      'Commit… [Ctrl+K]',
      'Push… [Ctrl+Shift+K]',
    ]);
  });

  test('clicking a repository narrows the Branches panel to it; the pill there widens both again', async ({
    page,
  }) => {
    const { repos, branches } = await openBoth(page);
    await showTab(branches, 'Local');
    await row(branches, 'dir:local:refactor/').click();
    await expect(row(branches, 'br:local:local:refactor/types')).toBeVisible();

    await row(repos, `repo:${WEB}`).click();
    await expect(row(repos, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    await expect(branches.getByLabel('Filter branches')).toHaveAttribute('placeholder', filterIn('web'));
    await expect(row(branches, 'br:local:local:refactor/types')).toHaveCount(0);
    // One repository in view: no markers, and no switch for them.
    await expect(branches.locator('.gtp-markers')).toHaveCount(0);
    await expect(branches.locator('.gtp-toolbar').getByRole('button', { name: 'Repository Dots' })).toHaveCount(0);

    // Ctrl+click adds another.
    await row(repos, `repo:${SHARED}`).click({ modifiers: ['Control'] });
    await expect(branches.getByLabel('Filter branches')).toHaveAttribute('placeholder', filterIn('2 repositories'));
    await expect(row(branches, 'br:local:local:refactor/types')).toBeVisible();

    await branches.getByRole('button', { name: /^Narrowed to 2 repositories/u }).click();
    await expect(branches.getByLabel('Filter branches')).toHaveAttribute('placeholder', filterIn('3 repositories'));
    await expect(row(repos, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'false');
    await expect(row(repos, `repo:${SHARED}`)).toHaveAttribute('aria-selected', 'false');
  });

  test('a second click shows every repository again, and the row looks as the others do (POST-P14bw)', async ({
    page,
  }) => {
    await openPanel(page, { role: 'repositories' });
    const ACTIVE = 'rgb(4, 57, 94)';
    const INACTIVE = 'rgb(55, 55, 61)';
    const OUTLINE = 'rgb(0, 120, 212)';
    const NONE = 'rgba(0, 0, 0, 0)';
    // Where VS Code puts its colours.
    await page.evaluate(
      ([active, inactive, outline]) => {
        const s = document.documentElement.style;
        s.setProperty('--vscode-list-activeSelectionBackground', active!);
        s.setProperty('--vscode-list-inactiveSelectionBackground', inactive!);
        s.setProperty('--vscode-list-focusOutline', outline!);
      },
      [ACTIVE, INACTIVE, OUTLINE],
    );
    /** How a repository's row looks: its highlight, its focus ring and how many of its buttons show. */
    const look = (root: string): Promise<{ background: string; outline: string; buttons: number }> =>
      row(page, `repo:${root}`).evaluate((el) => {
        const own = getComputedStyle(el);
        return {
          background: getComputedStyle(el.querySelector('.gtp-repo')!).backgroundColor,
          outline: own.outlineStyle === 'none' ? 'none' : own.outlineColor,
          buttons: [...el.querySelectorAll('.gtp-row-buttons > .gtp-icon-button')].filter(
            (b) => getComputedStyle(b).display !== 'none',
          ).length,
        };
      });
    const pointerAway = (): Promise<void> => page.mouse.move(0, 0);

    // Picked: highlighted as a selected row is. A click leaves no focus ring.
    await row(page, `repo:${API}`).click();
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-selected', 'true');
    await pointerAway();
    expect(await look(API)).toEqual({ background: ACTIVE, outline: 'none', buttons: 0 });

    // The second click shows every repository again, and leaves the row as the others are.
    await row(page, `repo:${API}`).click();
    await expect.poll(async () => (await requests(page, 'branches/setScope')).map((p) => p['roots'])).toEqual([[API], []]);
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-selected', 'false');
    await expect(row(page, `repo:${API}`)).toBeFocused();
    await pointerAway();
    expect(await look(API)).toEqual({ background: NONE, outline: 'none', buttons: 0 });
    expect(await look(API)).toEqual(await look(WEB));

    // The keyboard's place is the focus ring alone, with the row's buttons, until Enter picks it.
    await page.keyboard.press('ArrowDown');
    await expect(row(page, `repo:${SHARED}`)).toBeFocused();
    const keyed = await look(SHARED);
    expect([keyed.background, keyed.outline]).toEqual([NONE, OUTLINE]);
    expect(keyed.buttons).toBeGreaterThan(0);
    expect(await look(API)).toEqual({ background: NONE, outline: 'none', buttons: 0 });
    await page.keyboard.press('Enter');
    await expect(row(page, `repo:${SHARED}`)).toHaveAttribute('aria-selected', 'true');
    expect((await look(SHARED)).background).toBe(ACTIVE);
    expect((await look(SHARED)).outline).toBe(OUTLINE);

    // Ctrl+click adds api: every picked row is highlighted, not just the one clicked last.
    await row(page, `repo:${API}`).click({ modifiers: ['Control'] });
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-selected', 'true');
    await pointerAway();
    expect((await look(API)).background).toBe(ACTIVE);
    expect((await look(SHARED)).background).toBe(ACTIVE);
    expect((await look(WEB)).background).toBe(NONE);

    // With the focus elsewhere (the panel has nothing else to focus: VS Code
    // has it), the picked rows keep the inactive highlight, as VS Code's lists do.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect((await look(API)).background).toBe(INACTIVE);
    expect((await look(SHARED)).background).toBe(INACTIVE);
    expect((await look(WEB)).background).toBe(NONE);
  });

  test("a repository's hover says what a click on it does (POST-P14bw)", async ({ page }) => {
    await openPanel(page, { role: 'repositories' });
    const hint = async (root: string): Promise<string> =>
      ((await row(page, `repo:${root}`).locator('.gtp-repo').getAttribute('title')) ?? '').split('\n')[1] ?? '';
    // Every repository shown: a click (or a Ctrl+click) shows only this one.
    expect(await hint(API)).toBe('Click to show only its branches');
    // Shown alone: a click shows every repository again.
    await row(page, `repo:${API}`).click();
    expect(await hint(API)).toBe('Click to show every repository again');
    expect(await hint(WEB)).toBe('Click to show only its branches · Ctrl+click to add it');
    // Picked with another: a click shows it alone; Ctrl+click leaves it out.
    await row(page, `repo:${WEB}`).click({ modifiers: ['Control'] });
    expect(await hint(API)).toBe('Click to show only its branches · Ctrl+click to leave it out');
    expect(await hint(WEB)).toBe('Click to show only its branches · Ctrl+click to leave it out');
    expect(await hint(SHARED)).toBe('Click to show only its branches · Ctrl+click to add it');
    // And it does: a click on one of the two shows that one alone.
    await row(page, `repo:${WEB}`).click();
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-selected', 'false');
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    expect(await hint(WEB)).toBe('Click to show every repository again');
  });

  test("a click selects a branch; a double-click opens its card, whose button acts in all of them", async ({
    page,
  }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    const develop = row(page, 'br:local:local:develop');
    await develop.click();
    // Selected, and nothing opened or asked for.
    await expect(develop).toBeFocused();
    await expect(develop).toHaveClass(/gtp-focused/u);
    await expect(develop).toHaveAttribute('aria-expanded', 'false');
    await expect(develop.locator('.gtp-card')).toHaveCount(0);
    expect(await requests(page, 'branches/details')).toHaveLength(0);

    await develop.dblclick();
    const card = develop.locator('.gtp-card');
    await expect(card).toBeVisible();
    await expect(develop).toHaveAttribute('aria-expanded', 'true');
    // api and web say the same about develop: one line. shared lacks it: another.
    await expect(card.locator('.gtp-card-repo')).toHaveText(['api, web', 'not in shared']);
    // With the Repository Dots off (the default) the card still says which repositories.
    await expect(develop.locator('.gtp-markers')).toHaveCount(0);
    expect((await requests(page, 'branches/details')).at(-1)).toEqual({
      target: { kind: 'local', name: 'develop', roots: [API, WEB] },
      // Every repository in view: a checkout across them reaches beyond develop's two.
      scope: [API, SHARED, WEB],
    });
    // Opening a card ran nothing.
    expect(await requests(page, 'branches/run')).toHaveLength(0);

    await card.getByRole('button', { name: 'Checkout in 2' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'action', target: { kind: 'local', name: 'develop', roots: [API, WEB] }, action: 'checkout' },
    });

    // A single click on the row leaves it open; a double-click shuts it.
    await develop.locator('.gtp-branch').click();
    await expect(card).toBeVisible();
    await develop.locator('.gtp-branch').dblclick();
    await expect(card).toHaveCount(0);
  });

  test("the chevron opens and shuts a branch's card; Escape shuts it too", async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    const develop = row(page, 'br:local:local:develop');
    await develop.hover();
    await develop.locator('.gtp-twisty').click();
    await expect(develop.locator('.gtp-card')).toBeVisible();
    await expect(develop).toBeFocused();
    await develop.locator('.gtp-twisty').click();
    await expect(develop.locator('.gtp-card')).toHaveCount(0);

    await develop.locator('.gtp-twisty').click();
    await expect(develop.locator('.gtp-card')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(develop.locator('.gtp-card')).toHaveCount(0);
    await expect(develop).toBeFocused();
  });

  test('a card puts twenty repositories that say the same on one line, and lists them on demand', async ({
    page,
  }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<Record<string, unknown>> };
        __pushState: () => void;
      };
      // Seventeen more like api: develop up to date in each.
      const base = w.__mockState.repos[0]!;
      for (let i = 1; i <= 17; i++) {
        w.__mockState.repos.push({ ...base, root: `/work/extra-${i}`, label: `extra-${i}` });
      }
      w.__pushState();
    });
    await showTab(page, 'Local');
    const develop = row(page, 'br:local:local:develop');
    await develop.dblclick();
    const card = develop.locator('.gtp-card');
    // Nineteen repositories in step, then the one without it: two lines, not twenty.
    await expect(card.locator('.gtp-card-group')).toHaveCount(2);
    await expect(card.locator('.gtp-card-repo')).toHaveText(['19 repositories', 'not in shared']);
    await expect(card.locator('.gtp-card-group').first()).toContainText('up to date · 3 ahead, 1 behind current');
    await expect(card.locator('.gtp-card-group').first().locator('.gtp-marker')).toHaveCount(19);
    await expect(card.locator('.gtp-card-member')).toHaveCount(0);

    const toggle = card.getByRole('button', { name: '19 repositories' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card.locator('.gtp-card-member')).toHaveCount(19);
    await expect(card.locator('.gtp-card-member').first()).toHaveText('api');
    // The list is part of the card: shutting it gives the room back.
    const listed = (await develop.boundingBox())!.height;
    await toggle.click();
    await expect(card.locator('.gtp-card-member')).toHaveCount(0);
    expect((await develop.boundingBox())!.height).toBeLessThan(listed);

    // A card opened again starts with its groups shut. (With the card open, the
    // row's middle is in the card, so the double-clicks go to the branch's line.)
    await toggle.click();
    await develop.locator('.gtp-branch').dblclick();
    await expect(card).toHaveCount(0);
    await develop.locator('.gtp-branch').dblclick();
    await expect(card).toBeVisible();
    await expect(develop.locator('.gtp-card-member')).toHaveCount(0);
  });

  test('a branch in one repository of several: its card names that one, and the ones without it', async ({
    page,
  }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await row(page, 'dir:local:refactor/').click();
    const types = row(page, 'br:local:local:refactor/types');
    await types.dblclick();
    const card = types.locator('.gtp-card');
    await expect(card.locator('.gtp-card-repo')).toHaveText(['shared', 'not in api, web']);
  });

  test("a card's button turns until the host has done its action", async ({ page }) => {
    await openPanel(page, { holdRun: true });
    await showTab(page, 'Local');
    const develop = row(page, 'br:local:local:develop');
    await develop.dblclick();
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
    // Two seconds, not the mock's 400 ms: on a busy machine the spin was over
    // before the first look. The row still settles well within the wait.
    await page.addInitScript(() => {
      (window as unknown as { __mockFetchMs: number }).__mockFetchMs = 2000;
    });
    await openPanel(page, { role: 'repositories' });
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
    await openPanel(page, { scope: [WEB, API] });
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

  test("with several repositories in view, More Actions has no Checkout Tag or Revision: it could not say which", async ({
    page,
  }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Checkout Branch in All Repositories…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Checkout Tag or Revision…' })).toHaveCount(0);
  });

  test('narrowed to some repositories, it is still left out', async ({ page }) => {
    await openPanel(page, { scope: [WEB, API] });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Checkout Branch in 2 Repositories…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Checkout Tag or Revision…' })).toHaveCount(0);
  });

  test('narrowed to one repository, More Actions has Checkout Tag or Revision, for that one', async ({ page }) => {
    await openPanel(page, { scope: [API] });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Checkout Tag or Revision…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.branches.checkoutRevision', root: API },
    });
  });

  test('with one repository, More Actions has Checkout Tag or Revision, for it', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Checkout Tag or Revision…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.branches.checkoutRevision', root: WEB },
    });
  });

  test("a branch's menu and card are asked for with every repository in view", async ({ page }) => {
    await openPanel(page);
    await showTab(page, 'Local');
    await row(page, 'br:local:local:develop').click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Actions for develop' })).toBeVisible();
    expect((await requests(page, 'branches/menu')).at(-1)?.['scope']).toEqual([API, SHARED, WEB]);
    await page.keyboard.press('Escape');
    await row(page, 'br:local:local:develop').dblclick();
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
    // The empty field says so (a placeholder, which is not the form's text);
    // the title names the one branch api and web are both on.
    await expect(form.getByLabel('Start point')).toHaveAttribute('placeholder', 'each repository’s current branch');
    await expect(form).toContainText('New branch from feature/login');
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
    await mistracked.dblclick();
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
    await mistracked.dblclick();
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
    await develop.dblclick();
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
    await header.dblclick();
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
    await develop.dblclick();
    // api tracks elsewhere and web does not: two lines, and only api's has the link.
    await expect(develop.locator('.gtp-card .gtp-card-repo')).toHaveText(['api', 'web', 'not in shared']);
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

  test("the selected row's matched letters take VS Code's colour for a selection, while the list has the focus", async ({
    page,
  }) => {
    await openPanel(page);
    // Light+'s: a blue selection, on which the plain highlight's blue all but vanished.
    const HIGHLIGHT = 'rgb(0, 102, 191)';
    const FOCUS_HIGHLIGHT = 'rgb(187, 231, 255)';
    await page.evaluate(
      ([plain, focus]) => {
        const s = document.documentElement.style;
        s.setProperty('--vscode-list-activeSelectionBackground', 'rgb(0, 96, 192)');
        s.setProperty('--vscode-list-highlightForeground', plain!);
        s.setProperty('--vscode-list-focusHighlightForeground', focus!);
      },
      [HIGHLIGHT, FOCUS_HIGHLIGHT],
    );
    const marked = (id: string): Promise<string> =>
      row(page, id)
        .locator('.gtp-match')
        .first()
        .evaluate((el) => getComputedStyle(el).color);
    const filter = page.getByLabel('Filter branches');
    await filter.fill('main');
    expect(await marked('br:local:local:main')).toBe(HIGHLIGHT);
    await filter.press('ArrowDown');
    await expect(row(page, 'br:local:local:main')).toBeFocused();
    expect(await marked('br:local:local:main')).toBe(FOCUS_HIGHLIGHT);
    // Every other row keeps the plain colour, and so does this one once the list loses the focus.
    expect(await marked('br:remote:remote:origin/main')).toBe(HIGHLIGHT);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await marked('br:local:local:main')).toBe(HIGHLIGHT);
  });
});

test.describe('which repositories a branch is in (POST-P14bt)', () => {
  /** The words a row says about where its branch is, as shown in a wide sidebar. */
  const words = (page: Page, id: string): Locator => row(page, id).locator('.gtp-where-text');

  test("a search's matches say which repositories have them, with no repository picked", async ({ page }) => {
    await openPanel(page);
    const filter = page.getByLabel('Filter branches');
    await filter.fill('develop');
    // api and web have develop, shared does not.
    await expect(words(page, 'br:local:local:develop')).toHaveText('in api, web');
    await expect(words(page, 'br:local:local:develop')).toBeVisible();
    await expect(row(page, 'br:local:local:develop').locator('.gtp-where-short')).toBeHidden();
    await expect(words(page, 'br:remote:remote:origin/develop')).toHaveText('in api, web');
    // Every repository: said, not left blank.
    await filter.fill('main');
    await expect(words(page, 'br:local:local:main')).toHaveText('in all 3');
    await expect(words(page, 'br:remote:remote:origin/main')).toHaveText('in all 3');
    await filter.fill('types');
    await expect(words(page, 'br:local:local:refactor/types')).toHaveText('in shared');
  });

  test('its hover names every repository, and a screen reader hears them', async ({ page }) => {
    await openPanel(page);
    const filter = page.getByLabel('Filter branches');
    await filter.fill('develop');
    const develop = row(page, 'br:local:local:develop');
    await expect(develop.locator('.gtp-branch')).toHaveAttribute(
      'title',
      /^develop\nIn api and web\nNot in shared\nWork on develop\nDouble-click or Enter for details/u,
    );
    await expect(develop).toHaveAttribute('aria-label', 'develop, in api and web');
    await filter.fill('main');
    const main = row(page, 'br:local:local:main');
    await expect(main.locator('.gtp-branch')).toHaveAttribute(
      'title',
      /^main\nIn all 3 repositories: api, shared and web\nChecked out in shared\n/u,
    );
    await expect(main).toHaveAttribute('aria-label', 'main, checked out, in all 3 repositories');
  });

  test("the tabs' rows say it too", async ({ page }) => {
    await openPanel(page);
    await expect(words(page, 'br:recent:local:develop')).toHaveText('in api, web');
    await showTab(page, 'Local');
    await expect(words(page, 'br:local:local:main')).toHaveText('in all 3');
    await row(page, 'dir:local:refactor/').click();
    await expect(words(page, 'br:local:local:refactor/types')).toHaveText('in shared');
    await showTab(page, 'Remote');
    await expect(words(page, 'br:remote:remote:origin/develop')).toHaveText('in api, web');
  });

  test('they speak of the repositories in view: nothing narrowed to one, both narrowed to two', async ({
    page,
  }) => {
    await openPanel(page);
    // Picked in the Repositories panel: web, then api with it.
    await pickElsewhere(page, [WEB]);
    await page.getByLabel('Filter branches').fill('develop');
    const develop = row(page, 'br:local:local:develop');
    await expect(develop).toBeVisible();
    await expect(develop.locator('.gtp-where')).toHaveCount(0);
    await expect(develop).toHaveAttribute('aria-label', 'develop');

    await pickElsewhere(page, [WEB, API]);
    await expect(words(page, 'br:local:local:develop')).toHaveText('in both');
    await expect(develop).toHaveAttribute('aria-label', 'develop, in both repositories');
  });

  test('with the Repository Dots on, the dots say it in place of the words', async ({ page }) => {
    await openPanel(page, { dots: true });
    await page.getByLabel('Filter branches').fill('develop');
    const develop = row(page, 'br:local:local:develop');
    await expect(develop.locator('.gtp-markers .gtp-marker')).toHaveCount(3);
    await expect(develop.locator('.gtp-where')).toHaveCount(0);
    // A screen reader cannot see the dots: it still hears the words.
    await expect(develop).toHaveAttribute('aria-label', 'develop, in api and web');
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'Repository Dots' }).click();
    await expect(develop.locator('.gtp-markers')).toHaveCount(0);
    await expect(words(page, 'br:local:local:develop')).toHaveText('in api, web');
  });

  test('twenty repositories: counted past three, and every one is "in all 20"', async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<Record<string, unknown>> };
        __pushState: () => void;
      };
      // Seventeen more like api: feature/login, main and develop.
      const base = w.__mockState.repos[0]!;
      for (let i = 1; i <= 17; i++) {
        w.__mockState.repos.push({ ...base, root: `/work/extra-${i}`, label: `extra-${i}` });
      }
      w.__pushState();
    });
    await page.getByLabel('Filter branches').fill('develop');
    const develop = row(page, 'br:local:local:develop');
    await expect(words(page, 'br:local:local:develop')).toHaveText('in 19 of 20');
    await expect(develop.locator('.gtp-branch')).toHaveAttribute(
      'title',
      /^develop\nIn 19 of 20 repositories: api, web, extra-1, extra-2, .*extra-17\nNot in shared\n/u,
    );
    await expect(develop).toHaveAttribute('aria-label', 'develop, in 19 of 20 repositories');
    await page.getByLabel('Filter branches').fill('main');
    await expect(words(page, 'br:local:local:main')).toHaveText('in all 20');
  });

  test("the words hold still, and whole, when the row's buttons show", async ({ page }) => {
    // A usual sidebar's width, where a long name and the buttons leave little room.
    await page.setViewportSize({ width: 300, height: 600 });
    await openPanel(page);
    await page.addStyleTag({ content: VS_CODE_FONT });
    await page.getByLabel('Filter branches').fill('feature');
    const mistracked = row(page, 'br:local:local:feature/mistracked');
    const where = mistracked.locator('.gtp-where');
    const x = async (selector: string): Promise<number> =>
      (await mistracked.locator(selector).boundingBox())!.x;
    const place = async () => ({
      sync: await x('.gtp-sync'),
      where: (await where.boundingBox())!,
      age: await x('.gtp-age'),
    });
    const at = await place();
    // In the dots' place: after the counts, right before the age.
    expect(at.sync).toBeLessThan(at.where.x);
    expect(at.where.x + at.where.width).toBeLessThanOrEqual(at.age);
    expect(await isCut(where)).toBe(false);

    await mistracked.hover();
    await expect(mistracked.getByRole('button', { name: 'Checkout' })).toBeVisible();
    // The name gives way to the buttons; the words do not, by so much as a fraction of a
    // pixel, which would already end them in `…`.
    expect(await place()).toEqual(at);
    expect(await isCut(where)).toBe(false);
    await expect(where.locator('.gtp-where-text')).toHaveText('in web');
    const buttons = (await mistracked.locator('.gtp-row-buttons').boundingBox())!;
    expect(buttons.x + buttons.width).toBeLessThanOrEqual(at.sync + 0.5);
  });
});

test.describe('one repository', () => {
  test("the current branch's menu leaves out the repository's Show in New Log Tab", async ({
    page,
  }) => {
    await openPanel(page, { single: true });
    await row(page, `head:${WEB}`).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for web' });
    await expect(menu).toBeVisible();
    // The branch's own stands in its part of the menu (the mock's branch menu has
    // none); the repository's, its history at HEAD, would say the same again.
    await expect(menu.getByRole('menuitem', { name: 'Show in New Log Tab' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Update Project…' })).toBeVisible();
    // No rule left dangling under the Repository heading.
    const afterHeading = await menu.evaluate((el) => {
      const all = [...el.querySelectorAll('[role="menuitem"], [role="separator"], .gt-menu-header')];
      const at = all.findIndex((e) => (e.textContent ?? '').trim() === 'Repository');
      return all[at + 1]?.getAttribute('role');
    });
    expect(afterHeading).toBe('menuitem');
  });

  test('starts with the current branch, whose card says where it stands', async ({ page }) => {
    await openPanel(page, { single: true });
    const head = row(page, `head:${WEB}`);
    await expect(head).toHaveAttribute('aria-label', 'Current branch feature/login');
    await expect(page.locator('[data-row-id^="repo:"]')).toHaveCount(0);
    await head.click();
    await expect(head.locator('.gtp-card')).toHaveCount(0);
    await head.dblclick();
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
    // Enter opens it too, and Escape shuts it.
    await page.keyboard.press('Enter');
    await expect(develop).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
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

  test('one repository has no Repository Dots to show: no button, no menu row', async ({ page }) => {
    await openPanel(page, { single: true });
    await expect(page.locator('.gtp-toolbar').getByRole('button', { name: 'Repository Dots' })).toHaveCount(0);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Tags' })).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Repository Dots' })).toHaveCount(0);
  });

  test('More Actions offers Update Project Without Fetching right under Update Project', async ({ page }) => {
    await openPanel(page, { single: true });
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    await expect(menu).toBeVisible();
    const firstRows = await menu.evaluate((el) =>
      [...el.querySelectorAll('[role="menuitem"]')].slice(0, 3).map((e) => e.getAttribute('aria-label') ?? (e.textContent ?? '').trim()),
    );
    expect(firstRows[0]).toContain('Update Project…');
    expect(firstRows[1]).toContain('Update Project Without Fetching…');
    expect(firstRows[2]).toContain('Commit…');
    await menu.getByRole('menuitem', { name: 'Update Project Without Fetching…' }).click();
    // The workspace's only repository is the project: its update, as Ctrl+T's (POST-P14bx).
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'inView', verb: 'updateWithoutFetch', roots: [] },
    });
  });

  test("the only repository's own update is the project's too, from its row and its menu (POST-P14bx)", async ({
    page,
  }) => {
    await openPanel(page, { single: true });
    const head = row(page, `head:${WEB}`);
    await head.hover();
    await expect(head.getByRole('button', { name: 'Update Repository…' })).toHaveCount(0);
    await head.getByRole('button', { name: 'Update Project…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.update.dialog', root: WEB },
    });
    await head.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for web' });
    await expect(menu.getByRole('menuitem', { name: 'Update Repository…' })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Update Project Without Fetching…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'command', command: 'gittree.update.withoutFetch', root: WEB },
    });
  });

  test('with several repositories in view, Update Project Without Fetching is the project', async ({ page }) => {
    await openPanel(page);
    await page.locator('.gtp-toolbar').getByRole('button', { name: 'More Actions' }).click();
    await page.getByRole('menuitem', { name: 'Update Project Without Fetching…' }).click();
    expect((await requests(page, 'branches/run')).at(-1)).toEqual({
      run: { type: 'inView', verb: 'updateWithoutFetch', roots: [] },
    });
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

  test('with several repositories, the tabs head the Branches panel: its repositories are a panel of their own', async ({
    page,
  }) => {
    await openPanel(page);
    const order = await page.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    expect(order[0]).toBe('tabs');
    expect(order.some((id) => id?.startsWith('repo:') === true || id?.startsWith('op:') === true)).toBe(false);
    await expect(page.locator('#gtp-branches-list [data-row-id="tabs"]')).toBeVisible();
  });
});

async function vsState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () => ((window as unknown as { __mockVsState?: Record<string, unknown> }).__mockVsState ?? {}),
  );
}

/**
 * POST-P14co: the panel that was two panes is two panels. Each is a VS Code
 * view, which folds, resizes and scrolls on its own; the pick is one for both.
 */
test.describe('the Repositories and Branches panels (POST-P14co)', () => {
  test('the Repositories panel lists the repositories alone: no toolbar, no heading, no branch', async ({ page }) => {
    await openPanel(page, { role: 'repositories' });
    await expect(page.locator('.gtp-toolbar')).toHaveCount(0);
    await expect(page.getByLabel('Filter branches')).toHaveCount(0);
    const ids = await page.locator('[data-row-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')));
    expect(ids).toEqual([`repo:${API}`, `repo:${SHARED}`, `op:${SHARED}`, `repo:${WEB}`]);
    // Nothing in it counts or names the pick: VS Code's own header names the
    // panel, the highlight the pick, and the Branches panel's pill widens it.
    await row(page, `repo:${WEB}`).click();
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Show all', { exact: true })).toHaveCount(0);
    await expect(page.locator('.gtp-count')).toHaveCount(0);
  });

  test('the Branches panel has the toolbar and the branches, and no repository', async ({ page }) => {
    await openPanel(page);
    await expect(page.locator('.gtp-toolbar').getByLabel('Filter branches')).toBeVisible();
    await expect(page.locator('[data-row-id^="repo:"]')).toHaveCount(0);
    await expect(page.locator('[data-row-id^="op:"]')).toHaveCount(0);
    await expect(page.locator('.gtp-edge')).toHaveCount(0);
  });

  test('a line along the Repositories panel’s foot marks the divider above the Branches panel (POST-P14bu)', async ({
    page,
  }) => {
    await openPanel(page, { role: 'repositories' });
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--vscode-gittree-sectionBorder', 'rgb(1, 2, 3)'),
    );
    const edge = await page.locator('.gtp-edge').evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        line: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        bottom: Math.round(el.getBoundingClientRect().bottom),
        events: s.pointerEvents,
      };
    });
    // Along the very foot, where VS Code's divider is, and never in the way of its drag.
    expect(edge).toEqual({ line: '2px solid rgb(1, 2, 3)', bottom: page.viewportSize()!.height, events: 'none' });
  });

  test('a pick the host kept shows in both: highlighted in one, named in the other', async ({ page }) => {
    const { repos, branches } = await openBoth(page, { scope: [API] });
    await expect(row(repos, `repo:${API}`)).toHaveAttribute('aria-selected', 'true');
    await expect(row(repos, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'false');
    await expect(branches.getByLabel('Filter branches')).toHaveAttribute('placeholder', filterIn('api'));
    await expect(branches.getByRole('button', { name: /^Narrowed to api/u })).toBeVisible();
  });

  test('typing in the Repositories panel goes to the Branches panel’s filter; Ctrl+F too', async ({ page }) => {
    const { repos, branches } = await openBoth(page);
    await row(repos, `repo:${API}`).click();
    await repos.keyboard.press('m');
    expect((await requests(repos, 'branches/searchFor')).at(-1)).toEqual({ text: 'm' });
    await expect(branches.getByLabel('Filter branches')).toHaveValue('m');
    await expect(row(branches, 'sec:local')).toBeVisible();
    await repos.keyboard.press('Control+f');
    expect((await requests(repos, 'branches/searchFor')).at(-1)).toEqual({});
    // The Repositories panel kept its own keyboard row.
    await expect(row(repos, `repo:${API}`)).toBeFocused();
  });

  test('an @ typed in the Repositories panel opens the Branches panel’s picker', async ({ page }) => {
    const { repos, branches } = await openBoth(page);
    await row(repos, `repo:${API}`).click();
    await repos.keyboard.press('@');
    await expect(branches.getByTestId('repo-picker')).toBeVisible();
    await expect(branches.getByLabel('Filter branches')).toHaveValue('@');
  });

  test("a repository's New Branch… opens the form in the Branches panel, for that repository", async ({ page }) => {
    const { repos, branches } = await openBoth(page);
    await row(repos, `repo:${WEB}`).click({ button: 'right' });
    await repos.getByRole('menu', { name: 'Actions for web' }).getByRole('menuitem', { name: 'New Branch…' }).click();
    expect((await requests(repos, 'branches/run')).at(-1)).toEqual({
      run: { type: 'newBranch', from: 'HEAD', roots: [WEB] },
    });
    await expect(repos.getByRole('form', { name: 'New branch' })).toHaveCount(0);
    const form = branches.getByRole('form', { name: 'New branch' });
    await expect(form).toBeVisible();
    await form.getByLabel('Branch name').fill('feature/from-repositories');
    await form.getByRole('button', { name: 'Create' }).click();
    expect((await requests(branches, 'branches/create')).at(-1)).toEqual({
      name: 'feature/from-repositories',
      from: 'HEAD',
      roots: [WEB],
      checkout: true,
    });
  });

  test('Up from the top of the branches goes to the filter, and Escape there back to the row', async ({ page }) => {
    await openPanel(page);
    const filter = page.getByLabel('Filter branches');
    await filter.press('ArrowDown');
    await expect(row(page, 'tabs')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(filter).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(row(page, 'tabs')).toBeFocused();
  });
});

/**
 * POST-P14co: an `@` in the Branches panel's filter lists the repositories, a
 * square box each. A tick picks: the side bar's one pick, which the pill names
 * and the Repositories panel highlights. None ticked is every repository.
 */
test.describe('the @ in the filter picks repositories (POST-P14co)', () => {
  const picker = (page: Page): Locator => page.getByTestId('repo-picker');
  const pickerRow = (page: Page, name: string): Locator => picker(page).locator(`[data-picker-row="${name}"]`);
  /** The list as it reads: `[x] api` for a ticked repository, `all` for All repositories. */
  const ticks = (page: Page): Promise<string[]> =>
    picker(page)
      .locator('[role="option"]')
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('aria-selected') === 'true' ? '[x]' : '[ ]'} ${e.getAttribute('data-picker-row')}`),
      );
  const sentPicks = async (page: Page) => (await requests(page, 'branches/setScope')).map((p) => p['roots']);
  async function typeInFilter(page: Page, text: string): Promise<Locator> {
    const filter = page.getByLabel('Filter branches');
    await filter.focus();
    await page.keyboard.type(text);
    return filter;
  }

  test('an @ lists every repository with a square box; with none picked, All repositories is the one ticked', async ({
    page,
  }) => {
    await openPanel(page);
    const filter = page.getByLabel('Filter branches');
    // The field says what an `@` does, and is the combobox of the list it opens.
    await expect(filter).toHaveAttribute('placeholder', filterIn('3 repositories'));
    await expect(filter).toHaveAttribute('role', 'combobox');
    await expect(filter).toHaveAttribute('aria-expanded', 'false');
    await typeInFilter(page, '@');
    await expect(picker(page)).toBeVisible();
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    await expect(filter).toHaveAttribute('aria-controls', 'gtp-repo-picker');
    await expect(picker(page).getByRole('listbox', { name: 'Repositories' })).toHaveAttribute(
      'aria-multiselectable',
      'true',
    );
    expect(await ticks(page)).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
    // Square boxes, VS Code's checkboxes: not the rows' round dots.
    await expect(pickerRow(page, 'all').locator('.gt-tricheck')).toHaveAttribute('data-state', 'checked');
    await expect(pickerRow(page, 'web').locator('.gt-tricheck')).toHaveAttribute('data-state', 'unchecked');
    // Each repository with its colour and what it has checked out.
    await expect(pickerRow(page, 'web')).toContainText('web');
    await expect(pickerRow(page, 'web').locator('.gtp-picker-head')).toHaveText('feature/login');
    // The first row is the highlighted one, and the field names it.
    await expect(filter).toHaveAttribute('aria-activedescendant', 'gtp-repo-picker-0');
    await expect(picker(page)).toContainText('Enter ticks and closes');
    // The @ is no part of what the branches are filtered by: the tabs stay.
    await expect(row(page, 'tabs')).toBeVisible();
  });

  test('what follows the @ narrows the list; Enter ticks the highlighted one and closes, taking the @ out', async ({
    page,
  }) => {
    await openPanel(page);
    const filter = await typeInFilter(page, 'log @we');
    expect(await ticks(page)).toEqual(['[ ] web']);
    await expect(pickerRow(page, 'web').locator('.gtp-match')).toHaveText('we');
    // What comes before the @ still filters the branches.
    await expect(row(page, 'br:local:local:feature/login')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(picker(page)).toHaveCount(0);
    await expect(filter).toHaveValue('log ');
    await expect(filter).toBeFocused();
    expect(await sentPicks(page)).toEqual([[WEB]]);
    await expect(page.getByRole('button', { name: /^Narrowed to web/u })).toBeVisible();
    await expect(row(page, 'br:local:local:feature/login')).toBeVisible();
  });

  test('a click ticks and leaves the list open for the next; unticking the last shows every repository again', async ({
    page,
  }) => {
    await openPanel(page);
    await typeInFilter(page, '@');
    await pickerRow(page, 'api').click();
    await expect(picker(page)).toBeVisible();
    expect(await ticks(page)).toEqual(['[ ] all', '[x] api', '[ ] shared', '[ ] web']);
    await pickerRow(page, 'web').click();
    expect(await ticks(page)).toEqual(['[ ] all', '[x] api', '[ ] shared', '[x] web']);
    await expect(page.getByRole('button', { name: /^Narrowed to 2 repositories/u })).toBeVisible();
    // The field kept the keyboard all along.
    await expect(page.getByLabel('Filter branches')).toBeFocused();
    await pickerRow(page, 'api').click();
    await pickerRow(page, 'web').click();
    expect(await ticks(page)).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
    expect(await sentPicks(page)).toEqual([[API], [API, WEB], [WEB], []]);
  });

  test('ticking every repository is no pick, and All repositories clears one', async ({ page }) => {
    await openPanel(page, { scope: [API] });
    await typeInFilter(page, '@');
    expect(await ticks(page)).toEqual(['[ ] all', '[x] api', '[ ] shared', '[ ] web']);
    await pickerRow(page, 'shared').click();
    await pickerRow(page, 'web').click();
    expect(await ticks(page)).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
    await pickerRow(page, 'web').click();
    await pickerRow(page, 'all').click();
    expect(await ticks(page)).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
    expect(await sentPicks(page)).toEqual([[API, SHARED], [], [WEB], []]);
  });

  test('the arrows move the highlight round the ends; Escape closes it and picks nothing', async ({ page }) => {
    await openPanel(page);
    const filter = await typeInFilter(page, '@');
    await page.keyboard.press('ArrowDown');
    await expect(pickerRow(page, 'api')).toHaveClass(/gtp-picker-active/u);
    await expect(filter).toHaveAttribute('aria-activedescendant', 'gtp-repo-picker-1');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(pickerRow(page, 'web')).toHaveClass(/gtp-picker-active/u);
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await expect(filter).toHaveValue('');
    await expect(filter).toHaveAttribute('aria-expanded', 'false');
    expect(await sentPicks(page)).toEqual([]);
  });

  test('leaving the field closes the list and takes the @ out, the filter before it kept', async ({ page }) => {
    await openPanel(page);
    const filter = await typeInFilter(page, 'feat @sh');
    await expect(picker(page)).toBeVisible();
    await filter.blur();
    await expect(picker(page)).toHaveCount(0);
    await expect(filter).toHaveValue('feat ');
  });

  test('an @ inside a word is searched for, as a branch name may hold one', async ({ page }) => {
    await openPanel(page);
    const filter = await typeInFilter(page, 'a@b');
    await expect(picker(page)).toHaveCount(0);
    await expect(filter).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'hint:nomatch')).toContainText('No branch matches “a@b”');
  });

  test('a name with spaces: what follows the @ runs on over them', async ({ page }) => {
    await openPanel(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        __mockState: { repos: Array<Record<string, unknown>> };
        __pushState: () => void;
      };
      w.__mockState.repos.push({ ...w.__mockState.repos[0]!, root: '/work/local - Copy', label: 'local - Copy' });
      w.__pushState();
    });
    await typeInFilter(page, '@local - c');
    expect(await ticks(page)).toEqual(['[ ] local - Copy']);
    await page.keyboard.press('Enter');
    expect(await sentPicks(page)).toEqual([['/work/local - Copy']]);
    await expect(page.getByRole('button', { name: /^Narrowed to local - Copy/u })).toBeVisible();
  });

  test('with one repository there is nothing to pick: an @ is searched for', async ({ page }) => {
    await openPanel(page, { single: true });
    const filter = page.getByLabel('Filter branches');
    await expect(filter).toHaveAttribute('placeholder', 'Filter branches');
    await expect(filter).not.toHaveAttribute('role', 'combobox');
    await typeInFilter(page, '@');
    await expect(picker(page)).toHaveCount(0);
    await expect(filter).toHaveValue('@');
  });

  test('a tick reaches the Repositories panel, and a Ctrl+click there shows as a tick', async ({ page }) => {
    const { repos, branches } = await openBoth(page);
    await typeInFilter(branches, '@web');
    await branches.keyboard.press('Enter');
    await expect(row(repos, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    await expect(row(repos, `repo:${API}`)).toHaveAttribute('aria-selected', 'false');
    await row(repos, `repo:${API}`).click({ modifiers: ['Control'] });
    await expect(branches.getByRole('button', { name: /^Narrowed to 2 repositories/u })).toBeVisible();
    await typeInFilter(branches, '@');
    expect(await ticks(branches)).toEqual(['[ ] all', '[x] api', '[ ] shared', '[x] web']);
  });
});

test.describe('a narrow sidebar', () => {
  const visibleButtons = (l: Locator): Locator => l.locator('.gtp-row-buttons > button:visible');

  test('the current branch keeps its name, and what it tracks gives way first', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 600 });
    await openPanel(page, { single: true });
    await page.addStyleTag({ content: VS_CODE_FONT });
    const head = row(page, `head:${WEB}`);
    await page.getByLabel('Filter branches').press('ArrowDown');
    await expect(head).toBeFocused();
    // Its buttons show, and still `feature/login` is whole: `origin/feature/login` is what shrinks.
    await expect(visibleButtons(head)).toHaveCount(4);
    await expect.poll(() => isCut(head.locator('.gtp-head-name'))).toBe(false);
    await expect.poll(() => isCut(head.locator('.gtp-head-upstream'))).toBe(true);
    await expect(head.locator('.gtp-head-upstream')).toHaveAttribute('title', 'Tracks origin/feature/login');
  });

  test("narrower, a repository's row keeps only ⋯, then leaves out its changes and what it tracks", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await openPanel(page, { single: true });
    await page.addStyleTag({ content: VS_CODE_FONT });
    const head = row(page, `head:${WEB}`);
    await page.getByLabel('Filter branches').press('ArrowDown');
    await expect(visibleButtons(head)).toHaveCount(4);
    await page.setViewportSize({ width: 230, height: 600 });
    await expect(visibleButtons(head)).toHaveCount(1);
    await expect(visibleButtons(head)).toHaveAttribute('title', 'More Actions…');
    await expect(head.locator('.gtp-changes')).toBeVisible();
    await page.setViewportSize({ width: 180, height: 600 });
    await expect(head.locator('.gtp-changes')).toBeHidden();
    await expect(head.locator('.gtp-head-upstream')).toBeHidden();
    // The name has the room they left.
    await expect(head.locator('.gtp-head-name')).toBeVisible();
  });

  test("with several repositories, a repository's row on hover keeps only ⋯ too", async ({ page }) => {
    await page.setViewportSize({ width: 230, height: 600 });
    await openPanel(page, { role: 'repositories' });
    await page.addStyleTag({ content: VS_CODE_FONT });
    const api = row(page, `repo:${API}`);
    await api.hover();
    await expect(visibleButtons(api)).toHaveCount(1);
    await expect.poll(() => isCut(api.locator('.gtp-repo-name'))).toBe(false);
  });

  test("a card's buttons drop their words, the first one's last, before any is cut off", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 600 });
    await openPanel(page, { single: true });
    await page.addStyleTag({ content: VS_CODE_FONT });
    const head = row(page, `head:${WEB}`);
    await head.dblclick();
    const buttons = head.locator('.gtp-card-buttons');
    await expect(buttons).toHaveAttribute('data-fit', 'full');
    await expect(buttons.getByRole('button', { name: 'Checkout' }).locator('.gtp-button-label')).toBeVisible();
    for (const width of [300, 220, 180, 170]) {
      await page.setViewportSize({ width, height: 600 });
      await expect
        .poll(() =>
          buttons.evaluate((el) =>
            [...el.querySelectorAll('button')].every(
              (b) => b.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5,
            ),
          ),
        )
        .toBe(true);
      // Never a label shrunk to a letter or two: whole, or not there.
      for (const label of await buttons.locator('.gtp-button-label:visible').all()) {
        expect(await isCut(label)).toBe(false);
      }
    }
    await expect(buttons).not.toHaveAttribute('data-fit', 'full');
    // An icon alone is still named, for a screen reader and on its hover.
    await expect(buttons.getByRole('button', { name: 'New Branch…' })).toHaveAttribute(
      'title',
      "New Branch from 'feature/login'…",
    );
  });

  test("a branch's repositories are counted in a narrow sidebar, and left to the hover in a narrower one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 400, height: 600 });
    await openPanel(page);
    await page.addStyleTag({ content: VS_CODE_FONT });
    await page.getByLabel('Filter branches').fill('develop');
    const develop = row(page, 'br:local:local:develop');
    await expect(develop.locator('.gtp-where-text')).toBeVisible();
    await expect(develop.locator('.gtp-where-text')).toHaveText('in api, web');
    await expect(develop.locator('.gtp-where-short')).toBeHidden();
    // Below about 250px the names give way to a count, so the branch keeps its room.
    await page.setViewportSize({ width: 230, height: 600 });
    await expect(develop.locator('.gtp-where-text')).toBeHidden();
    await expect(develop.locator('.gtp-where-short')).toBeVisible();
    await expect(develop.locator('.gtp-where-short')).toHaveText('in 2');
    // Below about 190px the row keeps its name; its hover still says where.
    await page.setViewportSize({ width: 180, height: 600 });
    await expect(develop.locator('.gtp-where')).toBeHidden();
    await expect(develop.locator('.gtp-name')).toBeVisible();
    await expect(develop.locator('.gtp-branch')).toHaveAttribute('title', /\nIn api and web\n/u);
  });

  test('a narrow card leaves out who made the last commit, and keeps when', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 600 });
    await openPanel(page, { single: true });
    await page.addStyleTag({ content: VS_CODE_FONT });
    const head = row(page, `head:${WEB}`);
    await head.dblclick();
    const meta = head.locator('.gtp-card-meta');
    await expect(head.locator('.gtp-card-author')).toBeVisible();
    await expect(meta).toContainText('Alice · ');
    await page.setViewportSize({ width: 240, height: 600 });
    await expect(head.locator('.gtp-card-author')).toBeHidden();
    await expect(meta).toBeVisible();
    await expect(meta).toHaveAttribute('title', /^Alice · /u);
  });
});

test.describe('the pick is the host’s, which the Commit window follows (POST-P14ce)', () => {
  /**
   * A panel with the pick the host kept (`undefined`: nothing kept yet) and the
   * panel's own old copy; the Branches panel unless `role` says Repositories.
   */
  async function openPicked(page: Page, opts: { kept?: string[]; old?: string[]; role?: Role } = {}): Promise<void> {
    await page.addInitScript((o) => {
      const w = window as unknown as Record<string, unknown>;
      if (o.kept !== undefined) w['__mockScope'] = o.kept;
      if (o.old !== undefined) w['__mockVsState'] = { scope: o.old };
      if (o.role !== undefined) w['__mockRole'] = o.role;
    }, opts);
    await page.addInitScript(mockBranchesHostScript);
    await page.goto('/branches.html');
    await expect(page.locator('[data-row-id]').first()).toBeVisible();
  }
  const filterField = (page: Page): Locator => page.getByLabel('Filter branches');
  const sentPicks = async (page: Page) => (await requests(page, 'branches/setScope')).map((p) => p['roots']);

  test('a click and a Ctrl+click in the Repositories panel tell the host the pick, at once in the panel', async ({
    page,
  }) => {
    await openPicked(page, { role: 'repositories' });
    await row(page, `repo:${WEB}`).click();
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    await row(page, `repo:${API}`).click({ modifiers: ['Control'] });
    await expect(row(page, `repo:${API}`)).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, `repo:${SHARED}`)).toHaveAttribute('aria-selected', 'false');
    expect(await sentPicks(page)).toEqual([[WEB], [WEB, API]]);
  });

  test("the Branches panel's pill tells it too, at once in the panel", async ({ page }) => {
    await openPicked(page, { kept: [WEB, API] });
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('2 repositories'));
    await page.getByRole('button', { name: /^Narrowed to 2 repositories/u }).click();
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('3 repositories'));
    expect(await sentPicks(page)).toEqual([[]]);
  });

  test("a repository's menu tells it too: Show Only This Repository, then Show All Repositories", async ({ page }) => {
    await openPicked(page, { role: 'repositories' });
    await row(page, `repo:${SHARED}`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show Only This Repository' }).click();
    await expect(row(page, `repo:${SHARED}`)).toHaveAttribute('aria-selected', 'true');
    await row(page, `repo:${SHARED}`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show All Repositories' }).click();
    await expect(row(page, `repo:${SHARED}`)).toHaveAttribute('aria-selected', 'false');
    expect(await sentPicks(page)).toEqual([[SHARED], []]);
  });

  test('each panel opens on the pick the host kept', async ({ page }) => {
    const { repos, branches } = await openBoth(page, { scope: [API] });
    await expect(branches.getByLabel('Filter branches')).toHaveAttribute('placeholder', filterIn('api'));
    await expect(row(repos, `repo:${API}`)).toHaveAttribute('aria-selected', 'true');
    expect(await sentPicks(repos)).toEqual([]);
    expect(await sentPicks(branches)).toEqual([]);
  });

  test('a pick made in the Commit window comes in: its Show all widens the panel, its Show Only narrows it', async ({
    page,
  }) => {
    await openPicked(page, { kept: [WEB] });
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('web'));
    await pickElsewhere(page, []);
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('3 repositories'));
    // And its Show Only This Repository narrows it.
    await pickElsewhere(page, [SHARED]);
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('shared'));
    // Nothing was asked of the host for it: the host made it.
    expect(await sentPicks(page)).toEqual([]);
  });

  test('the pick it kept itself before is handed to the host once, and no longer kept by the panel', async ({
    page,
  }) => {
    await openPicked(page, { old: [SHARED] });
    expect((await requests(page, 'branches/init'))[0]).toEqual({ scope: [SHARED] });
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('shared'));
    // The panel's own state forgets it on its next save.
    await showTab(page, 'Local');
    await expect.poll(async () => (await vsState(page))['scope']).toBeUndefined();
  });

  test("an old pick does not override the host's", async ({ page }) => {
    await openPicked(page, { kept: [API], old: [SHARED] });
    await expect(filterField(page)).toHaveAttribute('placeholder', filterIn('api'));
  });

  test("a name on the Commit window's filter bar puts the Repositories panel's keyboard on its row; the pick stays", async ({
    page,
  }) => {
    await openPicked(page, { kept: [WEB], role: 'repositories' });
    await page.evaluate((root) => (window as unknown as { __mockReveal(r: string): void }).__mockReveal(root), WEB);
    await expect(row(page, `repo:${WEB}`)).toBeFocused();
    await expect(row(page, `repo:${WEB}`)).toHaveAttribute('aria-selected', 'true');
    expect(await sentPicks(page)).toEqual([]);
  });
});
