import { expect, test, type Page } from '@playwright/test';
import { mockShelveDialogHostScript } from './mockShelveDialogHost';

/**
 * P11-T7 Shelve Changes dialog. The mock host serves dialog/init and the lazy
 * per-file diffs; accept/cancel are events recorded like every other post, so
 * the specs assert the exact payload the real dialogHost would resolve with.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openShelve(page: Page): Promise<void> {
  await page.addInitScript(mockShelveDialogHostScript);
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: /Shelve Changes/ })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(msgs: PostedMsg[]): Record<string, unknown> | undefined {
  return msgs.find((m) => m.method === 'dialog/accept')?.params;
}

const DIFF_ROW = 'Strings.java, src/main/java/util · modified';

test.describe('P11-T7 shelve dialog layout', () => {
  test('renders the §2A shape: selector, tree, count, message, diff, actions', async ({ page }) => {
    await openShelve(page);
    await expect(page.getByTestId('shelve-list')).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /Strings\.java/ })).toBeVisible();
    await expect(page.getByTestId('shelve-count')).toHaveText('3 of 3 modified');
    // Prefill comes from the commit-window draft.
    await expect(page.getByTestId('shelve-message')).toHaveValue(
      'draft message from the commit window',
    );
    // The ∨ Diff section starts collapsed.
    await expect(page.getByTestId('shelve-diff-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('shelve-diff')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Shelve Changes' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByTestId('shelve-remove')).toBeChecked();
  });

  test('switching the changelist swaps the tree and resets ticks', async ({ page }) => {
    await openShelve(page);
    await page.getByTestId('shelve-list').selectOption('feature');
    await expect(page.getByRole('treeitem', { name: /feature\.ts/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /Strings\.java/ })).toHaveCount(0);
    await expect(page.getByTestId('shelve-count')).toHaveText('1 of 1 modified');

    // Unversioned files are shelvable too.
    await page.getByTestId('shelve-list').selectOption('__unversioned__');
    await expect(page.getByRole('treeitem', { name: /new-file\.txt/ })).toBeVisible();
  });

  test('cancel posts dialog/cancel and Escape does too', async ({ page }) => {
    await openShelve(page);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'dialog/cancel').length)
      .toBe(1);

    await page.reload();
    await expect(page.getByRole('dialog', { name: /Shelve Changes/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'dialog/cancel').length)
      .toBe(1);
  });
});

test.describe('P11-T7 shelve dialog result assembly', () => {
  test('whole-file accept carries paths, message and the remove flag', async ({ page }) => {
    await openShelve(page);
    // Untick one file and the remove option.
    await page.getByRole('treeitem', { name: /notes\.md/ }).locator('.gt-tree-check').click();
    await page.getByTestId('shelve-remove').click();
    await page.getByTestId('shelve-message').fill('my shelf\nwith a comment');
    await page.getByRole('button', { name: 'Shelve Changes' }).click();

    await expect.poll(async () => acceptOf(await posted(page)) !== undefined).toBe(true);
    const result = acceptOf(await posted(page))!;
    expect(result['listId']).toBe('default');
    expect(result['message']).toBe('my shelf\nwith a comment');
    expect(result['paths']).toEqual([
      'src/main/java/util/Strings.java',
      'src/main/java/api/Controller.java',
    ]);
    expect(result['partials']).toEqual([]);
    expect(result['removeFromWorktree']).toBe(false);
  });

  test('per-change exclusion moves the file into partials with its signature', async ({ page }) => {
    await openShelve(page);
    await page.getByTestId('shelve-diff-toggle').click();
    await page.getByRole('treeitem', { name: DIFF_ROW }).click();
    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 3 included');

    await page.getByTestId('diff-include-1').click();
    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 2 included');
    // The tree row says so, like the commit window.
    await expect(page.getByRole('treeitem', { name: /2 of 3 changes/ })).toBeVisible();

    await page.getByRole('button', { name: 'Shelve Changes' }).click();
    await expect.poll(async () => acceptOf(await posted(page)) !== undefined).toBe(true);
    const result = acceptOf(await posted(page))!;
    expect(result['paths']).toEqual([
      'src/main/java/api/Controller.java',
      'docs/notes.md',
    ]);
    expect(result['partials']).toEqual([
      {
        relPath: 'src/main/java/util/Strings.java',
        included: [0, 2],
        signature: '2,2,2,2;4,4,4,4;6,6,6,6',
      },
    ]);
  });

  test('excluding every change unticks the file and drops it from the result', async ({ page }) => {
    await openShelve(page);
    await page.getByTestId('shelve-diff-toggle').click();
    await page.getByRole('treeitem', { name: DIFF_ROW }).click();
    for (const i of [0, 1, 2]) await page.getByTestId(`diff-include-${i}`).click();

    await expect(page.getByRole('treeitem', { name: /Strings\.java/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.getByTestId('shelve-count')).toHaveText('2 of 3 modified');

    await page.getByRole('button', { name: 'Shelve Changes' }).click();
    await expect.poll(async () => acceptOf(await posted(page)) !== undefined).toBe(true);
    const result = acceptOf(await posted(page))!;
    expect(result['paths']).toEqual(['src/main/java/api/Controller.java', 'docs/notes.md']);
    expect(result['partials']).toEqual([]);
  });

  test('a file without per-change granularity says it shelves whole', async ({ page }) => {
    await openShelve(page);
    await page.getByTestId('shelve-diff-toggle').click();
    await page.getByRole('treeitem', { name: /notes\.md/ }).click();
    await expect(page.getByTestId('shelve-whole-file')).toContainText('docs/notes.md');
  });

  test('Shelve Changes disables without a message or without ticks', async ({ page }) => {
    await openShelve(page);
    await page.getByTestId('shelve-message').fill('');
    await expect(page.getByRole('button', { name: 'Shelve Changes' })).toBeDisabled();
    await page.getByTestId('shelve-message').fill('x');
    await expect(page.getByRole('button', { name: 'Shelve Changes' })).toBeEnabled();

    for (const name of [/Strings\.java/, /Controller\.java/, /notes\.md/]) {
      await page.getByRole('treeitem', { name }).locator('.gt-tree-check').click();
    }
    await expect(page.getByRole('button', { name: 'Shelve Changes' })).toBeDisabled();
  });
});
