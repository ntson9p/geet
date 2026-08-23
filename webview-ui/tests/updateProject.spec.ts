import { expect, test, type Page } from '@playwright/test';
import { mockUpdateDialogHostScript } from './mockUpdateDialogHost';

/**
 * P13-T2 Update Project dialog: the §2A radio pair, `Do not show again`, the
 * `Reset to the Remote Branch` footer action, and the "will run" line that has
 * to change with the radio.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openUpdate(page: Page): Promise<void> {
  await page.addInitScript(mockUpdateDialogHostScript);
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: 'Update Project' })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(msgs: PostedMsg[]): Record<string, unknown> | undefined {
  return msgs.find((m) => m.method === 'dialog/accept')?.params;
}

test.describe('P13-T2 update project dialog', () => {
  test('renders the §2A shape and opens on Merge', async ({ page }) => {
    await openUpdate(page);
    await expect(page.getByTestId('update-summary')).toContainText('feature/x');
    await expect(page.getByTestId('update-summary')).toContainText('origin/feature/x');
    await expect(page.getByTestId('update-summary')).toContainText('3 behind');
    await expect(page.getByTestId('update-merge')).toBeChecked();
    await expect(page.getByTestId('update-rebase')).not.toBeChecked();
    await expect(page.getByTestId('update-dont-show')).not.toBeChecked();
    await expect(page.getByTestId('update-reset')).toBeVisible();
    await expect(page.getByRole('button', { name: 'OK' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('the will-run line follows the radio, and reset is always the same pair', async ({
    page,
  }) => {
    await openUpdate(page);
    const cmd = page.getByTestId('update-command');
    await expect(cmd).toContainText('git fetch --prune origin && git merge origin/feature/x');
    await expect(cmd).toContainText('git reset --hard origin/feature/x');

    await page.getByTestId('update-rebase').check();
    await expect(cmd).toContainText('git fetch --prune origin && git rebase origin/feature/x');
    // Reset does not care which strategy is selected.
    await expect(cmd).toContainText('git reset --hard origin/feature/x');
  });

  test('OK posts the selected strategy', async ({ page }) => {
    await openUpdate(page);
    await page.getByTestId('update-rebase').check();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toEqual({
      action: 'update',
      strategy: 'rebase',
      dontShowAgain: false,
    });
  });

  test('Do not show again explains itself and rides along with OK', async ({ page }) => {
    await openUpdate(page);
    await expect(page.getByTestId('update-remember-note')).toHaveCount(0);
    await page.getByTestId('update-dont-show').check();
    await expect(page.getByTestId('update-remember-note')).toContainText('Ctrl+T will run Merge');

    await page.getByTestId('update-rebase').check();
    await expect(page.getByTestId('update-remember-note')).toContainText('Ctrl+T will run Rebase');

    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      action: 'update',
      strategy: 'rebase',
      dontShowAgain: true,
    });
  });

  test('Reset to the Remote Branch accepts as reset and never records a strategy', async ({
    page,
  }) => {
    await openUpdate(page);
    // Even with the box ticked, the reset path must not silently persist a
    // strategy the user never confirmed for the OK path.
    await page.getByTestId('update-dont-show').check();
    await page.getByTestId('update-reset').click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      action: 'reset',
      dontShowAgain: false,
    });
  });

  test('Cancel posts dialog/cancel', async ({ page }) => {
    await openUpdate(page);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'dialog/cancel').length)
      .toBe(1);
  });
});
