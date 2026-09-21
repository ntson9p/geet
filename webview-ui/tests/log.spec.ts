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

/** Drives a host-raised `log/reset` — the P4 auto-refresh path. */
async function postReset(page: Page, extra: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    (params) => window.postMessage({ v: 1, id: 'evtreset', kind: 'evt', method: 'log/reset', params }, '*'),
    {
      repoRoot: '/repo',
      repoLabel: 'repo',
      filter: { sort: 'topo', refs: 'HEAD' },
      laneWidth: 12,
      ...extra,
    },
  );
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

  test('POST-P14x: hovering a commit shows its whole message, fetched once', async ({ page }) => {
    await openLog(page);
    const calls = async (): Promise<number> =>
      page.evaluate(() => (window as unknown as { __messageCalls?: number }).__messageCalls ?? 0);
    const tooltip = page.getByTestId('commit-tooltip');
    const rowAt = (i: number) => commitRow(page).locator(`[data-gt-row="${i}"]`);

    // Nothing on arrival: the card is a dwell, not a mousemove artefact.
    await expect(tooltip).toHaveCount(0);

    await rowAt(3).hover();
    await expect(tooltip).toBeVisible();
    // The row shows only the subject; the body is the reason to hover at all.
    await expect(tooltip).toContainText('Body line one.');
    await expect(tooltip).toContainText('Body line two.');

    await rowAt(5).hover();
    await expect.poll(calls).toBe(2);
    await expect(tooltip).toHaveCount(1);

    // Back to a row already read: cached, so git is not asked again.
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCount(0);
    await rowAt(3).hover();
    await expect(tooltip).toBeVisible();
    expect(await calls()).toBe(2);

    // Clicking is a selection gesture; the card must not survive it and sit
    // over the rows the user just aimed at.
    await rowAt(3).click();
    await expect(tooltip).toHaveCount(0);
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
    expect(style).toContain('gittree-color-modified');

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
    await panel.getByRole('checkbox').nth(2).click(); // first match under the two presets
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && JSON.stringify(f?.refs) === '["feature/f1"]';
        }),
      )
      .toBe(true);
  });

  test('Branch ▾ names HEAD as a preset, checked by default', async ({ page }) => {
    await openLog(page);
    await page.getByTestId('filter-branch').click();
    const panel = page.getByTestId('filter-branch-panel');
    const head = panel.getByRole('checkbox').nth(0);
    const all = panel.getByRole('checkbox').nth(1);

    // The default filter is HEAD (`DEFAULT_FILTER`), and the dropdown says so
    // instead of leaving it as the unnamed absence of a branch filter.
    await expect(panel.locator('.gt-filter-checkrow-label').first()).toHaveText('HEAD (Current)');
    await expect(head).toBeChecked();
    await expect(all).not.toBeChecked();

    await all.click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.refs === 'ALL';
        }),
      )
      .toBe(true);
    await expect(head).not.toBeChecked();

    // The presets are mutually exclusive both ways round.
    await head.click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown } } | undefined)?.filter;
          return m.method === 'log/setFilter' && f?.refs === 'HEAD';
        }),
      )
      .toBe(true);
    await expect(head).toBeChecked();
    await expect(all).not.toBeChecked();
  });

  test('Branch ▾ presets clear a range, and neither reads as active under one', async ({ page }) => {
    await openLog(page);
    // What `Compare with current` / `Show in log` after an update produce: a
    // range and no refs. The range outranks refs in the argv build, so a preset
    // must not claim to be on — and picking one must drop the range.
    await page.evaluate(() => {
      window.postMessage(
        {
          v: 1,
          id: 'evtreset-range',
          kind: 'evt',
          method: 'log/reset',
          params: {
            repoRoot: '/repo',
            repoLabel: 'repo',
            filter: { sort: 'topo', refs: 'ALL', range: { a: 'feature/f1', b: 'main' } },
            laneWidth: 12,
          },
        },
        '*',
      );
    });
    await expect(page.getByTestId('filter-branch')).toContainText('feature/f1...main');

    await page.getByTestId('filter-branch').click();
    const panel = page.getByTestId('filter-branch-panel');
    await expect(panel.getByRole('checkbox').nth(0)).not.toBeChecked(); // HEAD
    await expect(panel.getByRole('checkbox').nth(1)).not.toBeChecked(); // All branches

    await panel.getByRole('checkbox').nth(1).click();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const f = (m.params as { filter?: { refs?: unknown; range?: unknown } } | undefined)
            ?.filter;
          return m.method === 'log/setFilter' && f?.refs === 'ALL' && f?.range === undefined;
        }),
      )
      .toBe(true);
  });

  test('P4 auto-refresh: a preserved reset keeps the focused commit', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="4"]').click();
    await expect(commitRow(page).locator('[data-gt-row="4"] .gt-log-row')).toHaveClass(
      /gt-selected/,
    );

    // What the host sends when history moved under the user (a commit, a
    // pull, a rebase) rather than because they asked for a new view.
    await postReset(page, { preserve: true });

    // The rows are rebuilt, but the commit they were reading comes back.
    await expect(commitRow(page).locator('[data-gt-row="4"] .gt-log-row')).toHaveClass(
      /gt-selected/,
    );
    await expect(page.getByTestId('details-body')).toBeVisible();
  });

  test('P4 auto-refresh: a user-asked reset still clears the selection', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="4"]').click();
    await expect(commitRow(page).locator('[data-gt-row="4"] .gt-log-row')).toHaveClass(
      /gt-selected/,
    );

    // No `preserve`: a filter change, a root switch or the Refresh button.
    await postReset(page, {});

    await expect(page.getByTestId('log-row-0')).toBeVisible();
    await expect(commitRow(page).locator('[data-gt-row="4"] .gt-log-row')).not.toHaveClass(
      /gt-selected/,
    );
  });

  test('P4 auto-refresh: with nothing selected the scroll position survives', async ({ page }) => {
    await openLog(page);
    const list = page.getByRole('listbox', { name: 'Commits' });
    await list.evaluate((el) => {
      el.scrollTop = 600 * 24;
    });
    await expect(page.getByTestId('log-row-600')).toBeVisible();

    await postReset(page, { preserve: true });

    // Anchored on the row that was at the top — not thrown back to the newest
    // commit, and without inventing a selection the user never made.
    await expect(page.getByTestId('log-row-600')).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(500 * 24);
    expect(await commitRow(page).locator('.gt-log-row.gt-selected').count()).toBe(0);
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
    // Both choosers delegate to the host, which owns the file dialogs.
    await paths.getByRole('button', { name: 'Select…', exact: true }).click();
    expect((await posted(page)).some((m) => m.method === 'log/pickPaths')).toBe(true);
    await page.getByTestId('filter-paths').click();
    await page.getByTestId('filter-paths-panel').getByRole('button', { name: 'Select in Tree…' }).click();
    expect((await posted(page)).some((m) => m.method === 'log/pickPathsInTree')).toBe(true);
  });

  test('Paths ▾ lists the workspace roots and switching one moves the log', async ({ page }) => {
    await openLog(page);
    // With more than one repository the chip names the one on show — nothing
    // else on the bar does — but there is nothing to clear until a path is set.
    const chip = page.getByTestId('filter-paths');
    await expect(chip).toHaveText(/repo/);
    await expect(page.getByRole('button', { name: 'Clear Paths' })).toHaveCount(0);

    await chip.click();
    const paths = page.getByTestId('filter-paths-panel');

    // Every root the workspace has, with the one on show already marked.
    await expect(paths.getByText('Roots')).toBeVisible();
    await expect(paths.getByTestId('filter-root-repo')).toBeChecked();
    await expect(paths.getByTestId('filter-root-other')).not.toBeChecked();

    // Re-picking the root already on show must not restart the session — the
    // host re-runs the whole log on `setRoot`, and rows/selection go with it.
    await paths.getByTestId('filter-root-repo').click();
    expect((await posted(page)).some((m) => m.method === 'log/setRoot')).toBe(false);

    await paths.getByTestId('filter-root-other').click();
    await expect
      .poll(async () =>
        (await posted(page)).some(
          (m) =>
            m.method === 'log/setRoot' && (m.params as { root?: string } | undefined)?.root === '/other',
        ),
      )
      .toBe(true);
    // Picking a root closes the panel, like every other one-shot filter row.
    await expect(paths).toBeHidden();
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

  test('POST-P14z: the row dates the commit exactly, and says so to a reader', async ({ page }) => {
    await openLog(page);
    const row = commitRow(page).locator('[data-gt-row="0"]');
    // Locale-tolerant on purpose — the separator and the field order are the
    // host's business. What must be there is a calendar date AND a clock time,
    // which is exactly what an age (`10d`, `3mo`) cannot give.
    const dateAndTime = /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\s+\d{1,2}:\d{2}/u;
    await expect(row).toHaveText(dateAndTime);
    expect(await row.getAttribute('aria-label')).toMatch(dateAndTime);
    // The shapes this replaced. A reader had no way to tell two `2mo` rows
    // six weeks apart from each other.
    await expect(row).not.toHaveText(/\b\d+(?:m|h|d)\s+·/u);
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

  /**
   * Only a drag moves a separator. A pane whose flex base size comes from its
   * own content makes flexbox re-proportion its siblings, so selecting a commit
   * with a long message line or a deep path used to squeeze Branches and
   * Commits sideways and Changed Files vertically — a layout that changed under
   * the user for merely looking at a commit.
   */
  test('P12-T1: selecting a wide commit does not move the pane separators', async ({ page }) => {
    await openLog(page);
    const geometry = async () => {
      const of = async (id: string) => {
        const b = await page.getByTestId(`pane-${id}`).boundingBox();
        expect(b, `pane-${id} has no box`).not.toBeNull();
        return b!;
      };
      return {
        branches: (await of('branches')).width,
        commits: (await of('commits')).width,
        files: (await of('files')).height,
      };
    };

    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('changed-files')).toContainText('app.ts');
    const before = await geometry();

    await page.evaluate(() => {
      (window as unknown as { __mockWideDetails: boolean }).__mockWideDetails = true;
    });
    await commitRow(page).locator('[data-gt-row="2"]').click();
    await expect(page.getByTestId('details-body')).toContainText('change-resource-sheet2.csv');
    await expect(page.getByTestId('changed-files')).toContainText('UserLogicComponentFactory');
    const after = await geometry();

    expect(after.branches).toBeCloseTo(before.branches, 1);
    expect(after.commits).toBeCloseTo(before.commits, 1);
    expect(after.files).toBeCloseTo(before.files, 1);
  });

  /**
   * Nothing but the splitter decides how wide Commit Details is. The panel kept
   * P4's row-layout constraints (`min-width: 220px; max-width: 45%`) after P12
   * made it a pane in a column, where they land on the cross axis: the text
   * wrapped inside half the pane at wide sizes and spilled past it at narrow
   * ones, and dragging the separator returned only 45% of the room it gave.
   */
  test('P12-T4: Commit Details fills the width of its pane', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('details-panel')).toBeVisible();

    const geometry = () =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-pane-body="details"]') as HTMLElement;
        const panel = pane.querySelector('.gt-log-details') as HTMLElement;
        return {
          fill: panel.getBoundingClientRect().width / pane.clientWidth,
          overflow: Math.max(
            panel.scrollWidth - panel.clientWidth,
            pane.scrollWidth - pane.clientWidth,
          ),
        };
      });

    for (const width of [1024, 1920]) {
      await page.setViewportSize({ width, height: 768 });
      const g = await geometry();
      expect(g.fill, `fill at ${width}px`).toBeCloseTo(1, 2);
      expect(g.overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }

    // Squeezed against the splitter's floor it reflows rather than spilling —
    // the header row wraps instead of pushing the sha past the pane edge.
    await page.setViewportSize({ width: 1024, height: 768 });
    const sash = page.getByRole('separator', { name: 'Log panes' });
    await sash.focus();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    const narrow = await geometry();
    expect(narrow.fill, 'fill at the splitter floor').toBeCloseTo(1, 2);
    expect(narrow.overflow, 'horizontal overflow at the splitter floor').toBeLessThanOrEqual(1);
  });

  /**
   * A long message scrolls inside its own box rather than taking the pane with
   * it. The subject, hash and author are how you know *which* commit you are
   * reading; they must not scroll away in order to reach the end of the text.
   */
  test('P12-T4: a long message scrolls without taking the header with it', async ({ page }) => {
    await openLog(page);
    await page.evaluate(() => {
      (window as unknown as { __mockLongDetails: boolean }).__mockLongDetails = true;
    });
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('details-body')).toContainText('change-resource-sheet2.csv');

    const state = () =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-pane-body="details"]') as HTMLElement;
        const pre = pane.querySelector('.gt-details-body') as HTMLElement;
        const s = (pane.querySelector('.gt-details-subject') as HTMLElement).getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        return {
          messageScrolls: pre.scrollHeight - pre.clientHeight > 1,
          atEnd: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 1,
          subjectVisible: s.top >= p.top - 1 && s.bottom <= p.bottom + 1,
          // Panel padding (8) + the message's own bottom margin (4); anything
          // beyond that is pane the message was refused.
          blankBelowMessage: p.bottom - 8 - pre.getBoundingClientRect().bottom,
        };
      });

    const before = await state();
    // Guards the guard: a fixture that fits proves nothing about scrolling.
    expect(before.messageScrolls, 'the fixture must outgrow the pane').toBe(true);
    expect(before.subjectVisible, 'the subject starts on screen').toBe(true);
    // A message too long to fit gets every pixel that is left. `max-height: 30%`
    // used to cut it off with a third of the pane sitting empty underneath.
    expect(before.blankBelowMessage, 'empty pane below a clipped message').toBeLessThanOrEqual(12);

    await page.getByTestId('details-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const after = await state();
    expect(after.atEnd, 'the end of the message is reachable').toBe(true);
    expect(after.subjectVisible, 'the subject stayed on screen').toBe(true);
  });

  /**
   * Pinning the header must not clip what it pins. At the splitter's floor
   * there is less room than the metadata needs, so the panel itself takes over
   * the scrolling — without that fallback the ref chips, parent links and
   * `Contained in branches` would be cut off with no way to reach them.
   */
  test('P12-T4: a pane at its floor scrolls rather than clipping the metadata', async ({ page }) => {
    await openLog(page);
    await commitRow(page).locator('[data-gt-row="1"]').click();
    await expect(page.getByTestId('details-panel')).toBeVisible();

    const sash = page.getByRole('separator', { name: 'Changed files and commit details' });
    await sash.focus();
    await page.keyboard.press('End'); // Commit Details down to the splitter's minSecond

    const probe = await page.evaluate(() => {
      const pane = document.querySelector('[data-pane-body="details"]') as HTMLElement;
      const panel = pane.querySelector('.gt-log-details') as HTMLElement;
      const last = pane.querySelector('.gt-details-contained') as HTMLElement;
      const panelScrolls = panel.scrollHeight - panel.clientHeight > 1;
      // "Reachable" is exactly what scrollIntoView can do: it moves every
      // scrollable ancestor, and none at all if they are all `overflow: hidden`.
      last.scrollIntoView({ block: 'nearest' });
      const p = pane.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return { panelScrolls, lastRowVisible: l.bottom > p.top + 1 && l.top < p.bottom - 1 };
    });

    expect(probe.panelScrolls, 'the floor must be tighter than the metadata').toBe(true);
    expect(probe.lastRowVisible, 'the last metadata row can be scrolled into view').toBe(true);
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
// ---- POST-P14k: the Worktrees tab ----------------------------------------

  test('POST-P14k: Worktrees is the third tab and lists every worktree', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    const pane = page.getByTestId('worktrees-pane');
    await expect(pane).toBeVisible();
    const rows = page.getByRole('option');
    await expect(rows).toHaveCount(3);
    // Branch is the label, path sits beside it.
    await expect(rows.first().locator('.gt-worktree-branch')).toHaveText('main');
    await expect(rows.first().locator('.gt-worktree-path')).toHaveText('/repo');
    // A detached worktree has no branch to name, so it says where its HEAD is.
    await expect(rows.nth(2).locator('.gt-worktree-branch')).toHaveText('detached at ccccccc');
  });

  test('POST-P14k: Locked/Prunable labels appear only in those two states', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    const rows = page.getByRole('option');
    // JetBrains shows a status label only when a worktree is in one of them.
    await expect(rows.nth(0).locator('.gt-worktree-tag')).toHaveCount(0);
    await expect(rows.nth(1).locator('.gt-worktree-tag')).toHaveText('Locked');
    await expect(rows.nth(1).locator('.gt-worktree-tag')).toHaveAttribute(
      'title',
      'on a usb stick',
    );
    await expect(rows.nth(2).locator('.gt-worktree-tag')).toHaveText('Prunable');
  });

  test('POST-P14k: double-click opens; Remove and Lock are disabled on main', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    const rows = page.getByRole('option');

    // Nothing selected → the row actions are unavailable.
    await expect(page.getByRole('button', { name: 'Remove worktree' })).toBeDisabled();

    // The main worktree cannot be removed or locked, so selecting it changes
    // nothing about those two buttons.
    await rows.nth(0).click();
    await expect(page.getByRole('button', { name: 'Remove worktree' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Lock worktree' })).toBeDisabled();

    // A linked worktree enables them, and the locked one offers Unlock.
    await rows.nth(1).click();
    await expect(page.getByRole('button', { name: 'Remove worktree' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Unlock worktree' })).toBeEnabled();

    await rows.nth(1).dblclick();
    await expect
      .poll(async () =>
        (await page.evaluate(
          () => (window as unknown as { __worktreeActions?: unknown[] }).__worktreeActions ?? [],
        )) as Array<Record<string, unknown>>,
      )
      .toContainEqual({ action: 'open', repoRoot: '/repo', path: '/repo-topic' });
  });

  test('POST-P14k: New Worktree and Prune name a repository, never a row', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    await page.getByRole('button', { name: 'New Worktree…' }).click();
    await page.getByRole('button', { name: 'Prune stale worktrees' }).click();
    const acts = (await page.evaluate(
      () => (window as unknown as { __worktreeActions?: unknown[] }).__worktreeActions ?? [],
    )) as Array<Record<string, unknown>>;
    expect(acts).toEqual([
      { action: 'add', repoRoot: '/repo' },
      { action: 'prune', repoRoot: '/repo' },
    ]);
  });

  test('POST-P14k: a host worktrees event re-reads the list', async ({ page }) => {
    await openLog(page);
    await page.getByRole('tab', { name: 'Worktrees' }).click();
    await expect(page.getByRole('option')).toHaveCount(3);
    const before = (await posted(page)).filter((m) => m.method === 'log/worktrees').length;
    await page.evaluate(() =>
      window.postMessage(
        { v: 1, id: 'evtwt', kind: 'evt', method: 'log/worktreesChanged', params: {} },
        '*',
      ),
    );
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'log/worktrees').length)
      .toBeGreaterThan(before);
  });
});
