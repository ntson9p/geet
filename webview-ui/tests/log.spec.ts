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

/** P12-T2 added a second virtual tree (Branches); scope row hits to Commits. */
function commitRow(page: Page) {
  return page.getByTestId('log-rows');
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
    await commitRow(page).locator('[data-gt-row="2"]').click();
    const ctxSingle = await commitRow(page).locator('[data-gt-row="2"]').getAttribute('data-vscode-context');
    const parsedSingle = JSON.parse(ctxSingle ?? '{}') as { sha: string; shas: string[]; webviewSection: string };
    expect(parsedSingle.webviewSection).toBe('commit');
    expect(parsedSingle.shas).toHaveLength(1);

    await commitRow(page).locator('[data-gt-row="4"]').click({ modifiers: ['Control'] });
    const ctxMulti = await commitRow(page).locator('[data-gt-row="4"]').getAttribute('data-vscode-context');
    const parsedMulti = JSON.parse(ctxMulti ?? '{}') as { shas: string[] };
    expect(parsedMulti.shas.length).toBe(2);
  });

  test('selection fills Commit Details and Changed Files; activate posts openFileDiff', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    // P12-T1: the right column is two panes — meta in Details, files in
    // Changed Files — both fed by the same selection.
    const details = page.getByTestId('details-panel');
    await expect(details).toContainText('Alice');
    const files = page.getByTestId('changed-files');
    await expect(files).toContainText('app.ts');
    await expect(files).toContainText('src/old.ts'); // rename pair visible

    await files.getByRole('treeitem', { name: /app\.ts/ }).dblclick();
    const msgs = await posted(page);
    expect(msgs.some((m) => m.method === 'log/openFileDiff')).toBe(true);
  });

  test('P12-T3: the tree carries the repo row, folder counts and status colors', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    const files = page.getByTestId('changed-files');
    // The §2A repo row: name, count, dim repo path.
    await expect(files.getByRole('treeitem', { name: /repo, 2 files · \/repo/ })).toBeVisible();
    await expect(files.getByRole('treeitem', { name: /^src, 2 files$/ })).toBeVisible();
    // Status colors ride the P11-T8 palette (theme variables by default).
    const style = await files
      .getByRole('treeitem', { name: /app\.ts/ })
      .locator('.gt-tree-name')
      .getAttribute('style');
    expect(style).toContain('gitDecoration-modifiedResourceForeground');

    // Flat mode lists full paths under the repo row.
    await page.getByRole('button', { name: 'Flat file list' }).click();
    await expect(files.getByRole('treeitem', { name: /^src\/app\.ts$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Group by folder' }).click();
  });

  test('P12-T3: a multi-selection shows the aggregate and range-scoped diffs', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="2"]').click();
    await commitRow(page).locator('[data-gt-row="4"]').click({ modifiers: ['Control'] });
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const p = m.params as { shas?: string[] } | undefined;
          return m.method === 'log/changedFiles' && p?.shas?.length === 2;
        }),
      )
      .toBe(true);
    const files = page.getByTestId('changed-files');
    await expect(files).toContainText('agg-added.ts');

    // The multi-diff button has one-commit semantics and disables on a range.
    await expect(page.getByRole('button', { name: 'Show all files in multi-diff' })).toBeDisabled();

    await files.getByRole('treeitem', { name: /agg-added\.ts/ }).dblclick();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const p = m.params as { base?: string } | undefined;
          return m.method === 'log/openFileDiff' && p?.base === 'basebasebase';
        }),
      )
      .toBe(true);
  });

  test('P12-T3: preview-on-click and Show History for Revision', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    const files = page.getByTestId('changed-files');

    // History needs a selected file row.
    const history = page.getByRole('button', { name: 'Show History for Revision' });
    await expect(history).toBeDisabled();
    await files.getByRole('treeitem', { name: /app\.ts/ }).click();
    await expect(history).toBeEnabled();
    await history.click();
    await expect
      .poll(async () =>
        (await posted(page)).some(
          (m) =>
            m.method === 'log/showFileHistory' &&
            (m.params as { path?: string } | undefined)?.path === 'src/app.ts',
        ),
      )
      .toBe(true);

    // Preview mode: a single click opens the diff.
    const before = (await posted(page)).filter((m) => m.method === 'log/openFileDiff').length;
    await page.getByRole('button', { name: 'Preview diff on click' }).click();
    await files.getByRole('treeitem', { name: /new\.ts/ }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'log/openFileDiff').length)
      .toBeGreaterThan(before);
  });

  test('P12-T4: details carry subject, meta, committer, signature and ref chips', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="0"]').click();
    const details = page.getByTestId('details-panel');
    await expect(page.getByTestId('details-subject')).toContainText('subject of');
    await expect(details).toContainText('a@x.dev on');
    // Committer differs → the line renders; signature G → Good signature.
    await expect(page.getByTestId('details-committer')).toContainText('committed by Carol');
    await expect(page.getByTestId('details-signature')).toContainText('Good signature');
    await expect(details.locator('.gt-ref-tag')).toContainText('tag: v1.0');

    // The unsigned commit shows no signature row at all.
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('details-signature')).toHaveCount(0);
  });

  test('P12-T4: Copy Subject copies the subject, not the sha', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await page.getByRole('button', { name: 'Copy Subject' }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const p = m.params as { text?: string } | undefined;
          return m.method === 'log/copy' && p?.text?.startsWith('subject of') === true;
        }),
      )
      .toBe(true);
  });

  test('P12-T4: a parent link asks the host and the reveal moves the selection', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="0"]').click();
    // Parents in the mock are rows 2 and 3 — click the first.
    await page.getByTestId('details-parent-0000000').first().click();
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'log/goTo'))
      .toBe(true);
    // The host's reveal event selects the parent row.
    await expect(commitRow(page).locator('[data-gt-row="2"] .gt-log-row')).toHaveClass(
      /gt-selected/,
    );
  });

  test('P12-T4: Contained-in-branches is lazy — nothing runs until the click', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('details-contained-link')).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __containsCalls?: number }).__containsCalls ?? 0),
    ).toBe(0);

    await page.getByTestId('details-contained-link').click();
    await expect(page.getByTestId('details-contained')).toContainText('release');
    expect(
      await page.evaluate(() => (window as unknown as { __containsCalls?: number }).__containsCalls ?? 0),
    ).toBe(1);
  });

  test('P12-T4: the body linkifies URLs and configured issue keys', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    const body = page.getByTestId('details-body');
    await expect(body.locator('a[href="https://example.com/doc"]')).toHaveText(
      'https://example.com/doc',
    );
    await expect(body.locator('a[href="https://tracker.example/browse/GT-123"]')).toHaveText(
      'GT-123',
    );
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

  test('P12-T5: Branch ▾ is a real multi-select with search, favorites first', async ({ page }) => {
    await openLog(page);
    await page.getByTestId('filter-branch').click();
    const panel = page.getByTestId('filter-branch-panel');
    await expect(panel).toBeVisible();
    // Favorites first: release (★) lists before main inside the locals block.
    const labels = await panel.locator('.gt-filter-checkrow-label').allTextContents();
    expect(labels.indexOf('release')).toBeLessThan(labels.indexOf('main'));
    await expect(panel.locator('.gt-filter-star')).toHaveCount(1);

    await panel.getByLabel('Search refs').fill('f1');
    await panel.getByRole('checkbox').nth(1).click(); // first match under All-branches
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && JSON.stringify(f?.refs) === '["feature/f1"]';
        }),
      )
      .toBe(true);
  });

  test('P12-T5: User ▾ offers Me and searchable authors', async ({ page }) => {
    await openLog(page);
    await page.getByTestId('filter-user').click();
    const panel = page.getByTestId('filter-user-panel');
    await expect(panel).toContainText('Me (a@x.dev)');
    await expect(panel).toContainText('Carol <c@x.dev>');
    await panel.getByRole('checkbox').first().click(); // Me
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { authors?: string[] } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.authors?.[0] === 'a@x.dev';
        }),
      )
      .toBe(true);
  });

  test('P12-T5: Date ▾ presets and Paths ▾ multi-entry compose the filter', async ({ page }) => {
    await openLog(page);
    await page.getByTestId('filter-date').click();
    await page.getByTestId('filter-date-panel').getByRole('button', { name: 'Today' }).click();
    const today = new Date().toISOString().slice(0, 10);
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { dateRange?: { from?: string } } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.dateRange?.from === today;
        }),
      )
      .toBe(true);

    await page.getByTestId('filter-paths').click();
    const paths = page.getByTestId('filter-paths-panel');
    await paths.getByLabel('Add path').fill('src/a.ts');
    await paths.getByLabel('Add path').press('Enter');
    await paths.getByLabel('Add path').fill('docs/b.md');
    await paths.getByLabel('Add path').press('Enter');
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { paths?: string[] } } | undefined)?.filter;
          return m.method === 'log/setFilter' && JSON.stringify(f?.paths) === '["src/a.ts","docs/b.md"]';
        }),
      )
      .toBe(true);
    // Browse… still delegates to the host picker.
    await paths.getByRole('button', { name: 'Browse…' }).click();
    expect((await posted(page)).some((m) => m.method === 'log/pickPaths')).toBe(true);
  });

  test('P12-T5: a hash in the text field navigates; the toolbar goes to refs', async ({ page }) => {
    await openLog(page);
    const search = page.getByLabel('Search commit messages');
    await search.fill('00000005'.repeat(5));
    await search.press('Enter');
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'log/goToRef'))
      .toBe(true);
    await page.getByRole('button', { name: 'Go to Hash/Branch/Tag' }).click();
    expect(
      (await posted(page)).filter((m) => m.method === 'log/goToRef').length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('P12-T5: saved filters apply and save; Show Details folds the right column', async ({ page }) => {
    await openLog(page);
    await page.getByRole('button', { name: 'Saved filters' }).click();
    await page.getByRole('menuitem', { name: 'mine only' }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { authors?: string[] } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.authors?.[0] === 'a@x.dev';
        }),
      )
      .toBe(true);

    await page.getByRole('button', { name: 'Saved filters' }).click();
    await page.getByRole('menuitem', { name: 'Save current filter…' }).click();
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'log/savePreset'))
      .toBe(true);

    await page.getByRole('button', { name: 'Show Details' }).click();
    await expect(page.getByTestId('pane-files-collapsed')).toBeVisible();
    await expect(page.getByTestId('pane-details-collapsed')).toBeVisible();
    await page.getByRole('button', { name: 'Show Details' }).click();
    await expect(page.getByTestId('pane-details')).toBeVisible();
  });

  test('P12-T5: Highlight my commits marks my rows only', async ({ page }) => {
    await openLog(page);
    await page.getByRole('button', { name: 'Highlight my commits' }).click();
    // Alice authors rows where i % 3 === 0; Bob the rest.
    await expect(commitRow(page).locator('[data-gt-row="0"] .gt-log-row')).toHaveClass(/gt-mine/);
    await expect(commitRow(page).locator('[data-gt-row="1"] .gt-log-row')).not.toHaveClass(/gt-mine/);
  });

  test('keyboard: arrows navigate, ctrl+c copies the sha', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="0"]').click();
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
    const label = await commitRow(page).locator('[data-gt-row="0"]').getAttribute('aria-label');
    expect(label).toContain('commit commit 0 by Alice');
    expect(label).toContain('branch main');
    const plain = await commitRow(page).locator('[data-gt-row="1"]').getAttribute('aria-label');
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
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('changed-files')).toContainText('app.ts');

    await page
      .getByTestId('pane-details')
      .getByRole('button', { name: 'Collapse Commit Details' })
      .click();
    await expect(page.getByTestId('pane-details')).toHaveCount(0);
    await expect(page.getByTestId('pane-details-collapsed')).toBeVisible();
    // The sibling keeps working while its neighbour is folded.
    await expect(page.getByTestId('changed-files')).toContainText('app.ts');

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
    await commitRow(page).locator('[data-gt-row="2"]').click();
    await commitRow(page).locator('[data-gt-row="4"]').click({ modifiers: ['Control'] });
    await expect
      .poll(async () => {
        const selects = (await posted(page)).filter((m) => m.method === 'log/select');
        const last = selects.at(-1)?.params as { shas?: string[] } | undefined;
        return last?.shas?.length;
      })
      .toBe(2);
  });

  test('P12-T2: sections render with folder nodes and favorites starred first', async ({ page }) => {
    await openLog(page);
    const pane = page.getByTestId('branches-pane');
    await expect(pane.getByRole('treeitem', { name: /HEAD \(Current\)/ })).toBeVisible();
    // Folder node: feature/f1, f1-1, f2 collapse under one `feature` row.
    const featureDir = pane.getByRole('treeitem', { name: /^feature, 3$/ });
    await expect(featureDir).toBeVisible();
    await expect(pane.getByRole('treeitem', { name: /f1-1/ })).toHaveCount(0);
    await featureDir.locator('.gt-twistie').click();
    await expect(pane.getByRole('treeitem', { name: /f1-1/ })).toBeVisible();

    // The favorite sorts first inside Local and wears the star.
    const labels = await pane
      .getByRole('treeitem')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const releaseIdx = labels.indexOf('release');
    const mainIdx = labels.indexOf('main, current');
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeLessThan(mainIdx);
    await expect(
      pane.getByRole('treeitem', { name: /release/ }).locator('.codicon-star-full'),
    ).toHaveCount(1);

    // Remote per remote, tags at the end.
    await expect(pane.getByRole('treeitem', { name: /^origin, 2$/ })).toBeVisible();
    await expect(pane.getByRole('treeitem', { name: /^Tags, 1$/ })).toBeVisible();
  });

  test('P12-T2: selecting a ref filters the commits; HEAD restores; Ctrl adds', async ({ page }) => {
    await openLog(page);
    const pane = page.getByTestId('branches-pane');
    await pane.getByRole('treeitem', { name: /^feature, 3$/ }).locator('.gt-twistie').click();
    await pane.getByRole('treeitem', { name: 'f1', exact: true }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && JSON.stringify(f?.refs) === '["feature/f1"]';
        }),
      )
      .toBe(true);

    // Ctrl adds the second ref to the same filter.
    await pane.getByRole('treeitem', { name: 'f2', exact: true }).click({ modifiers: ['Control'] });
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return (
            m.method === 'log/setFilter' &&
            JSON.stringify(f?.refs) === '["feature/f1","feature/f2"]'
          );
        }),
      )
      .toBe(true);

    // HEAD (Current) restores the default.
    await pane.getByRole('treeitem', { name: /HEAD \(Current\)/ }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.refs === 'HEAD';
        }),
      )
      .toBe(true);
  });

  test('P12-T2: every rail button carries an accessible name', async ({ page }) => {
    await openLog(page);
    const rail = page.getByRole('toolbar', { name: 'Branch actions' });
    for (const name of [
      'New Branch',
      'Delete Branch',
      'Compare with Current',
      'Filter branches',
      'Favorites only',
      'Show my commits',
      'Collapse pane',
    ]) {
      await expect(rail.getByRole('button', { name })).toBeVisible();
    }
    // The rail acts through the shared registry: + posts the new action.
    await rail.getByRole('button', { name: 'New Branch' }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some(
          (m) =>
            m.method === 'log/branchAction' &&
            (m.params as { action?: string } | undefined)?.action === 'new',
        ),
      )
      .toBe(true);
  });

  test('P12-T2: branch rows carry the native-menu identity; rail toggles filter locally', async ({ page }) => {
    await openLog(page);
    const pane = page.getByTestId('branches-pane');
    const release = pane.getByRole('treeitem', { name: /release/ });
    const ctx = JSON.parse((await release.getAttribute('data-vscode-context')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(ctx['webviewSection']).toBe('logBranch');
    expect(ctx['refName']).toBe('release');
    expect(ctx['refType']).toBe('local');

    // Favorites-only narrows Local to the starred branch.
    await page.getByRole('button', { name: 'Favorites only' }).click();
    await expect(pane.getByRole('treeitem', { name: /^feature, 3$/ })).toHaveCount(0);
    await expect(release).toBeVisible();

    // Show my commits round-trips through the author filter.
    await page.getByRole('button', { name: 'Favorites only' }).click();
    await page.getByRole('button', { name: 'Show my commits' }).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { authors?: string[] } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.authors?.[0] === 'a@x.dev';
        }),
      )
      .toBe(true);
  });

  test('P12-T8: Console tab lists runs; failures pre-expanded with exit code', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Console' }).click();
    const pane = page.getByTestId('console-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('console-count')).toHaveText('3');

    // The failing fetch (exit 128): coloured row, output visible unprompted,
    // and the argv shows the HOST-redacted URL — no token ever reaches the DOM.
    const failed = page.getByTestId('console-entry-2');
    await expect(failed).toHaveClass(/gt-console-failed/);
    await expect(failed.locator('.gt-console-cmd')).toHaveText(
      'git fetch https://***@example.com/r.git',
    );
    await expect(failed.locator('.gt-console-exit')).toHaveText('→ 128');
    await expect(failed.locator('.gt-console-exit')).toHaveClass(/gt-console-exit-bad/);
    await expect(failed.locator('.gt-console-output')).toContainText(
      'fatal: could not read from remote',
    );

    // Success rows start collapsed.
    const ok = page.getByTestId('console-entry-3');
    await expect(ok.locator('.gt-console-output')).toHaveCount(0);
  });

  test('P12-T8: chevrons expand successes and collapse failures', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Console' }).click();
    const failed = page.getByTestId('console-entry-2');
    const ok = page.getByTestId('console-entry-3');

    await ok.getByRole('button', { name: 'Toggle output of git log' }).click();
    await expect(ok.locator('.gt-console-output')).toHaveText('abc123');

    // Failures default open but stay collapsible (toggle is XOR, not OR).
    await failed.getByRole('button', { name: 'Toggle output of git fetch' }).click();
    await expect(failed.locator('.gt-console-output')).toHaveCount(0);
    await failed.getByRole('button', { name: 'Toggle output of git fetch' }).click();
    await expect(failed.locator('.gt-console-output')).toBeVisible();
  });

  test('P12-T8: filter narrows entries; Copy command posts the redacted argv', async ({
    page,
  }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Console' }).click();
    await page.getByRole('textbox', { name: 'Filter commands' }).fill('fetch');
    await expect(page.getByTestId('console-entry-2')).toBeVisible();
    await expect(page.getByTestId('console-entry-1')).toHaveCount(0);
    await expect(page.getByTestId('console-entry-3')).toHaveCount(0);

    await page
      .getByTestId('console-entry-2')
      .getByRole('button', { name: 'Copy command' })
      .click();
    const msgs = await posted(page);
    const copy = msgs.find((m) => m.method === 'log/copy');
    expect((copy?.params as { text?: string } | undefined)?.text).toBe(
      'git fetch https://***@example.com/r.git',
    );
  });

  test('P12-T8: Clear posts consoleClear and empties the pane', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Console' }).click();
    await page.getByRole('button', { name: 'Clear console' }).click();
    await expect(page.getByTestId('console-pane')).toContainText('No git commands yet.');
    await expect(page.getByTestId('console-count')).toHaveText('0');
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'log/consoleClear'))
      .toBe(true);
  });

  test('P12-T8: the active tab survives a reload', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Console' }).click();
    await expect(page.getByTestId('console-pane')).toBeVisible();
    await page.reload();
    // Boots straight into Console — no click — from persisted webview state.
    await expect(page.getByTestId('console-pane')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Console' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // And back: the Log tab remounts its rows intact.
    await page.getByRole('tab', { name: 'Log' }).click();
    await expect(page.getByTestId('log-row-0')).toBeVisible();
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
