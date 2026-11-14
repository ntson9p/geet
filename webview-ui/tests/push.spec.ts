import { expect, test, type Page } from '@playwright/test';
import { mockPushDialogHostScript } from './mockPushDialogHost';

/**
 * The Push dialog, as IntelliJ's `VcsPushDialog` (P13-T1; rebuilt in
 * POST-P14ao): the `source → remote : branch` tree with the outgoing commits,
 * the merged changes of what is selected, the selected commit's details, the
 * target editor, Force Push's own warning, Define Remote — and the two things
 * the host cannot see: what the "will run" line says, and what
 * `dialog/accept` carries.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

type Scenario = 'single' | 'multi' | 'noRemote' | 'protected' | 'hooks' | 'many';

async function openPush(page: Page, scenario: Scenario = 'single'): Promise<void> {
  await page.addInitScript((s) => {
    (window as unknown as { __gtPushScenario: string }).__gtPushScenario = s;
  }, scenario);
  await page.addInitScript(mockPushDialogHostScript);
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: /Push Commits/ })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(msgs: PostedMsg[]): Record<string, unknown> | undefined {
  return msgs.find((m) => m.method === 'dialog/accept')?.params;
}

const pushButton = (page: Page) => page.getByRole('button', { name: 'Push', exact: true });
const commitRows = (page: Page) => page.getByTestId('push-commit-row');
const repoRow = (page: Page, label = 'demo-git') => page.getByTestId(`push-repo-row-${label}`);

test.describe('push dialog — IntelliJ layout', () => {
  test('one repository: `source → remote : branch` with its commits, their changes, the footer', async ({ page }) => {
    await openPush(page);
    await expect(page.getByRole('dialog', { name: 'Push Commits to demo-git' })).toBeVisible();

    // The tree: the row, then only each commit's subject.
    await expect(repoRow(page)).toContainText('feature/x → origin : feature/x');
    await expect(commitRows(page)).toHaveText(['fix the lexer', 'add the parser']);
    // A single repository has no checkbox, and no Edit all targets.
    await expect(page.getByTestId('push-repo-demo-git')).toHaveCount(0);
    await expect(page.getByTestId('push-edit-all')).toHaveCount(0);

    // The repository row is selected first: the changes of all its commits.
    await expect(repoRow(page)).toHaveAttribute('aria-selected', 'true');
    const files = page.getByTestId('push-files');
    await expect(files.getByRole('treeitem', { name: /Strings\.java/ })).toBeVisible();
    await expect(files.getByRole('treeitem', { name: /Controller\.java/ })).toBeVisible();
    await expect(files.getByRole('treeitem', { name: /demo-git/ })).toContainText('3 files');
    // Details belong to one selected commit, not to a repository row.
    await expect(page.getByRole('button', { name: 'Show Details' })).toBeDisabled();
    await expect(page.getByTestId('push-details')).toHaveCount(0);

    // Footer: Push tags off, its mode greyed; no Run Git hooks without a pre-push hook.
    await expect(page.getByTestId('push-tags-on')).not.toBeChecked();
    await expect(page.getByTestId('push-tags-mode')).toBeDisabled();
    await expect(page.getByTestId('push-run-hooks')).toHaveCount(0);
    await expect(pushButton(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('a commit row carries IntelliJ’s tooltip: hash, date, author, message', async ({ page }) => {
    await openPush(page);
    const title = await commitRows(page).first().getAttribute('title');
    expect(title).toMatch(/^bbbbbbbb {2}.+ {2}by Ada\n\nfix the lexer\n\nWhy it was done\.\n\nSelect to show commit details$/);
  });

  test('one selected commit shows its own changes and its details', async ({ page }) => {
    await openPush(page);
    await commitRows(page).nth(1).click();
    await expect
      .poll(async () => {
        const asked = (await posted(page)).filter((m) => m.method === 'pushDialog/changes');
        return asked.at(-1)?.params?.['shas'];
      })
      .toEqual(['a'.repeat(40)]);
    const files = page.getByTestId('push-files');
    await expect(files.getByRole('treeitem', { name: /Strings\.java/ })).toBeVisible();
    await expect(files.getByRole('treeitem', { name: /Controller\.java/ })).toHaveCount(0);
    await expect(page.getByTestId('push-details')).toContainText('add the parser');
    await expect(page.getByTestId('push-details')).toContainText('ada@example.com');

    // Show Details off hides the panel, and is remembered by the host.
    await page.getByRole('button', { name: 'Show Details' }).click();
    await expect(page.getByTestId('push-details')).toHaveCount(0);
    await expect
      .poll(async () => (await posted(page)).some((m) => m.method === 'pushDialog/saveUi' && m.params?.['showDetails'] === false))
      .toBe(true);
  });

  test('several selected commits merge their changes, oldest first, without details', async ({ page }) => {
    await openPush(page);
    await commitRows(page).first().click();
    await commitRows(page).nth(1).click({ modifiers: ['Control'] });
    await expect(commitRows(page).first()).toHaveAttribute('aria-selected', 'true');
    await expect(commitRows(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    // Both are the repository's whole set, asked for (oldest first) when its
    // row was selected on opening; the dialog keeps the answer, not asking twice.
    const asked = (await posted(page)).filter((m) => m.method === 'pushDialog/changes').map((m) => m.params?.['shas']);
    expect(asked).toContainEqual(['a'.repeat(40), 'b'.repeat(40)]);
    const files = page.getByTestId('push-files');
    await expect(files.getByRole('treeitem', { name: /Strings\.java/ })).toBeVisible();
    await expect(files.getByRole('treeitem', { name: /Controller\.java/ })).toBeVisible();
    await expect(page.getByTestId('push-details')).toHaveCount(0);

    // Nothing selected: IntelliJ's empty text.
    await commitRows(page).first().click({ modifiers: ['Control'] });
    await commitRows(page).nth(1).click({ modifiers: ['Control'] });
    await expect(page.getByTestId('push-changes-empty')).toHaveText('No commits selected');
  });

  test('`...` doubles the twenty commits a row shows', async ({ page }) => {
    await openPush(page, 'many');
    await expect(commitRows(page)).toHaveCount(20);
    await page.getByTestId('push-more-commits').click();
    await expect(commitRows(page)).toHaveCount(40);
    await page.getByTestId('push-more-commits').click();
    await expect(commitRows(page)).toHaveCount(45);
    await expect(page.getByTestId('push-more-commits')).toHaveCount(0);
  });
});

test.describe('push dialog — what runs', () => {
  test('the will-run line is the real argv and tracks every option', async ({ page }) => {
    await openPush(page, 'hooks');
    const cmd = page.getByTestId('push-command');
    await expect(cmd).toContainText('git push origin refs/heads/feature/x:refs/heads/feature/x');
    await page.getByTestId('push-tags-on').check();
    await expect(cmd).toContainText('git push --tags origin');
    await page.getByTestId('push-tags-mode').selectOption('follow');
    await expect(cmd).toContainText('git push --follow-tags origin');
    // Run Git hooks is there with a pre-push hook, ticked to start with.
    await expect(page.getByTestId('push-run-hooks')).toBeChecked();
    await page.getByTestId('push-run-hooks').uncheck();
    await expect(cmd).toContainText('git push --no-verify --follow-tags origin');
  });

  test('Push posts each repository’s source, target and the footer options', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-tags-on').check();
    await pushButton(page).click();
    await expect.poll(async () => acceptOf(await posted(page))).toBeTruthy();
    expect(acceptOf(await posted(page))).toEqual({
      repos: [
        {
          root: 'D:/repos/demo-git',
          source: { kind: 'branch', presentation: 'feature/x', revision: 'refs/heads/feature/x', branch: 'feature/x' },
          target: { remote: 'origin', branch: 'feature/x' },
          setUpstream: false,
        },
      ],
      tags: 'all',
      runHooks: true,
      force: false,
    });
  });

  test('Force Push warns, naming the target; Cancel keeps the dialog', async ({ page }) => {
    await openPush(page);
    await page.getByRole('button', { name: 'Push options' }).click();
    await page.getByRole('menuitem', { name: 'Force Push' }).click();
    const confirm = page.getByTestId('push-force-confirm');
    await expect(confirm).toContainText(
      "You're going to force push to 'feature/x'. It may overwrite commits at the remote. Are you sure you want to proceed?",
    );
    await page.getByTestId('push-force-confirm-cancel').click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Push Commits to demo-git' })).toBeVisible();
    expect(acceptOf(await posted(page))).toBeUndefined();
    expect((await posted(page)).some((m) => m.method === 'dialog/cancel')).toBe(false);
  });

  test('Force Push with Don’t warn about this target posts both', async ({ page }) => {
    await openPush(page);
    await page.getByRole('button', { name: 'Push options' }).click();
    await page.getByRole('menuitem', { name: 'Force Push' }).click();
    await page.getByTestId('push-force-dont-warn').check();
    await page.getByTestId('push-force-confirm-accept').click();
    await expect.poll(async () => acceptOf(await posted(page))).toBeTruthy();
    const accepted = acceptOf(await posted(page))!;
    expect(accepted['force']).toBe(true);
    expect(accepted['dontWarnForce']).toEqual({ remote: 'origin', branch: 'feature/x' });
  });

  test('Force Push is not offered for a protected branch, and says why', async ({ page }) => {
    await openPush(page, 'protected');
    await page.getByRole('button', { name: 'Push options' }).click();
    const force = page.getByRole('menuitem', { name: 'Force Push' });
    await expect(force).toHaveAttribute('aria-disabled', 'true');
    await expect(force).toHaveAttribute('title', /Force push to main is prohibited/);
  });

  test('Escape and Cancel both post dialog/cancel', async ({ page }) => {
    await openPush(page);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await posted(page)).some((m) => m.method === 'dialog/cancel')).toBe(true);
  });
});

test.describe('push dialog — the target', () => {
  test('clicking the branch edits it: suggestions, recent first; Enter retargets to a New branch', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-target-demo-git').click();
    const field = page.getByTestId('push-edit-branch');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('feature/x');
    // Push waits while a target is being edited, as IntelliJ's does.
    await expect(pushButton(page)).toBeDisabled();

    await field.fill('');
    await field.pressSequentially('re');
    const list = page.getByTestId('push-completion');
    // Names that start with `re`, recent first; then the ones that only hold it,
    // as IntelliJ's plain matcher also offers them.
    await expect(list.getByRole('option')).toHaveText([/review\/x.*recently pushed/, /release\/1\.2/, /feature\/x/]);

    // Spaces become `_` as they are typed.
    await field.fill('');
    await field.pressSequentially('my topic');
    await expect(field).toHaveValue('my_topic');
    // No name holds `my_topic`: no suggestions stand between it and Enter
    // (and Escape here would drop the edit, as with none it does).
    await expect(list).toHaveCount(0);
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('push-target-editor')).toHaveCount(0);
    await expect
      .poll(async () => (await posted(page)).find((m) => m.method === 'pushDialog/retarget')?.params)
      .toEqual({ root: 'D:/repos/demo-git', remote: 'origin', branch: 'my_topic' });
    await expect(page.getByTestId('push-badge-demo-git')).toHaveText('New');
    await expect(commitRows(page)).toHaveCount(3);
    await expect(page.getByTestId('push-command')).toContainText('refs/heads/feature/x:refs/heads/my_topic');

    await pushButton(page).click();
    await expect.poll(async () => acceptOf(await posted(page))).toBeTruthy();
    const repos = acceptOf(await posted(page))!['repos'] as Array<{ target: unknown }>;
    expect(repos[0]?.target).toEqual({ remote: 'origin', branch: 'my_topic' });
  });

  test('Escape cancels the edit, not the dialog', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-target-demo-git').click();
    await page.getByTestId('push-edit-branch').fill('other');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('push-target-editor')).toHaveCount(0);
    await expect(page.getByTestId('push-target-demo-git')).toHaveText('feature/x');
    expect((await posted(page)).some((m) => m.method === 'dialog/cancel')).toBe(false);
    expect((await posted(page)).some((m) => m.method === 'pushDialog/retarget')).toBe(false);
  });

  test('a name git would refuse is not applied', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-target-demo-git').click();
    await page.getByTestId('push-edit-branch').fill('topic.lock');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('push-edit-problem')).toHaveText('Invalid destination branch name: topic.lock');
    await expect(page.getByTestId('push-target-editor')).toBeVisible();
  });

  test('Set upstream appears for another target, labels it, and reaches argv', async ({ page }) => {
    await openPush(page);
    await page.keyboard.press('F2');
    const field = page.getByTestId('push-edit-branch');
    await expect(field).toBeFocused();
    await expect(page.getByTestId('push-set-upstream')).toHaveCount(0);
    await field.fill('release/1.2');
    await page.getByTestId('push-set-upstream').check();
    // The box keeps the focus in the field, and the suggestion under it: Escape
    // closes that (Enter on it would pick it), then Enter applies.
    await expect(page.getByTestId('push-completion')).toBeVisible();
    await field.press('Escape');
    await expect(field).toBeVisible();
    await field.press('Enter');
    await expect(page.getByTestId('push-badge-demo-git')).toHaveText('Upstream');
    await expect(page.getByTestId('push-command')).toContainText('git push --set-upstream origin');
    await pushButton(page).click();
    await expect.poll(async () => acceptOf(await posted(page))).toBeTruthy();
    const repos = acceptOf(await posted(page))!['repos'] as Array<{ setUpstream: boolean }>;
    expect(repos[0]?.setUpstream).toBe(true);
  });

  test('clicking the remote lists the remotes and Define remote; picking one retargets', async ({ page }) => {
    await openPush(page);
    await page.getByTestId('push-remote-demo-git').click();
    const menu = page.getByRole('menu', { name: 'Remotes' });
    await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['origin', 'upstream']);
    await expect(menu.getByRole('menuitem', { name: 'Define remote' })).toBeVisible();
    await menu.getByRole('menuitemcheckbox', { name: 'upstream' }).click();
    await expect
      .poll(async () => (await posted(page)).find((m) => m.method === 'pushDialog/retarget')?.params)
      .toEqual({ root: 'D:/repos/demo-git', remote: 'upstream', branch: 'feature/x' });
    await expect(repoRow(page)).toContainText('upstream : feature/x');
  });

  test('without a remote: Define remote, a URL that fails, then one that works', async ({ page }) => {
    await openPush(page, 'noRemote');
    await expect(pushButton(page)).toBeDisabled();
    await page.getByTestId('push-define-remote-link').click();
    const form = page.getByTestId('push-define-remote');
    await expect(form).toContainText('Define Remote');
    await expect(page.getByTestId('push-remote-name')).toHaveValue('origin');
    await expect(page.getByTestId('push-remote-fetch')).toBeChecked();

    await page.getByTestId('push-remote-url').fill('bad');
    await page.getByTestId('push-define-remote-accept').click();
    await expect(page.getByTestId('push-remote-url-problem')).toHaveText('repository not found');

    await page.getByTestId('push-remote-url').fill('https://example.invalid/demo.git');
    await page.getByTestId('push-define-remote-accept').click();
    await expect(form).toHaveCount(0);
    await expect(repoRow(page)).toContainText('feature/x → origin : feature/x');
    await expect(page.getByTestId('push-badge-demo-git')).toHaveText('New');
    await expect(pushButton(page)).toBeEnabled();
  });
});

test.describe('push dialog — several repositories', () => {
  test('checkboxes, the checked one open, the other faded and closed; Space toggles', async ({ page }) => {
    await openPush(page, 'multi');
    await expect(page.getByRole('dialog', { name: 'Push Commits' })).toBeVisible();
    await expect(page.getByTestId('push-repo-demo-git')).toBeChecked();
    await expect(page.getByTestId('push-repo-lib-utils')).not.toBeChecked();
    await expect(repoRow(page, 'lib-utils')).toHaveClass(/gt-push-dim/);
    await expect(repoRow(page, 'lib-utils')).toHaveAttribute('aria-expanded', 'false');
    await expect(commitRows(page)).toHaveCount(2);

    // Only the checked repository is pushed.
    await expect(page.getByTestId('push-command')).toContainText('refs/heads/feature/x');
    await expect(page.getByTestId('push-command')).not.toContainText('refs/heads/main');

    // On its name: the middle of the row is its `origin` link, which opens the remotes.
    await repoRow(page, 'lib-utils').getByText('lib-utils', { exact: true }).click();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('push-repo-lib-utils')).toBeChecked();
    await expect(page.getByTestId('push-command')).toContainText('refs/heads/main:refs/heads/main');
    await page.keyboard.press('ArrowRight');
    await expect(commitRows(page)).toHaveCount(3);
  });

  test('Edit all targets sends what is typed to every repository', async ({ page }) => {
    await openPush(page, 'multi');
    await page.getByTestId('push-repo-lib-utils').check();
    await page.getByTestId('push-edit-all').click();
    const field = page.getByTestId('push-edit-branch');
    await field.fill('release/2.0');
    // The other row follows as you type.
    await expect(repoRow(page, 'lib-utils')).toContainText('origin : release/2.0');
    await field.press('Enter');
    await expect
      .poll(async () =>
        (await posted(page))
          .filter((m) => m.method === 'pushDialog/retarget')
          .map((m) => m.params?.['root'])
          .sort(),
      )
      .toEqual(['D:/repos/demo-git', 'D:/repos/lib-utils']);
  });
});

test.describe('push dialog — the changes toolbar', () => {
  test('Show Diff and Edit Source need a selected file; View Options flattens the tree', async ({ page }) => {
    await openPush(page);
    await expect(page.getByRole('button', { name: 'Show Diff' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Edit Source' })).toBeDisabled();
    const files = page.getByTestId('push-files');
    await files.getByRole('treeitem', { name: /Strings\.java/ }).click();
    await page.getByRole('button', { name: 'Show Diff' }).click();
    await expect
      .poll(async () => (await posted(page)).find((m) => m.method === 'pushDialog/openDiff')?.params?.['index'])
      .toBe(0);
    await page.getByRole('button', { name: 'Edit Source' }).click();
    await expect
      .poll(async () => (await posted(page)).find((m) => m.method === 'pushDialog/openFile')?.params?.['path'])
      .toBe('src/main/java/util/Strings.java');

    await page.getByRole('button', { name: 'View Options' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Directory' }).click();
    await expect(files.getByRole('treeitem', { name: /src\/main\/java\/util\/Strings\.java/ })).toBeVisible();
  });
});
