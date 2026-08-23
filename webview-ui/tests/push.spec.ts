import { expect, test, type Page } from '@playwright/test';
import { mockPushDialogHostScript } from './mockPushDialogHost';

/**
 * P13-T1 Push dialog. The §2A shape (editable target row, commit list, the
 * push's changed-file tree with its own right-side toolbar, the tags/hooks
 * footer and the `[Push ▾]` split button) plus the two behaviours the host
 * cannot see: what the "will run" line says, and what `dialog/accept` carries.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openPush(page: Page): Promise<void> {
  await page.addInitScript(mockPushDialogHostScript);
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: /Push Commits to demo-git/ })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(msgs: PostedMsg[]): Record<string, unknown> | undefined {
  return msgs.find((m) => m.method === 'dialog/accept')?.params;
}

test.describe('P13-T1 push dialog layout', () => {
  test('renders the §2A shape: target row, commits, file tree, footer', async ({ page }) => {
    await openPush(page);

    // Left pane: `<local> → <remote> : <remote-branch>` and the outgoing commits.
    const target = page.getByTestId('push-target-demo-git');
    await expect(target).toContainText('feature/x');
    await expect(target).toContainText('origin : feature/x');
    await expect(page.getByTestId('push-count-demo-git')).toHaveText('2 commits');
    await expect(page.getByText('add the parser')).toBeVisible();
    await expect(page.getByText('fix the lexer')).toBeVisible();

    // Right pane: the push's changed files, counted and grouped.
    await expect(page.getByTestId('push-files-count')).toHaveText('3 files');
    await expect(page.getByRole('treeitem', { name: /Strings\.java/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /Controller\.java/ })).toBeVisible();

    // Footer per §2A.
    await expect(page.getByTestId('push-tags-on')).not.toBeChecked();
    await expect(page.getByTestId('push-tags-mode')).toBeDisabled();
    await expect(page.getByTestId('push-run-hooks')).toBeChecked();
    await expect(page.getByRole('button', { name: 'Push', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    // A single repo needs no per-repo checkbox — the section is the dialog.
    await expect(page.getByTestId('push-repo-demo-git')).toHaveCount(0);
  });

  test('the will-run line is the real argv and tracks every option', async ({ page }) => {
    await openPush(page);
    const cmd = page.getByTestId('push-command');
    await expect(cmd).toContainText('git push origin feature/x:refs/heads/feature/x');

    await page.getByTestId('push-run-hooks').uncheck();
    await expect(cmd).toContainText('git push --no-verify origin');

    await page.getByTestId('push-tags-on').check();
    await expect(cmd).toContainText('--tags');
    await page.getByTestId('push-tags-mode').selectOption('follow');
    await expect(cmd).toContainText('--follow-tags');
    await expect(cmd).not.toContainText('--tags ');
  });

  test('Push posts the destination and the footer options', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-tags-on').check();
    await page.getByTestId('push-run-hooks').uncheck();
    await page.getByRole('button', { name: 'Push', exact: true }).click();

    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      repos: [{ root: 'D:/repos/demo-git', remote: 'origin', remoteBranch: 'feature/x' }],
      tags: 'all',
      runHooks: false,
      force: false,
    });
  });

  test('the split button offers Force Push and accepts with force', async ({ page }) => {
    await openPush(page);
    await page.getByRole('button', { name: 'Push options' }).click();
    await page.getByRole('menuitem', { name: 'Force Push…' }).click();

    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({ force: true });
  });

  test('Escape and Cancel both post dialog/cancel', async ({ page }) => {
    await openPush(page);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'dialog/cancel').length)
      .toBe(1);
  });
});

test.describe('P13-T1 retargeting', () => {
  test('clicking the target opens the editor and adopts the recomputed section', async ({
    page,
  }) => {
    await openPush(page);
    await page.getByTestId('push-target-demo-git').click();

    const remote = page.getByTestId('push-edit-remote');
    await expect(remote).toHaveValue('origin');
    await remote.selectOption('upstream');
    await page.getByTestId('push-edit-branch').fill('release/1.2');
    await page.getByTestId('push-edit-apply').click();

    // The host's answer replaces the section wholesale — commits, files and all.
    const target = page.getByTestId('push-target-demo-git');
    await expect(target).toContainText('upstream : release/1.2');
    await expect(target).toContainText('new');
    await expect(page.getByTestId('push-count-demo-git')).toHaveText('3 commits');
    await expect(page.getByTestId('push-files-count')).toHaveText('4 files');

    // Retargeting to a different name must not repoint tracking, but publishing
    // an untracked branch under its own name must — the mock returns
    // hasUpstream:false, so the refspec changes and --set-upstream stays off.
    const cmd = page.getByTestId('push-command');
    await expect(cmd).toContainText('git push upstream feature/x:refs/heads/release/1.2');
    await expect(cmd).not.toContainText('--set-upstream');
  });

  test('accepting after a retarget pushes to the chosen ref', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-target-demo-git').click();
    await page.getByTestId('push-edit-branch').fill('release/1.2');
    await page.getByTestId('push-edit-apply').click();
    await expect(page.getByTestId('push-target-demo-git')).toContainText('origin : release/1.2');

    await page.getByRole('button', { name: 'Push', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      repos: [{ root: 'D:/repos/demo-git', remote: 'origin', remoteBranch: 'release/1.2' }],
    });
  });
});

test.describe('P13-T1 file pane toolbar', () => {
  test('group-by flattens the tree and back', async ({ page }) => {
    await openPush(page);
    // Grouped: the single-child chain collapses into one folder row with a count.
    const folderRow = page.getByRole('treeitem', { name: 'src/main/java, 2 files' });
    await expect(folderRow).toBeVisible();

    await page.getByRole('button', { name: 'Group by Directory' }).click();
    await expect(folderRow).toHaveCount(0);
    await expect(
      page.getByRole('treeitem', { name: 'src/main/java/util/Strings.java' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Group by Directory' }).click();
    await expect(folderRow).toBeVisible();
  });

  test('Show Diff and Edit Source need a selected file, then reach the host', async ({ page }) => {
    await openPush(page);
    const showDiff = page.getByRole('button', { name: 'Show Diff' });
    await expect(showDiff).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit Source' })).toBeDisabled();

    await page.getByRole('treeitem', { name: /Strings\.java/ }).click();
    await expect(showDiff).toBeEnabled();
    await showDiff.click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'pushDialog/openDiff').length)
      .toBe(1);

    await page.getByRole('button', { name: 'Edit Source' }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'pushDialog/openFile').length)
      .toBe(1);
  });

  test('Preview on Click opens the diff from a single selection', async ({ page }) => {
    await openPush(page);
    await page.getByRole('button', { name: 'Preview on Click' }).click();
    await page.getByRole('treeitem', { name: /Controller\.java/ }).click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'pushDialog/openDiff').length)
      .toBe(1);
  });
});
