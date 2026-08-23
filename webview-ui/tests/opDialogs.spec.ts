import { expect, test, type Page } from '@playwright/test';
import { mockOpDialogHostScript } from './mockOpDialogHost';

/**
 * P13-T3: Merge · Rebase · Reset · Rollback. The acceptance line's "mutually
 * exclusive pairs rejected in the UI" is a webview behaviour, so it is pinned
 * here; the argv matrix itself is unit-tested against the same builders these
 * dialogs import.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function open(
  page: Page,
  dialog: 'merge' | 'rebase' | 'reset' | 'rollback',
  title: RegExp,
): Promise<void> {
  await page.addInitScript(mockOpDialogHostScript(dialog));
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(msgs: PostedMsg[]): Record<string, unknown> | undefined {
  return msgs.find((m) => m.method === 'dialog/accept')?.params;
}

/**
 * Ticks an option in the "Modify options" dropdown, revealing its control.
 * The items carry `checked`, so `Menu` gives them role `menuitemcheckbox`.
 */
async function modify(page: Page, label: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Modify options' }).click();
  await page.getByRole('menuitemcheckbox', { name: label }).click();
}

/** The FileTree's checkbox is presentational — the row is the treeitem. */
function rowCheck(page: Page, name: RegExp) {
  return page.getByRole('treeitem', { name }).locator('.gt-tree-check');
}

test.describe('P13-T3 merge dialog', () => {
  test('opens compact, with the ref picker and no flags showing', async ({ page }) => {
    await open(page, 'merge', /Merge into feature\/y/);
    await expect(page.getByTestId('merge-ref')).toHaveValue('main');
    await expect(page.getByTestId('will-run')).toContainText('git merge -- main');
    // The point of "Modify options": the flags are not on screen until asked for.
    await expect(page.getByTestId('merge-no-ff')).toHaveCount(0);
    await expect(page.getByTestId('merge-squash')).toHaveCount(0);
  });

  test('Modify options reveals a flag and it reaches the command', async ({ page }) => {
    await open(page, 'merge', /Merge into/);
    await modify(page, /Create a merge commit/);
    await page.getByTestId('merge-no-ff').check();
    await expect(page.getByTestId('will-run')).toContainText('git merge --no-ff -- main');
  });

  test('mutually exclusive flags are rejected with a reason, not silently', async ({ page }) => {
    await open(page, 'merge', /Merge into/);
    await modify(page, /Create a merge commit/);
    await modify(page, /Fast-forward only/);
    await page.getByTestId('merge-no-ff').check();
    await page.getByTestId('merge-ff-only').check();

    await expect(page.getByTestId('option-conflicts')).toContainText('contradict');
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
  });

  test('a squash refuses a message that would be dropped', async ({ page }) => {
    await open(page, 'merge', /Merge into/);
    await modify(page, /Squash/);
    await modify(page, /Custom message/);
    await page.getByTestId('merge-squash').check();
    await page.getByTestId('merge-message').fill('this would vanish');

    await expect(page.getByTestId('option-conflicts')).toContainText('dropped');
    await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled();
    // And the preview never pretends the message is going anywhere.
    await expect(page.getByTestId('will-run')).not.toContainText('-m');
  });

  test('un-ticking an option in the dropdown also turns the flag off', async ({ page }) => {
    await open(page, 'merge', /Merge into/);
    await modify(page, /Create a merge commit/);
    await page.getByTestId('merge-no-ff').check();
    await expect(page.getByTestId('will-run')).toContainText('--no-ff');

    await modify(page, /Create a merge commit/);
    await expect(page.getByTestId('merge-no-ff')).toHaveCount(0);
    await expect(page.getByTestId('will-run')).not.toContainText('--no-ff');
  });

  test('strategy and strategy-option are separate controls', async ({ page }) => {
    await open(page, 'merge', /Merge into/);
    await modify(page, /Strategy/);
    await page.getByTestId('merge-strategy').selectOption('ours');
    await page.getByTestId('merge-strategy-option').selectOption('theirs');
    await expect(page.getByTestId('will-run')).toContainText(
      'git merge --strategy ours --strategy-option theirs -- main',
    );

    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      options: { ref: 'main', strategy: 'ours', strategyOption: 'theirs' },
    });
  });
});

test.describe('P13-T3 rebase dialog', () => {
  test('opens on the default onto-ref', async ({ page }) => {
    await open(page, 'rebase', /Rebase feature\/y/);
    await expect(page.getByTestId('rebase-onto')).toHaveValue('main');
    await expect(page.getByTestId('will-run')).toContainText('git rebase main');
  });

  test('a From ref turns the command into a --onto transplant', async ({ page }) => {
    await open(page, 'rebase', /Rebase/);
    await modify(page, /Rebase a range from/);
    await page.getByTestId('rebase-from-expression').fill('old-base');
    await expect(page.getByTestId('will-run')).toContainText('git rebase --onto main old-base');
  });

  test('interactive says it hands off, and renames the action', async ({ page }) => {
    await open(page, 'rebase', /Rebase/);
    await modify(page, /Interactive/);
    await page.getByTestId('rebase-interactive').check();
    await expect(page.getByTestId('rebase-interactive-note')).toContainText(
      'interactive rebase editor',
    );
    await expect(page.getByRole('button', { name: 'Start Interactive Rebase' })).toBeEnabled();
  });

  test('the remaining flags each reach the command', async ({ page }) => {
    await open(page, 'rebase', /Rebase/);
    for (const label of [/Keep merge commits/, /Autostash/, /Skip hooks/, /Keep empty commits/]) {
      await modify(page, label);
    }
    await page.getByTestId('rebase-merges').check();
    await page.getByTestId('rebase-autostash').check();
    await page.getByTestId('rebase-no-verify').check();
    await page.getByTestId('rebase-keep-empty').check();
    await expect(page.getByTestId('will-run')).toContainText(
      'git rebase --rebase-merges --autostash --no-verify --keep-empty main',
    );
  });
});

test.describe('P13-T3 reset dialog', () => {
  test('offers all four modes, Keep included', async ({ page }) => {
    await open(page, 'reset', /Reset feature\/y/);
    for (const mode of ['soft', 'mixed', 'hard', 'keep']) {
      await expect(page.getByTestId(`reset-mode-${mode}`)).toBeVisible();
    }
    await expect(page.getByTestId('reset-mode-mixed')).toBeChecked();
  });

  test('the impact line is live and mode-specific', async ({ page }) => {
    await open(page, 'reset', /Reset/);
    await expect(page.getByTestId('reset-impact')).toContainText('unstages 2 staged changes');

    await page.getByTestId('reset-mode-hard').check();
    await expect(page.getByTestId('reset-impact')).toContainText('DISCARDS 3 local changes');

    await page.getByTestId('reset-mode-keep').check();
    await expect(page.getByTestId('reset-impact')).toContainText('refuses the reset');

    await page.getByTestId('reset-mode-soft').check();
    await expect(page.getByTestId('reset-impact')).toContainText('untouched');
  });

  test('accepts a raw revision expression, not just a branch', async ({ page }) => {
    await open(page, 'reset', /Reset/);
    await page.getByTestId('reset-ref-expression').fill('HEAD~3');
    await page.getByTestId('reset-mode-hard').check();
    await expect(page.getByTestId('will-run')).toContainText('git reset --hard HEAD~3');

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toEqual({
      ref: 'HEAD~3',
      mode: 'hard',
    });
  });

  test('an empty revision disables the action', async ({ page }) => {
    await open(page, 'reset', /Reset/);
    await page.getByTestId('reset-ref-expression').fill('');
    await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
  });
});

test.describe('P13-T3 rollback dialog', () => {
  test('lists the files with counts and a preview placeholder', async ({ page }) => {
    await open(page, 'rollback', /Rollback Changes/);
    await expect(page.getByTestId('rollback-count')).toHaveText('4 of 4 files');
    await expect(page.getByRole('treeitem', { name: /app\.ts/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /scratch\.txt/ })).toBeVisible();
    await expect(page.getByTestId('rollback-delete-added')).toBeChecked();
    await expect(page.getByTestId('rollback-diff')).toContainText('Select one file');
  });

  test('the will-run line separates git commands from local deletions', async ({ page }) => {
    await open(page, 'rollback', /Rollback Changes/);
    const cmd = page.getByTestId('will-run');
    await expect(cmd).toContainText('git restore --source=HEAD --staged --worktree --');
    await expect(cmd).toContainText('git rm --cached -q -- src/new.ts');
    await expect(cmd).toContainText('deletes 2 local files');

    // Unticking keeps the files on disk — the restore/unstage are unchanged.
    await page.getByTestId('rollback-delete-added').uncheck();
    await expect(cmd).not.toContainText('deletes');
    await expect(cmd).toContainText('git rm --cached -q -- src/new.ts');
  });

  test('unticking files narrows the plan and the accepted payload', async ({ page }) => {
    await open(page, 'rollback', /Rollback Changes/);
    await rowCheck(page, /scratch\.txt/).click();
    await expect(page.getByTestId('rollback-count')).toHaveText('3 of 4 files');

    await page.getByRole('button', { name: 'Rollback', exact: true }).click();
    const params = (await posted(page)).find((m) => m.method === 'dialog/accept')?.params as
      | { paths: string[]; deleteAddedLocalCopies: boolean }
      | undefined;
    expect(params?.paths).not.toContain('scratch.txt');
    expect(params?.paths).toContain('src/app.ts');
    expect(params?.deleteAddedLocalCopies).toBe(true);
  });

  test('selecting a file previews what would be reverted', async ({ page }) => {
    await open(page, 'rollback', /Rollback Changes/);
    await page.getByRole('treeitem', { name: /app\.ts/ }).click();
    await expect(page.getByTestId('rollback-diff')).toContainText('TWO!');

    // A file the host cannot line-diff says so instead of rendering an empty pane.
    await page.getByRole('treeitem', { name: /scratch\.txt/ }).click();
    await expect(page.getByTestId('rollback-whole-file')).toContainText('reverts it whole');
  });

  test('unticking everything disables the action', async ({ page }) => {
    await open(page, 'rollback', /Rollback Changes/);
    for (const name of [/app\.ts/, /new\.ts/, /scratch\.txt/, /renamed\.md/]) {
      await rowCheck(page, name).click();
    }
    await expect(page.getByTestId('rollback-count')).toHaveText('0 of 4 files');
    await expect(page.getByRole('button', { name: 'Rollback', exact: true })).toBeDisabled();
  });
});
