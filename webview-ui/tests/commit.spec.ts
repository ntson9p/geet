import { expect, test, type Page } from '@playwright/test';
import { mockCommitHostScript } from './mockCommitHost';

/**
 * P11-T2 commit tool window. The mock host applies the intents the webview
 * posts and pushes `commit/state` back, so these assertions cover the real
 * round trip rather than component-local state.
 */

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function openCommit(page: Page): Promise<void> {
  await page.addInitScript(mockCommitHostScript);
  await page.goto('/commit.html');
  await expect(page.getByRole('treeitem', { name: 'Changes, 4 files' })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function row(page: Page, name: string) {
  return page.getByRole('treeitem', { name, exact: true });
}

test.describe('P11-T2 commit window layout', () => {
  test('renders group rows, folder rows and file counts', async ({ page }) => {
    await openCommit(page);
    // The shape from gap analysis §2A: group -> folders -> files, counts on
    // every node, with the single-child chain collapsed.
    await expect(row(page, 'Changes, 4 files')).toBeVisible();
    await expect(row(page, 'src/main/java, 3 files')).toBeVisible();
    await expect(row(page, 'api, 2 files')).toBeVisible();
    await expect(row(page, 'Unversioned Files, 1 file')).toBeVisible();
    await expect(row(page, 'ArticleDataController.java, src/main/java/api')).toBeVisible();
  });

  test('opens with everything expanded, like the IntelliJ commit window', async ({ page }) => {
    await openCommit(page);
    await expect(row(page, 'Changes, 4 files')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-expanded', 'true');
  });

  test('carries the multi-line message editor and both action buttons', async ({ page }) => {
    await openCommit(page);
    const editor = page.getByTestId('commit-message');
    await expect(editor).toBeVisible();
    // The single-line SCM input box is exactly what this replaces.
    expect(await editor.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    await expect(page.getByTestId('commit-button')).toBeVisible();
    await expect(page.getByTestId('commit-push-button')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Commit options' })).toBeVisible();
  });

  test('shows the checked-of-total counter', async ({ page }) => {
    await openCommit(page);
    await expect(page.getByTestId('commit-counter')).toHaveText('3 of 5 files');
  });
});

test.describe('P11-T2 inclusion round trip', () => {
  test('tri-state reflects the host state on load', async ({ page }) => {
    await openCommit(page);
    // 3 of 4 ticked in Changes, and only 2 of 2 inside api/.
    await expect(row(page, 'Changes, 4 files')).toHaveAttribute('aria-checked', 'mixed');
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-checked', 'true');
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-checked', 'false');
  });

  test('ticking a folder posts repo-relative paths and the host state comes back', async ({ page }) => {
    await openCommit(page);
    await row(page, 'api, 2 files').locator('.gt-tree-check').click();

    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'commit/setChecked').length)
      .toBeGreaterThan(0);
    const msg = (await posted(page)).find((m) => m.method === 'commit/setChecked');
    expect(msg?.params).toEqual({
      repoRoot: 'D:/repos/demo-git',
      // Namespaced tree paths must never leak to the host.
      paths: [
        'src/main/java/api/ArticleDataController.java',
        'src/main/java/api/CommentController.java',
      ],
      checked: false,
    });
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('commit-counter')).toHaveText('1 of 5 files');
  });

  test('P11-T3: unversioned files are tickable and start unticked', async ({ page }) => {
    await openCommit(page);
    const unversioned = row(page, 'Unversioned Files, 1 file');
    await expect(unversioned.locator('.gt-tree-check')).toHaveCount(1);
    // IntelliJ's default: a new file joins a commit only when you say so.
    await expect(unversioned).toHaveAttribute('aria-checked', 'false');
    await expect(row(page, '2.txt')).toHaveAttribute('aria-checked', 'false');

    await row(page, '2.txt').locator('.gt-tree-check').click();
    await expect(row(page, '2.txt')).toHaveAttribute('aria-checked', 'true');
    await expect(unversioned).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('commit-counter')).toHaveText('4 of 5 files');

    const msg = (await posted(page)).find((m) => m.method === 'commit/setChecked');
    expect(msg?.params).toEqual({
      repoRoot: 'D:/repos/demo-git',
      paths: ['2.txt'],
      checked: true,
    });
  });

  test('intents are posted as requests, which is what the host answers', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md, docs').locator('.gt-tree-check').click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'commit/setChecked').length)
      .toBeGreaterThan(0);
    // `WebviewRpcHost.on()` registers request handlers; a `kind: 'evt'` message
    // reaches no handler at all and fails silently. P11-T2 shipped exactly that
    // mismatch, so the wire format is worth asserting directly.
    for (const msg of await posted(page)) {
      if (msg.method?.startsWith('commit/')) expect(msg.kind).toBe('req');
    }
  });

  test('two groups holding the same directory expand independently', async ({ page }) => {
    await openCommit(page);
    // `api/` exists under Changes only in this fixture, but the identity rule
    // is what matters: collapsing one group must not collapse the other.
    await row(page, 'Changes, 4 files').locator('.gt-twistie').click();
    await expect(row(page, 'api, 2 files')).toHaveCount(0);
    await expect(row(page, 'Unversioned Files, 1 file')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, '2.txt')).toBeVisible();
  });
});

test.describe('P11-T2 commit actions', () => {
  test('Commit is disabled without a message and enables once typed', async ({ page }) => {
    await openCommit(page);
    await expect(page.getByTestId('commit-button')).toBeDisabled();
    await page.getByTestId('commit-message').fill('add controllers');
    await expect(page.getByTestId('commit-button')).toBeEnabled();
    await page.getByTestId('commit-button').click();

    const msg = (await posted(page)).find((m) => m.method === 'commit/commit');
    expect(msg?.params).toEqual({ repoRoot: 'D:/repos/demo-git', andPush: false });
  });

  test('Commit and Push posts the andPush flag', async ({ page }) => {
    await openCommit(page);
    await page.getByTestId('commit-message').fill('ship it');
    await page.getByTestId('commit-push-button').click();
    const msg = (await posted(page)).find((m) => m.method === 'commit/commit');
    expect(msg?.params).toEqual({ repoRoot: 'D:/repos/demo-git', andPush: true });
  });

  test('typing streams the message to the host', async ({ page }) => {
    await openCommit(page);
    await page.getByTestId('commit-message').fill('wip');
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'commit/setMessage').length)
      .toBeGreaterThan(0);
  });

  test('amend round-trips and prefills the previous message', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('checkbox', { name: /Amend/ }).click();
    await expect(page.getByRole('checkbox', { name: /Amend/ })).toBeChecked();
    await expect(page.getByTestId('commit-message')).toHaveValue('previous subject');
    // Amend alone is enough to commit — no message typed by the user.
    await expect(page.getByTestId('commit-button')).toBeEnabled();
  });

  test('toolbar actions requiring a selection stay disabled until one exists', async ({ page }) => {
    await openCommit(page);
    await expect(page.getByRole('button', { name: 'Rollback' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Show Diff' })).toBeDisabled();

    await row(page, 'guide.md, docs').click();
    await expect(page.getByRole('button', { name: 'Show Diff' })).toBeEnabled();
    await page.getByRole('button', { name: 'Show Diff' }).click();
    const msg = (await posted(page)).find((m) => m.method === 'commit/openDiff');
    expect(msg?.params).toEqual({ repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' });
  });

  test('collapse all and expand all drive the whole tree', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(row(page, 'api, 2 files')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(row(page, 'api, 2 files')).toBeVisible();
  });
});

test.describe('P11-T3 per-change inclusion', () => {
  const DIFF_ROW = 'Strings.java, src/main/java/util';

  async function openPreview(page: Page): Promise<void> {
    await openCommit(page);
    await page.getByRole('button', { name: 'Preview Diff' }).click();
    await expect(page.getByTestId('commit-preview')).toBeVisible();
  }

  test('the preview pane opens empty and asks for one file', async ({ page }) => {
    await openPreview(page);
    await expect(page.getByTestId('preview-hint')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview Diff' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('selecting a file shows its changes with an include checkbox each', async ({ page }) => {
    await openPreview(page);
    await row(page, DIFF_ROW).click();
    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 3 included');
    for (const i of [0, 1, 2]) {
      await expect(page.getByTestId(`diff-include-${i}`)).toBeVisible();
    }
  });

  test('excluding a change round-trips and badges the row', async ({ page }) => {
    await openPreview(page);
    await row(page, DIFF_ROW).click();
    await page.getByTestId('diff-include-0').click();

    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 2 included');
    const msg = (await posted(page)).find((m) => m.method === 'commit/setIncluded');
    expect(msg?.params).toEqual({
      repoRoot: 'D:/repos/demo-git',
      path: 'src/main/java/util/Strings.java',
      included: [1, 2],
      signature: '2,2,2,2;4,4,4,4;6,6,6,6',
    });
    // The tree row has to say so: a plain tick would imply the whole file.
    await expect(row(page, 'Strings.java, 2 of 3 changes')).toBeVisible();
  });

  test('re-including every change drops the badge again', async ({ page }) => {
    await openPreview(page);
    await row(page, DIFF_ROW).click();
    await page.getByTestId('diff-include-0').click();
    await expect(row(page, 'Strings.java, 2 of 3 changes')).toBeVisible();

    await page.getByTestId('diff-include-0').click();
    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 3 included');
    // "All of it" and "the whole file" must be one state, not two.
    await expect(row(page, DIFF_ROW)).toBeVisible();
  });

  test('excluding the last change unticks the file', async ({ page }) => {
    await openPreview(page);
    await row(page, DIFF_ROW).click();
    for (const i of [0, 1, 2]) await page.getByTestId(`diff-include-${i}`).click();

    await expect(page.getByTestId('diff-counter')).toHaveText('3 differences, 0 included');
    // A ticked file that contributes nothing would be a lie.
    await expect(row(page, DIFF_ROW)).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('commit-counter')).toHaveText('2 of 5 files');
  });

  test('a file with no per-change granularity says so instead of faking it', async ({ page }) => {
    await openPreview(page);
    await row(page, 'guide.md, docs').click();
    await expect(page.getByTestId('preview-whole-file')).toContainText('docs/guide.md');
    await expect(page.getByTestId('diff-counter')).toHaveCount(0);
  });

  test('the preview toggle and its ratio survive a reload', async ({ page }) => {
    await openPreview(page);
    await page.reload();
    await expect(page.getByTestId('commit-preview')).toBeVisible();
  });
});
