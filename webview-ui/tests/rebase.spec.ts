import { expect, test, type Page } from '@playwright/test';
import { mockRebaseHostScript } from './mockRebaseHost';

interface PostedMsg {
  kind: string;
  method?: string;
  params?: {
    entries?: Array<{ sha: string; action: string; message?: string }>;
    forceAcknowledged?: boolean;
  };
}

async function openRebase(page: Page, init?: Record<string, unknown>): Promise<void> {
  if (init) {
    await page.addInitScript(`window.__rebaseInit = ${JSON.stringify(init)};`);
  }
  await page.addInitScript(mockRebaseHostScript);
  await page.goto('/rebase.html');
  await expect(page.locator('[data-gt-rebase-row="0"]')).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

async function startedEntries(page: Page): Promise<Array<{ sha: string; action: string; message?: string }>> {
  const msgs = await posted(page);
  const start = msgs.filter((m) => m.method === 'rebase/start').pop();
  return start?.params?.entries ?? [];
}

const subjectOfRow = (page: Page, idx: number) =>
  page.locator(`[data-gt-rebase-row="${idx}"] .gt-rb-subject`);

test.describe('P5-T2 interactive rebase webview', () => {
  test('renders rows with action dropdowns, sha, author and summary footer', async ({ page }) => {
    await openRebase(page);
    await expect(page.getByRole('listbox', { name: 'Rebase plan' })).toBeVisible();
    await expect(page.locator('.gt-rb-row')).toHaveCount(5);
    await expect(subjectOfRow(page, 0)).toHaveText('commit 0');
    await expect(page.getByTestId('summary')).toHaveText(/5 picks · 0 rewords/);
    // Rows carry the native context-menu payload.
    const ctx = await page.locator('[data-gt-rebase-row="1"]').getAttribute('data-vscode-context');
    const parsed = JSON.parse(ctx ?? '{}') as { webviewSection: string; sha: string };
    expect(parsed.webviewSection).toBe('rebaseRow');
    expect(parsed.sha).toHaveLength(40);
  });

  test('pointer drag-and-drop reorders and the emitted plan matches', async ({ page }) => {
    await openRebase(page);
    const handle = page.getByTestId('drag-0');
    const target = page.locator('[data-gt-rebase-row="2"]');
    const hb = await handle.boundingBox();
    const tb = await target.boundingBox();
    expect(hb && tb).toBeTruthy();
    if (!hb || !tb) return;

    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    // aria-grabbed reflects the dragged row.
    await page.mouse.move(tb.x + 30, tb.y + tb.height * 0.8, { steps: 8 });
    await expect(page.locator('[data-gt-rebase-row="0"]')).toHaveAttribute('aria-grabbed', 'true');
    await page.mouse.up();

    // Row "commit 0" moved below "commit 2": order 1,2,0,3,4.
    await expect(subjectOfRow(page, 0)).toHaveText('commit 1');
    await expect(subjectOfRow(page, 1)).toHaveText('commit 2');
    await expect(subjectOfRow(page, 2)).toHaveText('commit 0');

    await page.getByTestId('start').click();
    await expect(page.getByTestId('rebase-progress')).toBeVisible();
    const entries = await startedEntries(page);
    expect(entries.map((e) => e.action)).toEqual(['pick', 'pick', 'pick', 'pick', 'pick']);
    expect(entries.map((e) => e.sha.slice(0, 2))).toEqual(['01', '02', '00', '03', '04']);
  });

  test('hotkeys set actions, alt+arrows reorder, first-row squash is blocked', async ({ page }) => {
    await openRebase(page);
    const row = (i: number) => page.locator(`[data-gt-rebase-row="${i}"]`);
    await row(1).click();
    await row(1).press('d');
    await expect(row(1)).toHaveClass(/gt-rb-row-drop/);
    await expect(page.getByTestId('summary')).toHaveText(/1 drop/);

    await row(1).press('f');
    await expect(row(1)).toHaveClass(/gt-rb-row-grouped/);

    // First row refuses squash/fixup with an inline error.
    await row(0).click();
    await row(0).press('s');
    await expect(page.getByTestId('validation')).toHaveText(/first commit/i);
    await expect(page.getByTestId('message-editor')).toHaveCount(0);

    // Alt+ArrowDown moves row 0 below row 1.
    await row(0).press('Alt+ArrowDown');
    await expect(subjectOfRow(page, 0)).toHaveText('commit 1');
    await expect(subjectOfRow(page, 1)).toHaveText('commit 0');
  });

  test('roving focus: rows are options, ArrowDown moves tabindex', async ({ page }) => {
    await openRebase(page);
    const row = (i: number) => page.locator(`[data-gt-rebase-row="${i}"]`);
    await row(0).click();
    await expect(row(0)).toHaveAttribute('tabindex', '0');
    await expect(row(1)).toHaveAttribute('tabindex', '-1');
    await row(0).press('ArrowDown');
    await expect(row(1)).toHaveAttribute('tabindex', '0');
    await expect(row(1)).toBeFocused();
    await expect(row(1)).toHaveRole('option');
  });

  test('reword opens a prefilled editor; the plan carries the new message', async ({ page }) => {
    await openRebase(page);
    const row1 = page.locator('[data-gt-rebase-row="1"]');
    await row1.click();
    await row1.press('r');
    const editor = page.getByTestId('message-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('commit 1\n\nbody 1');
    await editor.fill('reworded subject\n\nnew body');
    await page.getByTestId('message-ok').click();
    await expect(subjectOfRow(page, 1)).toHaveText('reworded subject');

    await page.getByTestId('start').click();
    const entries = await startedEntries(page);
    expect(entries[1]).toMatchObject({ action: 'reword', message: 'reworded subject\n\nnew body' });
  });

  test('squash prefills the concatenated group message and indents', async ({ page }) => {
    await openRebase(page);
    const row2 = page.locator('[data-gt-rebase-row="2"]');
    await row2.click();
    await row2.press('s');
    const editor = page.getByTestId('message-editor');
    await expect(editor).toBeVisible();
    // Group head (commit 1) + this commit's message, concatenated.
    await expect(editor).toHaveValue('commit 1\n\nbody 1\n\ncommit 2\n\nbody 2');
    await page.getByTestId('message-ok').click();
    await expect(row2).toHaveClass(/gt-rb-row-grouped/);
  });

  test('published range requires the force-acknowledge checkbox', async ({ page }) => {
    await openRebase(page, { published: true });
    await expect(page.getByTestId('start')).toBeDisabled();
    await page.getByTestId('force-ack').check();
    await expect(page.getByTestId('start')).toBeEnabled();
    await page.getByTestId('start').click();
    const msgs = await posted(page);
    const start = msgs.filter((m) => m.method === 'rebase/start').pop();
    expect(start?.params?.forceAcknowledged).toBe(true);
  });

  test('progress mode: paused state offers Continue/Skip/Abort; done closes', async ({ page }) => {
    await openRebase(page);
    await page.getByTestId('start').click();
    await expect(page.getByTestId('rebase-progress')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __pushRebaseState: (p: unknown) => void }).__pushRebaseState({
        phase: 'paused',
        conflicts: ['src/a.ts', 'src/b.ts'],
        progress: { step: 2, total: 5 },
        log: ['Rebasing…', 'Conflicts in: src/a.ts, src/b.ts'],
      });
    });
    await expect(page.getByTestId('rebase-paused')).toHaveText(/2 conflicted file/);
    await expect(page.getByTestId('rebase-step')).toHaveText('2/5');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByTestId('rebase-outcome')).toHaveText(/completed/i);
  });
});
