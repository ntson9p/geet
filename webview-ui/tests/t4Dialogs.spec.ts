import { expect, test, type Page } from '@playwright/test';
import { mockT4DialogHostScript } from './mockT4DialogHost';

/** P13-T4: Cherry-pick · Stash · Unstash · Apply Patch · Clone · Manage Remotes. */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

type T4Dialog = 'cherryPick' | 'stash' | 'unstash' | 'applyPatch' | 'clone' | 'remotes';

async function open(page: Page, dialog: T4Dialog, title: RegExp): Promise<void> {
  await page.addInitScript(mockT4DialogHostScript(dialog));
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

async function modify(page: Page, label: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Modify options' }).click();
  await page.getByRole('menuitemcheckbox', { name: label }).click();
}

test.describe('P13-T4 cherry-pick dialog', () => {
  test('lists commits, records origin by default and previews -x', async ({ page }) => {
    await open(page, 'cherryPick', /Cherry-Pick into feature\/y/);
    await expect(page.getByTestId('cherry-count')).toHaveText('1 of 3 commits');
    await expect(page.getByTestId('cherry-record-origin')).toBeChecked();
    await expect(page.getByTestId('will-run')).toContainText('git cherry-pick -x aaaaaaa');
  });

  test('several commits reach git oldest-first, whatever order they were ticked', async ({
    page,
  }) => {
    await open(page, 'cherryPick', /Cherry-Pick/);
    // Tick the oldest second — the command must still list it first.
    await page.getByTestId('cherry-ccccccc').check();
    await expect(page.getByTestId('cherry-count')).toHaveText('2 of 3 commits');
    await expect(page.getByTestId('will-run')).toContainText('ccccccc3');
    const text = (await page.getByTestId('will-run').textContent()) ?? '';
    expect(text.indexOf('ccccccc3')).toBeLessThan(text.indexOf('aaaaaaa1'));
  });

  test('the mainline option is only usable for a merge commit', async ({ page }) => {
    await open(page, 'cherryPick', /Cherry-Pick/);
    // The default pick is an ordinary commit: the option is offered but disabled.
    await page.getByRole('button', { name: 'Modify options' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: /Mainline parent/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');

    // Select only the merge commit — now it can be set.
    await page.getByTestId('cherry-aaaaaaa').uncheck();
    await page.getByTestId('cherry-bbbbbbb').check();
    await modify(page, /Mainline parent/);
    await page.getByTestId('cherry-mainline').fill('1');
    await expect(page.getByTestId('will-run')).toContainText('-m 1');
  });

  test('unticking record-origin drops -x from the command and the payload', async ({ page }) => {
    await open(page, 'cherryPick', /Cherry-Pick/);
    await page.getByTestId('cherry-record-origin').uncheck();
    await expect(page.getByTestId('will-run')).not.toContainText('-x');

    await page.getByRole('button', { name: 'Cherry-Pick', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      options: { recordOrigin: false },
    });
  });
});

test.describe('P13-T4 stash dialog', () => {
  test('summarizes the worktree and includes untracked by default', async ({ page }) => {
    await open(page, 'stash', /Stash Changes/);
    await expect(page.getByTestId('stash-summary')).toContainText('5 changed files');
    await expect(page.getByTestId('stash-untracked')).toBeChecked();
    await expect(page.getByTestId('will-run')).toContainText('git stash push --include-untracked');
  });

  test('--keep-index and --all reach the command, and --all hides untracked', async ({ page }) => {
    await open(page, 'stash', /Stash Changes/);
    await modify(page, /Keep index/);
    await page.getByTestId('stash-keep-index').check();
    await expect(page.getByTestId('will-run')).toContainText('--keep-index');

    await modify(page, /Include ignored files/);
    await page.getByTestId('stash-all').check();
    const cmd = page.getByTestId('will-run');
    await expect(cmd).toContainText('--all');
    await expect(cmd).not.toContainText('--include-untracked');
    // The footer checkbox becomes meaningless and says so by disabling itself.
    await expect(page.getByTestId('stash-untracked')).toBeDisabled();
  });

  test('--staged is exclusive and the message rides along', async ({ page }) => {
    await open(page, 'stash', /Stash Changes/);
    await page.getByTestId('stash-message').fill('wip on the parser');
    await modify(page, /Only staged changes/);
    await page.getByTestId('stash-staged').check();
    await expect(page.getByTestId('will-run')).toContainText(
      'git stash push --staged -m "wip on the parser"',
    );

    await page.getByRole('button', { name: 'Create Stash' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      options: { staged: true, message: 'wip on the parser' },
    });
  });
});

test.describe('P13-T4 unstash dialog', () => {
  test('lists stashes, previews a file and defaults to pop', async ({ page }) => {
    await open(page, 'unstash', /Unstash Changes/);
    await expect(page.getByTestId('unstash-pop')).toBeChecked();
    await expect(page.getByTestId('unstash-reinstate')).not.toBeChecked();
    await expect(page.getByTestId('will-run')).toContainText('git stash pop stash@{0}');
    await expect(page.getByTestId('unstash-files')).toContainText('src/app.ts');

    await page.getByRole('button', { name: /src\/app\.ts/ }).click();
    await expect(page.getByTestId('unstash-diff')).toContainText('STASHED');
  });

  test('switching entry reloads its files', async ({ page }) => {
    await open(page, 'unstash', /Unstash Changes/);
    await page.getByTestId('unstash-entry').selectOption('1');
    await expect(page.getByTestId('unstash-files')).toContainText('docs/old.md');
    await expect(page.getByTestId('unstash-files')).not.toContainText('src/app.ts');
    await expect(page.getByTestId('will-run')).toContainText('stash@{1}');
  });

  test('apply instead of pop, with the index reinstated', async ({ page }) => {
    await open(page, 'unstash', /Unstash Changes/);
    await page.getByTestId('unstash-pop').uncheck();
    await page.getByTestId('unstash-reinstate').check();
    await expect(page.getByTestId('will-run')).toContainText('git stash apply --index stash@{0}');
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();

    await page.getByTestId('unstash-changelist').selectOption('feature');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toEqual({
      index: 0,
      pop: false,
      reinstateIndex: true,
      changelistId: 'feature',
    });
  });
});

test.describe('P13-T4 apply patch dialog', () => {
  test('needs a file before it can apply', async ({ page }) => {
    await open(page, 'applyPatch', /Apply Patch/);
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await expect(page.getByTestId('patch-summary')).toHaveCount(0);
  });

  test('choosing a file shows the pre-apply summary and warns about missing files', async ({
    page,
  }) => {
    await open(page, 'applyPatch', /Apply Patch/);
    await page.getByTestId('patch-choose').click();
    await expect(page.getByTestId('patch-path')).toHaveValue('D:/patches/fix.patch');
    await expect(page.getByTestId('patch-summary')).toContainText('2 files · 3 hunks');
    await expect(page.getByTestId('patch-summary')).toContainText('mailbox patch');
    await expect(page.getByTestId('patch-missing')).toContainText('missing here');
    await expect(page.getByTestId('will-run')).toContainText('git am -3 D:/patches/fix.patch');
  });

  test('the flags change the previewed command and the payload', async ({ page }) => {
    await open(page, 'applyPatch', /Apply Patch/);
    await page.getByTestId('patch-choose').click();
    await modify(page, /Reverse the patch/);
    await page.getByTestId('patch-reverse').check();
    // A reversed patch can never replay as commits — the preview switches.
    await expect(page.getByTestId('will-run')).toContainText('git apply --3way --reverse');

    await modify(page, /Strip path components/);
    await page.getByTestId('patch-p').fill('0');
    await expect(page.getByTestId('will-run')).toContainText('-p0');

    await modify(page, /Fix whitespace errors/);
    await page.getByTestId('patch-whitespace').check();
    await expect(page.getByTestId('will-run')).toContainText('--whitespace=fix');

    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      patchPath: 'D:/patches/fix.patch',
      reverse: true,
      pDepth: 0,
      whitespaceFix: true,
    });
  });
});

test.describe('P13-T4 clone dialog', () => {
  test('fills the directory from the URL until it is edited', async ({ page }) => {
    await open(page, 'clone', /Clone Repository/);
    await page.getByTestId('clone-url').fill('https://host/team/repo.git');
    await expect(page.getByTestId('clone-dir')).toHaveValue('D:/work/repo');
    await expect(page.getByTestId('will-run')).toContainText(
      'git clone -- https://host/team/repo.git D:/work/repo',
    );

    // Once the user types their own destination, the URL stops overwriting it.
    await page.getByTestId('clone-dir').fill('D:/elsewhere/mine');
    await page.getByTestId('clone-url').fill('https://host/team/other.git');
    await expect(page.getByTestId('clone-dir')).toHaveValue('D:/elsewhere/mine');
  });

  test('a non-empty directory is blocked with the reason, before Apply', async ({ page }) => {
    await open(page, 'clone', /Clone Repository/);
    await page.getByTestId('clone-url').fill('https://host/team/repo.git');
    await page.getByTestId('clone-dir').fill('D:/work/busy');
    await expect(page.getByTestId('clone-dir-problem')).toContainText('not empty');
    await expect(page.getByRole('button', { name: 'Clone', exact: true })).toBeDisabled();

    await page.getByTestId('clone-dir').fill('D:/work/fresh');
    await expect(page.getByTestId('clone-dir-problem')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clone', exact: true })).toBeEnabled();
  });

  test('depth, branch and submodules reach the command', async ({ page }) => {
    await open(page, 'clone', /Clone Repository/);
    await page.getByTestId('clone-url').fill('https://host/team/repo.git');
    await page.getByTestId('clone-submodules').check();
    await modify(page, /Shallow clone/);
    await page.getByTestId('clone-depth').fill('1');
    await modify(page, /Clone a specific branch/);
    await page.getByTestId('clone-branch').fill('develop');
    await expect(page.getByTestId('will-run')).toContainText(
      'git clone --recurse-submodules --depth 1 --branch develop --',
    );

    await page.getByTestId('clone-open-after').selectOption('add');
    await page.getByRole('button', { name: 'Clone', exact: true }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      openAfter: 'add',
      options: { recursiveSubmodules: true, depth: 1, branch: 'develop' },
    });
  });

  test('Browse fills the destination from the host picker', async ({ page }) => {
    await open(page, 'clone', /Clone Repository/);
    await page.getByTestId('clone-browse').click();
    await expect(page.getByTestId('clone-dir')).toHaveValue('D:/work/picked');
  });
});

test.describe('P13-T4 manage remotes dialog', () => {
  test('shows the table, with an empty push URL read as "same as fetch"', async ({ page }) => {
    await open(page, 'remotes', /Manage Remotes/);
    await expect(page.getByTestId('remote-row-origin')).toContainText('https://host/team/repo.git');
    await expect(page.getByTestId('remote-row-origin')).toContainText('same as fetch');
  });

  test('add → edit → remove round-trips against the table', async ({ page }) => {
    await open(page, 'remotes', /Manage Remotes/);
    await page.getByRole('button', { name: 'Add remote' }).click();
    await page.getByTestId('remote-name').fill('upstream');
    await page.getByTestId('remote-fetch').fill('https://host/upstream/repo.git');
    await page.getByTestId('remote-save').click();
    await expect(page.getByTestId('remote-row-upstream')).toBeVisible();

    // Edit it: select the row, change the fetch URL, save.
    await page.getByTestId('remote-row-upstream').click();
    await page.getByRole('button', { name: 'Edit remote' }).click();
    await page.getByTestId('remote-fetch').fill('https://host/upstream/moved.git');
    await page.getByTestId('remote-save').click();
    await expect(page.getByTestId('remote-row-upstream')).toContainText('moved.git');

    await page.getByTestId('remote-row-upstream').click();
    await page.getByRole('button', { name: 'Remove remote' }).click();
    await expect(page.getByTestId('remote-row-upstream')).toHaveCount(0);
    await expect(page.getByTestId('remote-row-origin')).toBeVisible();
  });

  test('a duplicate name is rejected in the form, before it reaches the host', async ({ page }) => {
    await open(page, 'remotes', /Manage Remotes/);
    await page.getByRole('button', { name: 'Add remote' }).click();
    await page.getByTestId('remote-name').fill('origin');
    await page.getByTestId('remote-fetch').fill('https://host/other.git');
    await expect(page.getByTestId('remote-errors')).toContainText('already exists');
    await expect(page.getByTestId('remote-save')).toBeDisabled();

    const saves = (await posted(page)).filter((m) => m.method === 'remotesDialog/save');
    expect(saves).toHaveLength(0);
  });

  test('an illegal remote name is refused with git’s own rule', async ({ page }) => {
    await open(page, 'remotes', /Manage Remotes/);
    await page.getByRole('button', { name: 'Add remote' }).click();
    await page.getByTestId('remote-name').fill('has space');
    await page.getByTestId('remote-fetch').fill('https://host/x.git');
    await expect(page.getByTestId('remote-errors')).toContainText('spaces or slashes');
  });
});
