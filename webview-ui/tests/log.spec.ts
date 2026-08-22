import { expect, test, type Page } from '@playwright/test';
import { mockLogHostScript } from './mockLogHost';

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openLog(page: Page): Promise<void> {
  await page.addInitScript(mockLogHostScript);
  await page.goto('/log.html');
  await expect(page.getByTestId('log-row-0')).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(() => (window as unknown as { __postedMessages: unknown }).__postedMessages)) as PostedMsg[];
}

test.describe('P4-T3/T4 log webview', () => {
  test('streams the first page and windows the DOM', async ({ page }) => {
    await openLog(page);
    const list = page.getByRole('listbox', { name: 'Commits' });
    await expect(list).toBeVisible();
    const rendered = await list.locator('[data-gt-row]').count();
    expect(rendered).toBeLessThan(80); // 2000 rows loaded, ~viewport rendered
    await expect(page.locator('.gt-ref-chip').first()).toHaveText('main');
    // Graph canvas painted.
    await expect(page.locator('.gt-log-graph-canvas')).toBeVisible();
  });

  test('infinite scroll requests further pages', async ({ page }) => {
    await openLog(page);
    const list = page.getByRole('listbox', { name: 'Commits' });
    // Jump near the end of page 0 → sentinel asks for page 1.
    await list.evaluate((el) => {
      el.scrollTop = 1990 * 24;
    });
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'log/page').length)
      .toBeGreaterThan(1);
    await list.evaluate((el) => {
      el.scrollTop = 3500 * 24;
    });
    await expect(page.getByTestId('log-row-3500')).toBeVisible();
    const rendered = await list.locator('[data-gt-row]').count();
    expect(rendered).toBeLessThan(80); // still windowed after 4k rows
  });

  test('selection updates data-vscode-context (single + ctrl multi)', async ({ page }) => {
    await openLog(page);
    await page.locator('[data-gt-row="2"]').click();
    const ctxSingle = await page.locator('[data-gt-row="2"]').getAttribute('data-vscode-context');
    const parsedSingle = JSON.parse(ctxSingle ?? '{}') as { sha: string; shas: string[]; webviewSection: string };
    expect(parsedSingle.webviewSection).toBe('commit');
    expect(parsedSingle.shas).toHaveLength(1);

    await page.locator('[data-gt-row="4"]').click({ modifiers: ['Control'] });
    const ctxMulti = await page.locator('[data-gt-row="4"]').getAttribute('data-vscode-context');
    const parsedMulti = JSON.parse(ctxMulti ?? '{}') as { shas: string[] };
    expect(parsedMulti.shas.length).toBe(2);
  });

  test('selection fills Commit Details and Changed Files; file click posts openFileDiff', async ({ page }) => {
    await openLog(page);
    await page.locator('[data-gt-row="1"]').click();
    // P12-T1: the right column is two panes — meta in Details, files in
    // Changed Files — both fed by the same selection.
    const details = page.getByTestId('details-panel');
    await expect(details).toContainText('Alice');
    const files = page.getByTestId('changed-files');
    await expect(files).toContainText('src/app.ts');
    await expect(files).toContainText('src/old.ts'); // rename pair visible

    await files.getByRole('listitem').first().click();
    const msgs = await posted(page);
    expect(msgs.some((m) => m.method === 'log/openFileDiff')).toBe(true);
  });

  test('filter bar round-trips: search text and sort produce setFilter', async ({ page }) => {
    await openLog(page);
    await page.getByLabel('Search commit messages').fill('bugfix');
    await expect
      .poll(async () =>
        (await posted(page)).some(
          (m) =>
            m.method === 'log/setFilter' &&
            (m.params as { filter?: { text?: { q: string } } }).filter?.text?.q === 'bugfix',
        ),
      )
      .toBe(true);

    await page.getByLabel('Sort').selectOption('intelli');
    await expect
      .poll(async () =>
        (await posted(page)).some(
          (m) =>
            m.method === 'log/setFilter' &&
            (m.params as { filter?: { sort?: string } }).filter?.sort === 'intelli',
        ),
      )
      .toBe(true);
  });

  test('chip pickers delegate to the host', async ({ page }) => {
    await openLog(page);
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    await page.getByRole('button', { name: 'User', exact: true }).click();
    const msgs = await posted(page);
    expect(msgs.some((m) => m.method === 'log/pickBranches')).toBe(true);
    expect(msgs.some((m) => m.method === 'log/pickAuthors')).toBe(true);
  });

  test('keyboard: arrows navigate, ctrl+c copies the sha', async ({ page }) => {
    await openLog(page);
    await page.locator('[data-gt-row="0"]').click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+c');
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'log/copy'))
      .toBe(true);
  });

  test('P10-T2: focusFilter event moves focus into the search box', async ({ page }) => {
    await openLog(page);
    await page.evaluate(() => {
      window.postMessage({ v: 1, id: 'evtff', kind: 'evt', method: 'log/focusFilter', params: {} }, '*');
    });
    await expect(page.getByLabel('Search commit messages')).toBeFocused();
  });

  test('P10-T2: aria-live region announces loaded commits', async ({ page }) => {
    await openLog(page);
    const status = page.getByTestId('log-status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText('2000 commits loaded');
  });

  test('P10-T2: rows carry IntelliJ-style screen-reader labels', async ({ page }) => {
    await openLog(page);
    const label = await page.locator('[data-gt-row="0"]').getAttribute('aria-label');
    expect(label).toContain('commit commit 0 by Alice');
    expect(label).toContain('branch main');
    const plain = await page.locator('[data-gt-row="1"]').getAttribute('aria-label');
    expect(plain).toContain('commit commit 1 by Bob');
    expect(plain).not.toContain('branch');
  });

  test('P12-T1: four named panes render inside the Log tab', async ({ page }) => {
    await openLog(page);
    await expect(page.getByRole('tab', { name: 'Log' })).toBeVisible();
    for (const id of ['branches', 'commits', 'files', 'details']) {
      await expect(page.getByTestId(`pane-${id}`)).toBeVisible();
    }
    // Screen readers hear the pane names from the headers.
    await expect(page.locator('[data-pane-header="branches"]')).toHaveAttribute(
      'aria-label',
      'Branches pane',
    );
    // The centre pane never collapses; the side panes carry the chevron.
    await expect(
      page.getByTestId('pane-commits').getByRole('button', { name: /Collapse/ }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('pane-branches').getByRole('button', { name: 'Collapse Branches' }),
    ).toHaveCount(1);
  });

  test('P12-T1: Tab cycles the pane headers with a visible focus model', async ({ page }) => {
    await openLog(page);
    await page.locator('[data-pane-header="branches"]').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-pane-header="commits"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-pane-header="files"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-pane-header="details"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-pane-header="branches"]')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-pane-header="details"]')).toBeFocused();
  });

  test('P12-T1: collapsing a pane folds it to a bar and keeps its state', async ({ page }) => {
    await openLog(page);
    // Select a commit so the panes hold state worth keeping.
    await page.locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('changed-files')).toContainText('src/app.ts');

    await page
      .getByTestId('pane-details')
      .getByRole('button', { name: 'Collapse Commit Details' })
      .click();
    await expect(page.getByTestId('pane-details')).toHaveCount(0);
    await expect(page.getByTestId('pane-details-collapsed')).toBeVisible();
    // The sibling keeps working while its neighbour is folded.
    await expect(page.getByTestId('changed-files')).toContainText('src/app.ts');

    await page.getByRole('button', { name: 'Expand Commit Details' }).click();
    await expect(page.getByTestId('details-panel')).toContainText('Alice');
  });

  test('P12-T1: layout ratios and collapse flags survive a reload', async ({ page }) => {
    await openLog(page);
    await page
      .getByTestId('pane-branches')
      .getByRole('button', { name: 'Collapse Branches' })
      .click();
    await expect(page.getByTestId('pane-branches-collapsed')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('log-row-0')).toBeVisible();
    // The collapse came back from persisted state, not from defaults.
    await expect(page.getByTestId('pane-branches-collapsed')).toBeVisible();
    await page.getByRole('button', { name: 'Expand Branches' }).click();
    await expect(page.getByTestId('pane-branches')).toBeVisible();
  });

  test('P12-T1: the selection is mirrored to the host as one model', async ({ page }) => {
    await openLog(page);
    await page.locator('[data-gt-row="2"]').click();
    await page.locator('[data-gt-row="4"]').click({ modifiers: ['Control'] });
    await expect
      .poll(async () => {
        const selects = (await posted(page)).filter((m) => m.method === 'log/select');
        const last = selects.at(-1)?.params as { shas?: string[] } | undefined;
        return last?.shas?.length;
      })
      .toBe(2);
  });

  test('P10-T2: colorBlind palette drives ref-chip and graph colors', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockGraphPalette?: string }).__mockGraphPalette = 'colorBlind';
    });
    await openLog(page);
    // Okabe–Ito lane 0: #0072b2 light / #56b4e9 dark — either proves the
    // palette reached the renderer (theme depends on the harness page).
    const border = await page
      .locator('.gt-ref-chip')
      .first()
      .evaluate((el) => getComputedStyle(el).borderColor);
    expect(['rgb(0, 114, 178)', 'rgb(86, 180, 233)']).toContain(border);
  });
});
