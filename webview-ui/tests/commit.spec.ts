import { expect, test, type Locator, type Page } from '@playwright/test';
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
    await expect(row(page, 'ArticleDataController.java')).toBeVisible();
  });

  test('P14-T2: group and file rows carry the native context-menu identity', async ({ page }) => {
    await openCommit(page);
    // The changelists tree view was the only home for rename/delete/setActive;
    // once it goes, this context is what keeps them reachable by right-click.
    const ctxOf = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse((await row(page, name).getAttribute('data-vscode-context')) ?? '{}') as Record<
        string,
        unknown
      >;

    const group = await ctxOf('Changes, 4 files');
    expect(group['webviewSection']).toBe('commitGroup');
    expect(group['repoRoot']).toBe('D:/repos/demo-git');
    expect(group['listId']).toBe('default');
    expect(group['listIsDefault']).toBe(true);
    // A single-root workspace has no repository rows, so this row still stands
    // for exactly one repository and every scoped action applies to it as-is.
    expect(group['listSpansRepos']).toBe(false);
    expect(group['targets']).toEqual([{ repoRoot: 'D:/repos/demo-git', listId: 'default' }]);

    const unversioned = await ctxOf('Unversioned Files, 1 file');
    expect(unversioned['listId']).toBe('__unversioned__');
    expect(unversioned['listIsDefault']).toBe(false);
    // POST-P14bf: no changelist, so Add to VCS and Move rather than a list's actions.
    expect(unversioned['listIsUnversioned']).toBe(true);
    expect(group['listIsUnversioned']).toBe(false);

    const file = await ctxOf('ArticleDataController.java');
    expect(file['webviewSection']).toBe('commitFile');
    expect(file['repoRoot']).toBe('D:/repos/demo-git');
    expect(file['relPath']).toBe('src/main/java/api/ArticleDataController.java');
    // A file row must not offer changelist-level actions.
    expect(file['listId']).toBeUndefined();

    // POST-P14bf: a folder row stands for its files, as IntelliJ's folder node
    // does; until then it carried nothing and VS Code offered Cut, Copy, Paste.
    expect(await ctxOf('api, 2 files')).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitFolder',
      repoRoot: 'D:/repos/demo-git',
      relPath: 'src/main/java/api/ArticleDataController.java',
      relPaths: ['src/main/java/api/ArticleDataController.java', 'src/main/java/api/CommentController.java'],
      folder: 'src/main/java/api',
      fileUnversioned: false,
      folderHasUnversioned: false,
    });
  });

  test("POST-P14bf: a folder row's menu acts on the files under it", async ({ page }) => {
    await openCommit(page);
    const ctxOf = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse((await row(page, name).getAttribute('data-vscode-context')) ?? '{}') as Record<
        string,
        unknown
      >;
    // A collapsed chain names its whole path, and covers every file beneath it.
    const chain = await ctxOf('src/main/java, 3 files');
    expect(chain['folder']).toBe('src/main/java');
    expect(chain['relPaths']).toEqual([
      'src/main/java/api/ArticleDataController.java',
      'src/main/java/api/CommentController.java',
      'src/main/java/util/Strings.java',
    ]);
    // A right-click selects the folder, as a click does, and the menu carries it.
    await row(page, 'util, 1 file').click({ button: 'right' });
    await expect(row(page, 'util, 1 file')).toHaveAttribute('aria-selected', 'true');
    expect((await ctxOf('util, 1 file'))['relPaths']).toEqual(['src/main/java/util/Strings.java']);
    // Inside a multi-selection it carries the whole selection, as a file row does.
    await row(page, 'api, 2 files').click();
    await row(page, 'guide.md').click({ modifiers: ['Control'] });
    expect((await ctxOf('api, 2 files'))['relPaths']).toEqual([
      'docs/guide.md',
      'src/main/java/api/ArticleDataController.java',
      'src/main/java/api/CommentController.java',
    ]);
  });

  test('POST-P14v: a Ctrl-clicked selection travels in the file row context', async ({ page }) => {
    await openCommit(page);
    const ctxOf = async (name: string): Promise<Record<string, unknown>> =>
      JSON.parse((await row(page, name).getAttribute('data-vscode-context')) ?? '{}') as Record<
        string,
        unknown
      >;
    const first = 'ArticleDataController.java';
    const second = 'CommentController.java';

    await row(page, first).click();
    await row(page, second).click({ modifiers: ['Control'] });
    const many = await ctxOf(first);
    // What "Add to VCS on several files" rests on: VS Code reads this attribute
    // during the contextmenu event, so it has to be right before the click.
    expect(many['relPaths']).toEqual([
      'src/main/java/api/ArticleDataController.java',
      'src/main/java/api/CommentController.java',
    ]);
    expect(many['relPath']).toBe('src/main/java/api/ArticleDataController.java');
    expect(many['fileUnversioned']).toBe(false);

    // A right-click outside the selection acts on the row under the cursor
    // only — and moves the selection there, as IntelliJ's tree does.
    await row(page, 'guide.md').click({ button: 'right' });
    expect((await ctxOf('guide.md'))['relPaths']).toEqual(['docs/guide.md']);
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, first)).toHaveAttribute('aria-selected', 'false');

    // The unversioned row is the one that may offer Add to VCS.
    expect((await ctxOf('2.txt'))['fileUnversioned']).toBe(true);
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
    // POST-P14ca: Commit and Push… is in the ▾ joined to it.
    await expect(page.getByTestId('commit-more-button')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Commit options' })).toBeVisible();
    // A single-root workspace has nothing to disambiguate, so the button stays
    // the plain verb — the repo name belongs there only when there are several.
    await expect(page.getByTestId('commit-button')).toHaveText('Commit');
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
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-checked', 'false');
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
    await row(page, 'guide.md').locator('.gt-tree-check').click();
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
    // POST-P14ca: it lives in the ▾ joined to the Commit button.
    await page.getByTestId('commit-more-button').click();
    const menu = page.getByRole('menu', { name: 'More Commit Actions' });
    await menu.getByRole('menuitem', { name: /Commit and Push/ }).click();
    const msg = (await posted(page)).find((m) => m.method === 'commit/commit');
    expect(msg?.params).toEqual({ repoRoot: 'D:/repos/demo-git', andPush: true });
  });

  test('POST-P14ca: the ▾ also commits, and names the commit key', async ({ page }) => {
    await openCommit(page);
    await page.getByTestId('commit-message').fill('ship it');
    await page.getByTestId('commit-more-button').click();
    const menu = page.getByRole('menu', { name: 'More Commit Actions' });
    const plain = menu.getByRole('menuitem', { name: /^Commit\b/ }).first();
    await expect(plain).toContainText(/Ctrl\+Enter|⌘Enter/);
    await plain.click();
    await expect(menu).toHaveCount(0);
    const msg = (await posted(page)).find((m) => m.method === 'commit/commit');
    expect(msg?.params).toEqual({ repoRoot: 'D:/repos/demo-git', andPush: false });
  });

  test('POST-P14ca: with nothing to commit, the ▾ is disabled along with Commit', async ({ page }) => {
    await openCommit(page);
    await expect(page.getByTestId('commit-button')).toBeDisabled();
    await expect(page.getByTestId('commit-more-button')).toBeDisabled();
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

    await row(page, 'guide.md').click();
    await expect(page.getByRole('button', { name: 'Show Diff' })).toBeEnabled();
    await page.getByRole('button', { name: 'Show Diff' }).click();
    const msg = (await posted(page)).find((m) => m.method === 'commit/openDiff');
    const repoRoot = 'D:/repos/demo-git';
    expect(msg?.params).toEqual({
      repoRoot,
      path: 'docs/guide.md',
      // The whole list as the tree shows it, Unversioned Files last.
      files: [
        { repoRoot, path: 'docs/guide.md' },
        { repoRoot, path: 'src/main/java/api/ArticleDataController.java' },
        { repoRoot, path: 'src/main/java/api/CommentController.java' },
        { repoRoot, path: 'src/main/java/util/Strings.java' },
        { repoRoot, path: '2.txt' },
      ],
    });
  });

  test('with several files selected, Show Diff walks only those', async ({ page }) => {
    await openCommit(page);
    await row(page, '2.txt').click();
    await row(page, 'guide.md').click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Show Diff' }).click();
    await expect
      .poll(async () => {
        const msg = (await posted(page)).filter((m) => m.method === 'commit/openDiff').at(-1);
        return msg?.params;
      })
      .toEqual({
        repoRoot: 'D:/repos/demo-git',
        // The first of them as the tree shows them, not the one clicked first.
        path: 'docs/guide.md',
        files: [
          { repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' },
          { repoRoot: 'D:/repos/demo-git', path: '2.txt' },
        ],
      });
  });

  test('Show Diff on a folder row starts from its first file', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('treeitem', { name: /^docs/ }).click();
    await page.getByRole('button', { name: 'Show Diff' }).click();
    await expect
      .poll(async () => {
        const msg = (await posted(page)).filter((m) => m.method === 'commit/openDiff').at(-1);
        return (msg?.params as { path?: string } | undefined)?.path;
      })
      .toBe('docs/guide.md');
  });

  const postEvent = (page: Page, method: string, params: unknown) =>
    page.evaluate(
      ({ method, params }) => window.postMessage({ v: 1, id: `evt-${method}`, kind: 'evt', method, params }, '*'),
      { method, params },
    );

  test('the row follows a diff that moved on, without opening it again', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').dblclick();
    const opens = (await posted(page)).filter((m) => m.method === 'commit/openDiff').length;

    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await expect(row(page, '2.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-selected', 'false');
    expect((await posted(page)).filter((m) => m.method === 'commit/openDiff').length).toBe(opens);
  });

  test('a walk over several selected rows leaves them selected', async ({ page }) => {
    await openCommit(page);
    await row(page, '2.txt').click();
    await row(page, 'guide.md').click({ modifiers: ['Control'] });
    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await page.waitForTimeout(100);
    await expect(row(page, '2.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-selected', 'true');
  });

  test("a walk takes the keyboard's row along", async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').dblclick();
    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await expect(row(page, '2.txt')).toHaveClass(/gt-focused/);
    await expect(row(page, 'guide.md')).not.toHaveClass(/gt-focused/);
  });

  test('the file a diff is showing is highlighted, and only while it is', async ({ page }) => {
    await openCommit(page);
    const marked = page.locator('[role="treeitem"][aria-current="true"]');
    await postEvent(page, 'commit/diffOnScreen', { file: { repoRoot: 'D:/repos/demo-git', path: '2.txt' } });
    await expect(row(page, '2.txt')).toHaveAttribute('aria-current', 'true');
    await expect(marked).toHaveCount(1);
    // Marked, not selected: a walk over several rows leaves the selection as it was.
    await expect(row(page, '2.txt')).toHaveAttribute('aria-selected', 'false');

    // A file of another repository is not this row.
    await postEvent(page, 'commit/diffOnScreen', { file: { repoRoot: 'D:/repos/other', path: '2.txt' } });
    await expect(marked).toHaveCount(0);

    await postEvent(page, 'commit/diffOnScreen', { file: { repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' } });
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-current', 'true');
    await postEvent(page, 'commit/diffOnScreen', {});
    await expect(marked).toHaveCount(0);
  });

  test('a state that names the file on screen marks it, for a view started again', async ({ page }) => {
    await openCommit(page);
    await postEvent(page, 'commit/state', {
      repos: [
        {
          root: 'D:/repos/demo-git',
          label: 'demo-git',
          groups: [
            {
              id: 'default',
              name: 'Changes',
              isActive: true,
              isDefault: true,
              checkable: true,
              changes: [{ path: 'docs/guide.md', code: '.M', kind: 'modified', checked: true }],
            },
          ],
        },
      ],
      targets: [],
      message: '',
      amend: false,
      signing: false,
      busy: false,
      modifiedCount: 1,
      checkedCount: 1,
      paradigm: 'changelists',
      // IntelliJ's tree, where the mock starts: without these a state is the flat list.
      groupBy: 'changelist',
      groupByDirectory: true,
      diffOnScreen: { repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' },
    });
    await expect(row(page, 'guide.md')).toHaveAttribute('aria-current', 'true');
  });

  test('Enter on the row the arrows reached selects it as the diff opens it', async ({ page }) => {
    await openCommit(page);
    const first = row(page, 'ArticleDataController.java');
    const next = row(page, 'CommentController.java');
    await first.click();
    await page.keyboard.press('ArrowDown');
    await expect(next).toHaveClass(/gt-focused/);
    await expect(next).toHaveAttribute('aria-selected', 'false');

    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const msg = (await posted(page)).filter((m) => m.method === 'commit/openDiff').at(-1);
        return (msg?.params as { path?: string } | undefined)?.path;
      })
      .toBe('src/main/java/api/CommentController.java');
    await expect(next).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('aria-selected', 'false');
  });

  test("a row's menu opens through the same walk", async ({ page }) => {
    await openCommit(page);
    await postEvent(page, 'commit/openDiffAt', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await expect
      .poll(async () => {
        const msg = (await posted(page)).filter((m) => m.method === 'commit/openDiff').at(-1);
        return (msg?.params as { path?: string; files?: unknown[] } | undefined)?.files?.length;
      })
      .toBe(5);
  });

  /** The host's next state: one file left in the list, the way a rollback or a commit leaves it. */
  const listShrinks = (page: Page) =>
    postEvent(page, 'commit/state', {
      repos: [
        {
          root: 'D:/repos/demo-git',
          label: 'demo-git',
          groups: [
            {
              id: 'default',
              name: 'Changes',
              isActive: true,
              isDefault: true,
              checkable: true,
              changes: [{ path: 'docs/guide.md', code: '.M', kind: 'modified', checked: true }],
            },
          ],
        },
      ],
      targets: [],
      message: '',
      amend: false,
      signing: false,
      busy: false,
      modifiedCount: 1,
      checkedCount: 1,
      paradigm: 'changelists',
      // IntelliJ's tree, where the mock starts: without these a state is the flat list.
      groupBy: 'changelist',
      groupByDirectory: true,
    });
  const chains = async (page: Page): Promise<PostedMsg[]> =>
    (await posted(page)).filter((m) => m.method === 'commit/diffChain');

  test('a walk over the whole list hears when the list changes', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').dblclick();
    await listShrinks(page);
    await expect.poll(async () => (await chains(page)).at(-1)?.params).toEqual({
      files: [{ repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' }],
    });
  });

  test('with no walk open, the host is not told about the list', async ({ page }) => {
    await openCommit(page);
    await listShrinks(page);
    await expect(page.getByRole('treeitem', { name: 'Changes, 1 file' })).toBeVisible();
    expect(await chains(page)).toEqual([]);
  });

  test('a walk over a selection stays what was selected', async ({ page }) => {
    await openCommit(page);
    await row(page, '2.txt').click();
    await row(page, 'guide.md').click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Show Diff' }).click();
    await listShrinks(page);
    await expect(page.getByRole('treeitem', { name: 'Changes, 1 file' })).toBeVisible();
    expect(await chains(page)).toEqual([]);
  });

  test('collapse all and expand all drive the whole tree', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(row(page, 'api, 2 files')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(row(page, 'api, 2 files')).toBeVisible();
  });
});

test.describe('P11-T4 message editor', () => {
  function editor(page: Page) {
    return page.getByTestId('commit-message');
  }
  async function setMessages(page: Page): Promise<PostedMsg[]> {
    return (await posted(page)).filter((m) => m.method === 'commit/setMessage');
  }

  test('persist is debounced: five keystrokes, one setMessage', async ({ page }) => {
    await openCommit(page);
    await editor(page).pressSequentially('hello', { delay: 10 });
    await expect.poll(async () => (await setMessages(page)).length).toBe(1);
    expect((await setMessages(page))[0]?.params?.['message']).toBe('hello');
    // And it stays one — the debounce fired exactly once for the burst.
    await page.waitForTimeout(350);
    expect((await setMessages(page)).length).toBe(1);
  });

  test('nothing round-trips mid-IME-composition; compositionend catches up', async ({ page }) => {
    await openCommit(page);
    await editor(page).click();
    await editor(page).evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (el as HTMLTextAreaElement).value = 'にほ';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    expect((await setMessages(page)).length).toBe(0);

    // Chromium fires the final `input` before `compositionend`; both orders
    // must land the composed text exactly once.
    await editor(page).evaluate((el) => {
      (el as HTMLTextAreaElement).value = '日本';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await expect.poll(async () => (await setMessages(page)).length).toBe(1);
    expect((await setMessages(page))[0]?.params?.['message']).toBe('日本');
    await expect(editor(page)).toHaveValue('日本');
  });

  test('a history pick is undoable back to the typed draft', async ({ page }) => {
    await openCommit(page);
    await editor(page).click();
    await editor(page).pressSequentially('draft', { delay: 5 });
    await page.getByRole('button', { name: 'Commit message history' }).click();
    await page.getByRole('menuitem', { name: /fix: adjust retry backoff/ }).click();
    await expect(editor(page)).toHaveValue('fix: adjust retry backoff\n\nDoubles the base delay.');
    // The programmatic insert landed *on* the undo stack — master §6's
    // "undo quirks" objection, answered.
    await editor(page).press('Control+z');
    await expect(editor(page)).toHaveValue('draft');
  });

  test('history shows first line and relative time', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('button', { name: 'Commit message history' }).click();
    const item = page.getByRole('menuitem', { name: /fix: adjust retry backoff/ });
    await expect(item).toBeVisible();
    // Multi-line body must not leak into the label.
    await expect(item).not.toContainText('Doubles');
    await expect(item).toContainText('h ago');
  });

  test('the Amend ▾ dropdown inserts a recent commit message without toggling amend', async ({ page }) => {
    await openCommit(page);
    await page.getByRole('button', { name: 'Reuse a recent commit message' }).click();
    await page.getByRole('menuitem', { name: 'older subject' }).click();
    await expect(editor(page)).toHaveValue('older subject');
    await expect(page.getByRole('checkbox', { name: /Amend/ })).not.toBeChecked();
    // Undoable too, like every programmatic write.
    await editor(page).press('Control+z');
    await expect(editor(page)).toHaveValue('');
  });

  test('the subject-length hint appears past 72 characters and never blocks', async ({ page }) => {
    await openCommit(page);
    const long = 'x'.repeat(80);
    await editor(page).evaluate((el, text) => {
      (el as HTMLTextAreaElement).value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, long);
    await expect(page.getByTestId('subject-length')).toHaveText('80');
    await expect(page.getByTestId('commit-button')).toBeEnabled();

    await editor(page).evaluate((el) => {
      (el as HTMLTextAreaElement).value = 'short subject';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByTestId('subject-length')).toBeHidden();
  });

  test('a pending message is flushed before the commit intent', async ({ page }) => {
    await openCommit(page);
    await editor(page).pressSequentially('quick', { delay: 5 });
    // Click before the 250 ms debounce fires: the flush must still win.
    await page.getByTestId('commit-button').click();
    const all = await posted(page);
    const setIdx = all.findIndex(
      (m) => m.method === 'commit/setMessage' && m.params?.['message'] === 'quick',
    );
    const commitIdx = all.findIndex((m) => m.method === 'commit/commit');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(setIdx);
  });

  test('the message survives a webview reload', async ({ page }) => {
    await openCommit(page);
    await editor(page).pressSequentially('persisted message', { delay: 5 });
    await expect.poll(async () => (await setMessages(page)).length).toBeGreaterThan(0);
    await page.reload();
    await expect(editor(page)).toHaveValue('persisted message');
  });
});

test.describe('P11-T5 commit options gear popup', () => {
  async function openOptions(page: Page) {
    await openCommit(page);
    await page.getByRole('button', { name: 'Commit options' }).click();
    await expect(page.getByTestId('commit-options-popup')).toBeVisible();
  }
  async function setOptions(page: Page): Promise<PostedMsg[]> {
    return (await posted(page)).filter((m) => m.method === 'commit/setOption');
  }

  test('closes when its webview loses focus, as after a click elsewhere in VS Code', async ({ page }) => {
    // Such a click never reaches the webview's document; its window's blur does.
    await openOptions(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.getByTestId('commit-options-popup')).toHaveCount(0);
  });

  test('leaves the keyboard in the Author field when the window is redrawn', async ({ page }) => {
    // It took the keyboard back on every redraw of the window, mid-word.
    await openOptions(page);
    const input = page.getByTestId('opt-author');
    await input.click();
    await input.pressSequentially('Ada');
    // Any change of the window's state redraws it: here, a diff coming on screen.
    await page.evaluate(() =>
      window.postMessage(
        {
          v: 1,
          id: 'evt-redraw',
          kind: 'evt',
          method: 'commit/diffOnScreen',
          params: { file: { repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' } },
        },
        '*',
      ),
    );
    await page.waitForTimeout(100);
    await expect(input).toBeFocused();
    await input.pressSequentially(' L');
    await expect(input).toHaveValue('Ada L');
  });

  test('opens with the three sections; omitted rows are omitted, not inert', async ({ page }) => {
    await openOptions(page);
    const popup = page.getByTestId('commit-options-popup');
    await expect(popup).toContainText('Git');
    await expect(popup).toContainText('Commit Checks');
    await expect(popup).toContainText('Advanced Commit Checks');
    await expect(popup).toContainText('Failed checks will not prevent a commit');
    // Plan step 5: hidden rather than shown-inert.
    await expect(popup).not.toContainText('Rearrange');
    await expect(popup).not.toContainText('copyright');
    await expect(popup).not.toContainText('Run Configuration');
    await expect(popup).not.toContainText('Upload files');
  });

  test('author accepts Name <email>, posts it, and clears with ×', async ({ page }) => {
    await openOptions(page);
    const input = page.getByTestId('opt-author');
    await input.fill('Ada Lovelace <ada@example.com>');
    await input.press('Enter');
    await expect
      .poll(async () =>
        (await setOptions(page)).filter(
          (m) => (m.params?.['option'] as { kind?: string } | undefined)?.kind === 'author',
        ).length,
      )
      .toBe(1);

    // Host state holds it: close and reopen.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('commit-options-popup')).toHaveCount(0);
    await page.getByRole('button', { name: 'Commit options' }).click();
    await expect(page.getByTestId('opt-author')).toHaveValue('Ada Lovelace <ada@example.com>');

    await page.getByTestId('opt-author-clear').click();
    await expect(page.getByTestId('opt-author')).toHaveValue('');
    const authorPosts = (await setOptions(page)).filter(
      (m) => (m.params?.['option'] as { kind?: string } | undefined)?.kind === 'author',
    );
    expect((authorPosts.at(-1)?.params?.['option'] as { value?: string }).value).toBe('');
  });

  test('an invalid author shows the reason inline and posts nothing', async ({ page }) => {
    await openOptions(page);
    const input = page.getByTestId('opt-author');
    await input.fill('not an author');
    await input.press('Enter');
    await expect(page.getByTestId('opt-author-error')).toBeVisible();
    const authorPosts = (await setOptions(page)).filter(
      (m) => (m.params?.['option'] as { kind?: string } | undefined)?.kind === 'author',
    );
    expect(authorPosts.length).toBe(0);
  });

  test('sign-off and deferred-checks toggles round-trip', async ({ page }) => {
    await openOptions(page);
    await page.getByTestId('opt-signoff').click();
    await expect
      .poll(async () =>
        (await setOptions(page)).some((m) => {
          const o = m.params?.['option'] as { kind?: string; value?: boolean } | undefined;
          return o?.kind === 'signoff' && o.value === true;
        }),
      )
      .toBe(true);

    // Defer starts unticked (POST-P14bv; IntelliJ's §2A reference shows it ticked);
    // ticking it posts true, and unticking it again posts false.
    await expect(page.getByTestId('opt-defer')).not.toBeChecked();
    await page.getByTestId('opt-defer').click();
    await expect(page.getByTestId('opt-defer')).toBeChecked();
    await expect
      .poll(async () =>
        (await setOptions(page)).some((m) => {
          const o = m.params?.['option'] as { kind?: string; value?: boolean } | undefined;
          return o?.kind === 'deferAdvanced' && o.value === true;
        }),
      )
      .toBe(true);
    await page.getByTestId('opt-defer').click();
    await expect(page.getByTestId('opt-defer')).not.toBeChecked();
    await expect
      .poll(async () =>
        (await setOptions(page)).some((m) => {
          const o = m.params?.['option'] as { kind?: string; value?: boolean } | undefined;
          return o?.kind === 'deferAdvanced' && o.value === false;
        }),
      )
      .toBe(true);
  });

  test('every check starts unticked, and the fields beside them greyed', async ({ page }) => {
    // POST-P14bg (D38): IntelliJ ticks Analyze code and Check TODO; GitTree ticks none.
    await openOptions(page);
    for (const id of ['reformat', 'optimizeImports', 'cleanup', 'analyze', 'todo']) {
      await expect(page.getByTestId(`opt-${id}`), id).not.toBeChecked();
    }
    await expect(page.getByTestId('opt-cleanup-kind')).toBeDisabled();
    await expect(page.getByTestId('opt-analyze-severity')).toBeDisabled();
    await expect(page.getByTestId('opt-todo-pattern')).toBeDisabled();
    // Whether ticked checks run before or after the commit is not a check, and
    // starts unticked too (POST-P14bv): a ticked check runs before the commit.
    await expect(page.getByTestId('opt-defer')).not.toBeChecked();
  });

  test('ticking Check TODO posts it and frees its pattern', async ({ page }) => {
    await openOptions(page);
    await page.getByTestId('opt-todo').click();
    await expect(page.getByTestId('opt-todo')).toBeChecked();
    await expect(page.getByTestId('opt-todo-pattern')).toBeEnabled();
    await expect
      .poll(async () =>
        (await setOptions(page)).some((m) => {
          const o = m.params?.['option'] as { kind?: string; id?: string; value?: boolean } | undefined;
          return o?.kind === 'check' && o.id === 'todo' && o.value === true;
        }),
      )
      .toBe(true);
  });

  test('severity and profile controls follow their check toggles', async ({ page }) => {
    await openOptions(page);
    // Analyze and cleanup start off → severity and profile disabled.
    await expect(page.getByTestId('opt-analyze-severity')).toBeDisabled();
    await expect(page.getByTestId('opt-cleanup-kind')).toBeDisabled();

    await page.getByTestId('opt-analyze').click();
    await expect(page.getByTestId('opt-analyze-severity')).toBeEnabled();
    await page.getByTestId('opt-analyze-severity').selectOption('warning');
    await expect
      .poll(async () =>
        (await setOptions(page)).some((m) => {
          const o = m.params?.['option'] as { kind?: string; value?: string } | undefined;
          return o?.kind === 'analyzeSeverity' && o.value === 'warning';
        }),
      )
      .toBe(true);

    await page.getByTestId('opt-cleanup').click();
    await expect(page.getByTestId('opt-cleanup-kind')).toBeEnabled();
  });

  test('Escape closes the popup and the gear reads unpressed', async ({ page }) => {
    await openOptions(page);
    await expect(page.getByRole('button', { name: 'Commit options' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('commit-options-popup')).toHaveCount(0);
  });
});

test.describe('P11-T8 status colors and directory highlighting', () => {
  test('a gittree.colors override colors icon and name; theme rows keep their variable', async ({ page }) => {
    await openCommit(page);
    // The mock ships { modified: '#ff8800' } — the override must win…
    await expect(row(page, 'guide.md').locator('.gt-tree-name')).toHaveCSS(
      'color',
      'rgb(255, 136, 0)',
    );
    // …while untracked stays on GitTree's own theme colour.
    const untrackedStyle = await row(page, '2.txt')
      .locator('.gt-tree-name')
      .getAttribute('style');
    expect(untrackedStyle).toContain('gittree-color-untracked');
  });

  test('a theme color reaches a name under the name VS Code gives it in a webview', async ({ page }) => {
    await openCommit(page);
    // As VS Code's webview sets it: only the first dot of `gittree.color.untracked` replaced.
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--vscode-gittree-color.untracked', 'rgb(1, 2, 3)'),
    );
    await expect(row(page, '2.txt').locator('.gt-tree-name')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(row(page, '2.txt').locator('.gt-tree-icon')).toHaveCSS('color', 'rgb(1, 2, 3)');
  });

  test('a directory of mixed statuses reads as modified (IntelliJ)', async ({ page }) => {
    await openCommit(page);
    // api/ holds one modified + one added file → mixed → the modified override.
    await expect(row(page, 'api, 2 files').locator('.gt-tree-name')).toHaveCSS(
      'color',
      'rgb(255, 136, 0)',
    );
    // Its folder icon carries the same status color.
    await expect(row(page, 'api, 2 files').locator('.gt-tree-icon')).toHaveCSS(
      'color',
      'rgb(255, 136, 0)',
    );
  });

  test('a single-status directory wears that status color', async ({ page }) => {
    await openCommit(page);
    // docs/ holds only guide.md (modified) → the modified override, and the
    // Unversioned group root holds only untracked → the untracked variable.
    const unversionedStyle = await row(page, 'Unversioned Files, 1 file')
      .locator('.gt-tree-name')
      .getAttribute('style');
    expect(unversionedStyle).toContain('gittree-color-untracked');
  });
});

test.describe('repository rows wear their repository colour', () => {
  // A repository row's name ends with its branch, which its label hover says.
  const LIB = 'demo-lib, 1 file, Branch feature/login';
  const GIT_CHANGES = 'demo-git, 4 files, Branch main, tracking origin/main';
  const GIT_UNVERSIONED = 'demo-git, 1 file, Branch main, tracking origin/main';

  /** Two repositories, so the tree has repository rows; `palette` is gittree.log.graphPalette. */
  async function openTwoRepos(page: Page, palette?: 'colorBlind'): Promise<void> {
    await page.addInitScript((p) => {
      const w = window as unknown as { __mockSecondRepo?: boolean; __mockGraphPalette?: string };
      w.__mockSecondRepo = true;
      if (p !== null) w.__mockGraphPalette = p;
    }, palette ?? null);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(row(page, 'Changes, 5 files')).toBeVisible();
  }

  /** What the browser computes for a CSS colour, so an hsl() can be compared with a computed style. */
  async function computed(page: Page, color: string): Promise<string> {
    return page.evaluate((c) => {
      const probe = document.createElement('span');
      probe.style.color = c;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, color);
  }

  test("a repository row wears its colour, not its files' status", async ({ page }) => {
    await openTwoRepos(page);
    // Under Changes and under Unversioned Files alike: the second repository's
    // slot (1), the log's lane colour in a dark theme, whatever is beneath it.
    const lib = await computed(page, 'hsl(30 65% 65%)');
    const git = await computed(page, 'hsl(210 65% 65%)');
    const libRows = row(page, LIB);
    await expect(libRows).toHaveCount(2);
    for (const r of await libRows.all()) {
      // A filled square, as IntelliJ draws a root: no glyph, its colour filled in.
      const icon = r.locator('.gt-tree-icon');
      await expect(icon).toHaveClass(/gt-tree-swatch/);
      await expect(icon).not.toHaveClass(/codicon/);
      await expect(icon).toHaveCSS('color', lib);
      expect(await icon.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).toBe(lib);
    }
    await expect(row(page, GIT_CHANGES).locator('.gt-tree-icon')).toHaveCSS('color', git);
    await expect(row(page, GIT_UNVERSIONED).locator('.gt-tree-icon')).toHaveCSS('color', git);
    // The name is plain, as IntelliJ's: an all-untracked repository is not green.
    for (const r of await libRows.all()) {
      expect(await r.locator('.gt-tree-name').getAttribute('style')).toBeNull();
    }
    // Its files keep their status colours.
    const untrackedStyle = await row(page, 'Unversioned Files, 2 files')
      .locator('.gt-tree-name')
      .getAttribute('style');
    expect(untrackedStyle).toContain('gittree-color-untracked');
  });

  test("a repository's colour follows the theme", async ({ page }) => {
    await openTwoRepos(page);
    await page.evaluate(() => (document.body.className = 'vscode-light'));
    const light = await computed(page, 'hsl(30 70% 40%)');
    await expect(row(page, LIB).first().locator('.gt-tree-icon')).toHaveCSS('color', light);
  });

  test("a repository's colour follows the color-blind palette", async ({ page }) => {
    await openTwoRepos(page, 'colorBlind');
    // Okabe–Ito, dark: slot 0 sky blue, slot 1 yellow.
    await expect(row(page, GIT_CHANGES).locator('.gt-tree-icon')).toHaveCSS(
      'color',
      'rgb(86, 180, 233)',
    );
    await expect(row(page, LIB).first().locator('.gt-tree-icon')).toHaveCSS(
      'color',
      'rgb(245, 195, 66)',
    );
  });

  test('a lone repository has no repository row, and its folders keep their status colours', async ({ page }) => {
    await openCommit(page);
    await expect(page.locator('.gt-tree-swatch')).toHaveCount(0);
    await expect(row(page, 'api, 2 files').locator('.gt-tree-icon')).toHaveClass(/codicon-folder/);
  });
});

test.describe('View Options › Group By (D37)', () => {
  // Repository › Changelist: a repository row's name ends with its branch.
  const GIT = 'demo-git, 5 files, Branch main, tracking origin/main';
  const LIB = 'demo-lib, 2 files, Branch feature/login';
  // Changelist › Repository: demo-lib's row under Changes.
  const LIB_UNDER_CHANGES = 'demo-lib, 1 file, Branch feature/login';

  /** Two repositories, so there is a grouping to choose; `groupBy` is the setting it starts from. */
  async function openGrouped(page: Page, groupBy: 'changelist' | 'repository' = 'changelist'): Promise<void> {
    await page.addInitScript((g) => {
      const w = window as unknown as { __mockSecondRepo?: boolean; __mockGroupBy?: string };
      w.__mockSecondRepo = true;
      w.__mockGroupBy = g;
    }, groupBy);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(groupBy === 'repository' ? row(page, GIT) : row(page, 'Changes, 5 files')).toBeVisible();
  }

  const viewOptions = (page: Page) => page.getByRole('button', { name: 'View Options' });
  const level = (page: Page, n: number) => page.locator(`[role="treeitem"][aria-level="${n}"]`);

  async function pick(page: Page, label: string): Promise<void> {
    await viewOptions(page).click();
    await page.getByRole('menuitemradio', { name: label }).click();
  }

  function contextOf(raw: string | null): Record<string, unknown> {
    return JSON.parse(raw ?? '{}') as Record<string, unknown>;
  }

  test('is offered with one repository too, for Changelist and Directory (POST-P14cb)', async ({ page }) => {
    await openCommit(page);
    await viewOptions(page).click();
    const menu = page.getByRole('menu', { name: 'View Options' });
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Changelist' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Directory' })).toHaveAttribute('aria-checked', 'true');
    // One repository has no order of changelists and repositories to choose.
    await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
    await expect(page.locator('.gt-tree-swatch')).toHaveCount(0);
  });

  test('offers both groupings, the one shown ticked', async ({ page }) => {
    await openGrouped(page);
    await viewOptions(page).click();
    const menu = page.getByRole('menu', { name: 'View Options' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.gt-menu-header')).toHaveText(['Group By', 'With Changelists']);
    const byList = page.getByRole('menuitemradio', { name: 'Changelist › Repository' });
    const byRepo = page.getByRole('menuitemradio', { name: 'Repository › Changelist' });
    await expect(byList).toHaveAttribute('aria-checked', 'true');
    await expect(byRepo).toHaveAttribute('aria-checked', 'false');
    // The keyboard starts on the first choice (POST-P14cb).
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Changelist' })).toHaveClass(/gt-active/);
    // IntelliJ's dot: with changelists shown the view is not the default one (POST-P14cb).
    await expect(viewOptions(page).locator('.gt-toolbar-badge')).toHaveCount(1);
  });

  test('Repository › Changelist asks the host to save it, and puts repositories first', async ({ page }) => {
    await openGrouped(page);
    await pick(page, 'Repository › Changelist');
    await expect(row(page, GIT)).toBeVisible();
    const sent = (await posted(page)).filter((m) => m.method === 'commit/setGroupBy');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('req');
    expect(sent[0]?.params).toEqual({ groupBy: 'repository' });
    // Repositories in the order the host gives (by name), each with its own
    // lists beneath in IntelliJ's order.
    await expect(level(page, 1)).toHaveCount(2);
    await expect(level(page, 1).nth(0)).toHaveAttribute('aria-label', GIT);
    await expect(level(page, 1).nth(1)).toHaveAttribute('aria-label', LIB);
    await expect(level(page, 2)).toHaveCount(4);
    await expect(level(page, 2).nth(0)).toHaveAttribute('aria-label', 'Changes, 4 files');
    await expect(level(page, 2).nth(1)).toHaveAttribute('aria-label', 'Unversioned Files, 1 file');
    await expect(level(page, 2).nth(2)).toHaveAttribute('aria-label', 'Changes, 1 file');
    await expect(level(page, 2).nth(3)).toHaveAttribute('aria-label', 'Unversioned Files, 1 file');
    await expect(viewOptions(page).locator('.gt-toolbar-badge')).toHaveCount(1);
  });

  test('picking the grouping already shown sends nothing', async ({ page }) => {
    await openGrouped(page);
    await pick(page, 'Changelist › Repository');
    await expect(page.getByRole('menu', { name: 'View Options' })).toHaveCount(0);
    expect((await posted(page)).some((m) => m.method === 'commit/setGroupBy')).toBe(false);
  });

  test('a repository row: its colour, its name plain, its branch, its own menu', async ({ page }) => {
    await openGrouped(page, 'repository');
    const lib = row(page, LIB);
    await expect(lib.locator('.gt-tree-icon')).toHaveClass(/gt-tree-swatch/);
    expect(await lib.locator('.gt-tree-name').getAttribute('style')).toBeNull();
    await expect(lib.locator('.gt-tree-desc')).toHaveText('2 files');
    await expect(lib.locator('.gt-tree-badge')).toHaveText('feature/login');
    await expect(lib.locator('.gt-tree-badge')).toHaveAttribute('title', 'Branch feature/login');
    expect(contextOf(await lib.getAttribute('data-vscode-context'))).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitRepository',
      repoRoot: 'D:/repos/demo-lib',
      repoHasTracked: true,
      // lib/notes.txt is new: Add to VCS is on offer.
      repoHasUnversioned: true,
      // POST-P14ce: every repository listed.
      repoShownAlone: false,
    });
    // A list under it is that repository's copy of the list: a folder, and the
    // menu a repository row under a list has in the other grouping.
    const list = level(page, 2).nth(2);
    await expect(list).toHaveAttribute('aria-label', 'Changes, 1 file');
    await expect(list.locator('.gt-tree-icon')).toHaveClass(/codicon-folder/);
    await expect(list.locator('.gt-tree-badge')).toHaveCount(0);
    const listCtx = contextOf(await list.getAttribute('data-vscode-context'));
    expect(listCtx['webviewSection']).toBe('commitRepo');
    expect(listCtx['repoRoot']).toBe('D:/repos/demo-lib');
    expect(listCtx['listId']).toBe('default');
  });

  test('the branch is on the repository rows under a list too', async ({ page }) => {
    await openGrouped(page);
    const git = row(page, 'demo-git, 4 files, Branch main, tracking origin/main');
    await expect(git.locator('.gt-tree-badge')).toHaveText('main');
    await expect(git.locator('.gt-tree-badge')).toHaveAttribute('title', 'Branch main, tracking origin/main');
    await expect(row(page, 'Changes, 5 files').locator('.gt-tree-badge')).toHaveCount(0);
  });

  test('ticking a repository ticks every change of it, its new files too', async ({ page }) => {
    await openGrouped(page, 'repository');
    await expect(row(page, GIT)).toHaveAttribute('aria-checked', 'mixed');
    await row(page, GIT).locator('.gt-tree-check').click();
    await expect(row(page, GIT)).toHaveAttribute('aria-checked', 'true');
    const sent = (await posted(page)).filter((m) => m.method === 'commit/setChecked');
    const last = sent[sent.length - 1]?.params as { repoRoot: string; paths: string[]; checked: boolean };
    expect(last.repoRoot).toBe('D:/repos/demo-git');
    expect(last.checked).toBe(true);
    expect([...last.paths].sort()).toEqual(
      [
        '2.txt',
        'docs/guide.md',
        'src/main/java/api/ArticleDataController.java',
        'src/main/java/api/CommentController.java',
        'src/main/java/util/Strings.java',
      ].sort(),
    );
  });

  test('a switch keeps the same file selected, and the keyboard on it', async ({ page }) => {
    await openGrouped(page);
    const strings = row(page, 'Strings.java');
    await strings.click();
    await pick(page, 'Repository › Changelist');
    await expect(row(page, GIT)).toBeVisible();
    await expect(strings).toHaveAttribute('aria-selected', 'true');
    await expect(strings).toHaveAttribute('tabindex', '0');
    await pick(page, 'Changelist › Repository');
    await expect(row(page, 'Changes, 5 files')).toBeVisible();
    await expect(strings).toHaveAttribute('aria-selected', 'true');
    await expect(strings).toHaveAttribute('tabindex', '0');
  });

  test("one repository's copy of a list is the same row either way", async ({ page }) => {
    await openGrouped(page);
    await row(page, LIB_UNDER_CHANGES).first().click();
    await pick(page, 'Repository › Changelist');
    await expect(row(page, LIB)).toBeVisible();
    await expect(level(page, 2).nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
  });

  test('a scrolled tree keeps the selected row where it was on screen', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 440 });
    await openGrouped(page, 'repository');
    const list = page.getByRole('tree', { name: 'Changes' });
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const notes = row(page, 'notes.txt');
    await notes.click();
    const offset = () =>
      notes.evaluate((el) => {
        const tree = el.closest('[role="tree"]');
        return tree ? Math.round(el.getBoundingClientRect().top - tree.getBoundingClientRect().top) : NaN;
      });
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const before = await offset();
    await pick(page, 'Changelist › Repository');
    await expect(notes).toHaveAttribute('aria-selected', 'true');
    await expect(notes).toHaveAttribute('tabindex', '0');
    expect(await offset()).toBe(before);
  });

  test('each grouping keeps its own rows open or shut', async ({ page }) => {
    await openGrouped(page, 'repository');
    await row(page, LIB).locator('.gt-twistie').click();
    await expect(row(page, LIB)).toHaveAttribute('aria-expanded', 'false');
    await pick(page, 'Changelist › Repository');
    // Shown for the first time, every row of it open.
    await expect(row(page, LIB_UNDER_CHANGES).first()).toHaveAttribute('aria-expanded', 'true');
    await pick(page, 'Repository › Changelist');
    await expect(row(page, LIB)).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, GIT)).toHaveAttribute('aria-expanded', 'true');
  });

  test('opens every row the first time it is shown', async ({ page }) => {
    await openGrouped(page, 'repository');
    const rows = page.locator('[role="treeitem"][aria-expanded]');
    expect(await rows.count()).toBeGreaterThan(4);
    for (const r of await rows.all()) await expect(r).toHaveAttribute('aria-expanded', 'true');
  });

  test('Collapse all shuts this grouping and leaves the other as it was', async ({ page }) => {
    await openGrouped(page);
    await pick(page, 'Repository › Changelist');
    await expect(row(page, GIT)).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(row(page, GIT)).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, LIB)).toHaveAttribute('aria-expanded', 'false');
    await pick(page, 'Changelist › Repository');
    await expect(row(page, 'Changes, 5 files')).toHaveAttribute('aria-expanded', 'true');
  });

  test('a repository row that appears later appears open', async ({ page }) => {
    await openCommit(page);
    await page.evaluate(() => {
      (window as unknown as { __mockSecondRepo?: boolean }).__mockSecondRepo = true;
    });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(row(page, LIB_UNDER_CHANGES).first()).toHaveAttribute('aria-expanded', 'true');
  });
});

test.describe('the keyboard row follows its row', () => {
  test('a folder folding above it leaves the keyboard where it was', async ({ page }) => {
    await openCommit(page);
    const strings = row(page, 'Strings.java');
    await strings.click();
    await expect(strings).toHaveAttribute('tabindex', '0');
    await row(page, 'api, 2 files').locator('.gt-twistie').click();
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-expanded', 'false');
    await expect(strings).toHaveAttribute('tabindex', '0');
  });

  test('folded away, its folder takes the keyboard', async ({ page }) => {
    await openCommit(page);
    await row(page, 'Strings.java').click();
    await row(page, 'util, 1 file').locator('.gt-twistie').click();
    await expect(row(page, 'util, 1 file')).toHaveAttribute('tabindex', '0');
  });
});

test.describe('P11-T6 shelf tab', () => {
  async function openShelf(page: Page): Promise<void> {
    await openCommit(page);
    await page.getByRole('tab', { name: 'Shelf' }).click();
    await expect(page.getByTestId('shelf-tab')).toBeVisible();
  }

  test('the Commit | Shelf strip exists and the tab lists entries with files', async ({ page }) => {
    await openShelf(page);
    const entry = page.getByRole('treeitem', { name: /feature work/ });
    await expect(entry).toBeVisible();
    await expect(entry).toContainText('2 files');
    await expect(entry).toContainText('from main');
    // Applied-but-kept entries hide until the eye toggle.
    await expect(page.getByRole('treeitem', { name: /applied earlier/ })).toHaveCount(0);

    // Expanding shows the patch's files with status and binary flags.
    await entry.locator('.gt-twistie').click();
    await expect(page.getByRole('treeitem', { name: /alpha\.ts/ })).toContainText('modified');
    await expect(page.getByRole('treeitem', { name: /logo\.png/ })).toContainText('binary');
  });

  test('a tampered entry renders damaged inline, not as a modal', async ({ page }) => {
    await openShelf(page);
    const damaged = page.getByRole('treeitem', { name: /tampered entry/ });
    await expect(damaged).toBeVisible();
    await expect(damaged).toContainText('damaged');
    await expect(damaged.locator('.codicon-warning')).toHaveCount(1);
  });

  test('the eye toggle reveals already-unshelved entries', async ({ page }) => {
    await openShelf(page);
    await page.getByRole('button', { name: 'Show already unshelved' }).click();
    const applied = page.getByRole('treeitem', { name: /applied earlier/ });
    await expect(applied).toBeVisible();
    await expect(applied).toContainText('unshelved');
    await page.getByRole('button', { name: 'Show already unshelved' }).click();
    await expect(page.getByRole('treeitem', { name: /applied earlier/ })).toHaveCount(0);
  });

  test('toolbar actions dispatch shelfAction with the entry identity', async ({ page }) => {
    await openShelf(page);
    await expect(page.getByRole('button', { name: 'Unshelve…' })).toBeDisabled();
    await page.getByRole('treeitem', { name: /feature work/ }).click();
    await expect(page.getByRole('button', { name: 'Unshelve…' })).toBeEnabled();

    await page.getByRole('button', { name: 'Unshelve Silently' }).click();
    await expect
      .poll(async () =>
        (await posted(page)).filter((m) => m.method === 'commit/shelfAction').length,
      )
      .toBeGreaterThan(0);
    const msg = (await posted(page)).find((m) => m.method === 'commit/shelfAction');
    expect(msg?.kind).toBe('req');
    expect(msg?.params).toEqual({
      action: 'unshelveSilently',
      repoRoot: 'D:/repos/demo-git',
      id: 'shelf-1',
    });
    // The mock applies it: the entry leaves the list, like a real unshelve.
    await expect(page.getByRole('treeitem', { name: /feature work/ })).toHaveCount(0);
  });

  test('shelf rows carry the native context-menu identity', async ({ page }) => {
    await openShelf(page);
    const entry = page.getByRole('treeitem', { name: /feature work/ });
    const ctx = JSON.parse((await entry.getAttribute('data-vscode-context')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(ctx['webviewSection']).toBe('shelfEntry');
    expect(ctx['shelfId']).toBe('shelf-1');
    expect(ctx['repoRoot']).toBe('D:/repos/demo-git');

    await entry.locator('.gt-twistie').click();
    const file = page.getByRole('treeitem', { name: /alpha\.ts/ });
    const fileCtx = JSON.parse((await file.getAttribute('data-vscode-context')) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(fileCtx['webviewSection']).toBe('shelfFile');
    expect(fileCtx['relPath']).toBe('src/alpha.ts');
  });

  test('activating a file row asks the host for the shelved diff', async ({ page }) => {
    await openShelf(page);
    await page.getByRole('treeitem', { name: /feature work/ }).locator('.gt-twistie').click();
    await page.getByRole('treeitem', { name: /alpha\.ts/ }).dblclick();
    await expect
      .poll(async () =>
        (await posted(page)).some((m) => {
          const p = m.params as { action?: string; relPath?: string } | undefined;
          return m.method === 'commit/shelfAction' && p?.action === 'openDiff' && p.relPath === 'src/alpha.ts';
        }),
      )
      .toBe(true);
  });

  test('a refused action surfaces in the error banner instead of vanishing', async ({ page }) => {
    await openShelf(page);
    await page.getByRole('treeitem', { name: /tampered entry/ }).click();
    await page.getByRole('button', { name: 'Unshelve Silently' }).click();
    await expect(page.getByTestId('commit-error')).toContainText('sha256');
  });
});

test.describe('P11-T3 per-change inclusion', () => {
  const DIFF_ROW = 'Strings.java';

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
    await row(page, 'guide.md').click();
    await expect(page.getByTestId('preview-whole-file')).toContainText('docs/guide.md');
    await expect(page.getByTestId('diff-counter')).toHaveCount(0);
  });

  test('the preview toggle and its ratio survive a reload', async ({ page }) => {
    await openPreview(page);
    await page.reload();
    await expect(page.getByTestId('commit-preview')).toBeVisible();
  });
});

test.describe('POST-P14l stash tab', () => {
  async function openStash(page: Page): Promise<void> {
    await openCommit(page);
    await page.getByRole('tab', { name: 'Stash', exact: true }).click();
    await expect(page.getByTestId('stash-tab')).toBeVisible();
  }

  async function stashActions(page: Page): Promise<Array<Record<string, unknown>>> {
    return (await page.evaluate(
      () => (window as unknown as { __stashActions?: unknown[] }).__stashActions ?? [],
    )) as Array<Record<string, unknown>>;
  }

  test('Stash is the third tab, beside Shelf, and lists the stashes', async ({ page }) => {
    await openStash(page);
    // IntelliJ's default shape: Commit | Shelf | Stash, stashes in their own tab.
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('treeitem', { name: /stash@\{0\}/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /stash@\{1\}/ })).toBeVisible();
  });

  test('files are read on expand, not up front', async ({ page }) => {
    await openStash(page);
    // `git stash show` costs a run per stash, so nothing is fetched until a row
    // is opened.
    expect((await posted(page)).filter((m) => m.method === 'commit/stashFiles')).toHaveLength(0);

    await page.getByRole('treeitem', { name: /stash@\{0\}/ }).click();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('treeitem', { name: /retry\.ts/ })).toBeVisible();
    const asked = (await posted(page)).filter((m) => m.method === 'commit/stashFiles');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.params?.['sha']).toBe('aaaa1111'.repeat(5));
  });

  test('actions carry the sha, never stash@{N}', async ({ page }) => {
    await openStash(page);
    await page.getByRole('treeitem', { name: /stash@\{1\}/ }).click();
    await page.getByRole('button', { name: 'Pop Stash' }).click();
    const acts = await stashActions(page);
    expect(acts).toContainEqual({
      action: 'pop',
      repoRoot: 'D:/repos/demo-git',
      sha: 'bbbb2222'.repeat(5),
    });
    // The index would have been 1 here; identity is the sha precisely so that a
    // list that moved cannot redirect the action to another stash.
    expect(JSON.stringify(acts)).not.toContain('"index"');
  });

  test('row actions need a selection; Stash Changes and Clear never do', async ({ page }) => {
    await openStash(page);
    await expect(page.getByRole('button', { name: 'Pop Stash' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Drop Stash' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stash Changes…' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Clear Stashes' })).toBeEnabled();

    await page.getByRole('treeitem', { name: /stash@\{0\}/ }).click();
    await expect(page.getByRole('button', { name: 'Pop Stash' })).toBeEnabled();
  });

  test('a dropped stash leaves the list on the host event', async ({ page }) => {
    await openStash(page);
    await page.getByRole('treeitem', { name: /stash@\{0\}/ }).click();
    await page.getByRole('button', { name: 'Drop Stash' }).click();
    await expect(page.getByRole('treeitem', { name: /stash@\{0\}/ })).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: /stash@\{1\}/ })).toBeVisible();
  });

  test('Combine stashes and shelves folds the tab away', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockCombineStashes?: boolean }).__mockCombineStashes = true;
    });
    await openCommit(page);
    // IntelliJ's setting: one tab fewer, and the stashes render under the shelf.
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'Stash', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Shelf' }).click();
    await expect(page.getByTestId('shelf-tab')).toBeVisible();
    await expect(page.getByTestId('stash-tab')).toBeVisible();
  });
});

test.describe('Refresh shows it is working', () => {
  const refreshButton = (page: Page) => page.getByRole('button', { name: 'Refresh', exact: true });
  const refreshRequests = async (page: Page) =>
    (await posted(page)).filter((m) => m.kind === 'req' && m.method === 'commit/refresh').length;

  test('Refresh turns until the host has re-read, and a second click asks for nothing', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockHoldRefresh: boolean }).__mockHoldRefresh = true;
    });
    await openCommit(page);
    const refresh = refreshButton(page);
    await refresh.click();
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh.locator('.codicon-refresh')).toHaveClass(/gt-spin/);

    // Well past the minimum, the host still has not answered: still turning.
    await page.waitForTimeout(800);
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await refresh.click();
    expect(await refreshRequests(page)).toBe(1);

    await page.evaluate(() => (window as unknown as { __releaseRefresh: () => void }).__releaseRefresh());
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
    await expect(refresh.locator('.codicon-refresh')).not.toHaveClass(/gt-spin/);
    await refresh.click();
    await expect.poll(() => refreshRequests(page)).toBe(2);
  });

  test('a Refresh the host answers at once still visibly turns', async ({ page }) => {
    await openCommit(page);
    const refresh = refreshButton(page);
    // Watched every frame from the click: the mock answers in a few
    // milliseconds, yet the turning stays on screen for a while — not the one
    // frame (or none) that made the click look as if it did nothing.
    const busyForMs = await refresh.evaluate(async (el) => {
      const start = performance.now();
      (el as HTMLButtonElement).click();
      let lastBusy = start;
      while (performance.now() - start < 3000) {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        if (el.getAttribute('aria-busy') === 'true') lastBusy = performance.now();
        else if (lastBusy > start) break;
      }
      return lastBusy - start;
    });
    expect(busyForMs).toBeGreaterThanOrEqual(350);
    await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
  });
});

/**
 * POST-P14bq: Reveal in File Explorer (Reveal in Finder, Open Containing
 * Folder). The item itself is VS Code's native menu, so here: what a row tells
 * that menu, and the round trip VS Code's reveal key makes through the webview.
 */
test.describe('POST-P14bq reveal in the file manager', () => {
  const REPO = 'D:/repos/demo-git';

  const postEvent = (page: Page, method: string, params: unknown) =>
    page.evaluate(
      ({ method, params }) => window.postMessage({ v: 1, id: `evt-${method}`, kind: 'evt', method, params }, '*'),
      { method, params },
    );

  const ctxOf = async (page: Page, name: string): Promise<Record<string, unknown>> =>
    JSON.parse((await row(page, name).getAttribute('data-vscode-context')) ?? '{}') as Record<string, unknown>;

  const reveals = async (page: Page): Promise<unknown[]> =>
    (await posted(page)).filter((m) => m.method === 'commit/reveal').map((m) => m.params);

  test("a deleted file, and a folder of deleted files, tell the row's menu", async ({ page }) => {
    await openCommit(page);
    await postEvent(page, 'commit/state', {
      repos: [
        {
          root: REPO,
          label: 'demo-git',
          groups: [
            {
              id: 'default',
              name: 'Changes',
              isActive: true,
              isDefault: true,
              checkable: true,
              changes: [
                { path: 'old/x.ts', code: '.D', kind: 'deleted', checked: true },
                { path: 'old/y.ts', code: 'D.', kind: 'deleted', checked: true },
                { path: 'live/gone.ts', code: '.D', kind: 'deleted', checked: true },
                { path: 'live/kept.ts', code: '.M', kind: 'modified', checked: true },
              ],
            },
          ],
        },
      ],
      targets: [],
      message: '',
      amend: false,
      signing: false,
      busy: false,
      modifiedCount: 4,
      checkedCount: 4,
      paradigm: 'changelists',
      // IntelliJ's tree, where the mock starts: without these a state is the flat list.
      groupBy: 'changelist',
      groupByDirectory: true,
    });
    await expect(row(page, 'old, 2 files')).toBeVisible();
    // The menu leaves Reveal out on these: there is nothing on disk to select.
    expect((await ctxOf(page, 'gone.ts'))['fileDeleted']).toBe(true);
    expect((await ctxOf(page, 'old, 2 files'))['folderDeleted']).toBe(true);
    // One file left keeps the folder, and a present file is no deletion.
    expect((await ctxOf(page, 'live, 2 files'))['folderDeleted']).toBeUndefined();
    expect((await ctxOf(page, 'kept.ts'))['fileDeleted']).toBeUndefined();
  });

  test("a present file's row carries no deletion flag", async ({ page }) => {
    await openCommit(page);
    const ctx = await ctxOf(page, 'guide.md');
    expect(ctx['webviewSection']).toBe('commitFile');
    expect(ctx['fileDeleted']).toBeUndefined();
    expect((await ctxOf(page, 'api, 2 files'))['folderDeleted']).toBeUndefined();
  });

  test("the reveal key shows the keyboard's row: a file, then a folder", async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').click();
    await postEvent(page, 'commit/revealRow', {});
    await expect.poll(() => reveals(page)).toEqual([{ repoRoot: REPO, relPath: 'docs/guide.md' }]);

    await row(page, 'api, 2 files').click();
    await postEvent(page, 'commit/revealRow', {});
    await expect
      .poll(() => reveals(page))
      .toEqual([
        { repoRoot: REPO, relPath: 'docs/guide.md' },
        { repoRoot: REPO, folder: 'src/main/java/api' },
      ]);
    // Answered without an error banner: the host knows the request.
    await expect(page.getByTestId('commit-error')).toHaveCount(0);
  });

  test('the keyboard row is what counts, as for Enter: the arrows move it without selecting', async ({ page }) => {
    await openCommit(page);
    await row(page, 'ArticleDataController.java').click();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'CommentController.java')).toHaveClass(/gt-focused/);
    await postEvent(page, 'commit/revealRow', {});
    await expect
      .poll(() => reveals(page))
      .toEqual([{ repoRoot: REPO, relPath: 'src/main/java/api/CommentController.java' }]);
  });

  test('the reveal key shows nothing for a changelist row', async ({ page }) => {
    await openCommit(page);
    await row(page, 'Changes, 4 files').click();
    await postEvent(page, 'commit/revealRow', {});
    await page.waitForTimeout(150);
    expect(await reveals(page)).toEqual([]);
  });

  test('a late word from the host shows nothing once the tree has lost the keyboard', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').click();
    await page.getByTestId('commit-message').click();
    await postEvent(page, 'commit/revealRow', {});
    await page.waitForTimeout(150);
    expect(await reveals(page)).toEqual([]);
  });

  test('the tree says when it has the keyboard, which the reveal key is bound to', async ({ page }) => {
    await openCommit(page);
    const focusReports = async (): Promise<unknown[]> =>
      (await posted(page)).filter((m) => m.method === 'commit/treeFocus').map((m) => m.params);
    await row(page, 'guide.md').click();
    await expect.poll(focusReports).toEqual([{ focused: true }]);
    // Moving between rows is still the tree: nothing more to say.
    await page.keyboard.press('ArrowUp');
    await row(page, '2.txt').click();
    await page.getByTestId('commit-message').click();
    await expect.poll(focusReports).toEqual([{ focused: true }, { focused: false }]);
    await row(page, '2.txt').click();
    await page.getByRole('tab', { name: 'Shelf' }).click();
    await expect.poll(focusReports).toEqual([{ focused: true }, { focused: false }, { focused: true }, { focused: false }]);
    // A focus change is no intent: it never raises the failure banner.
    await expect(page.getByTestId('commit-error')).toHaveCount(0);
  });

  test('the reveal key shows nothing from the Shelf tab, where the tree is not on screen', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md').click();
    await page.getByRole('tab', { name: 'Shelf' }).click();
    await postEvent(page, 'commit/revealRow', {});
    await page.waitForTimeout(150);
    expect(await reveals(page)).toEqual([]);
  });

  test("a key pressed in the tree just before the host's ask still counts, though focus moved on", async ({
    page,
  }) => {
    // In VS Code, Alt can hand focus to the menu bar between the key and the ask.
    await openCommit(page);
    await row(page, 'guide.md').click();
    await page.keyboard.press('Shift');
    await page.getByTestId('commit-message').click();
    await postEvent(page, 'commit/revealRow', {});
    await expect.poll(() => reveals(page)).toEqual([{ repoRoot: REPO, relPath: 'docs/guide.md' }]);
  });

  test.describe('on Windows', () => {
    test.use({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.144.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36',
    });

    test('Shift+Alt+R in the tree shows the keyboard’s row itself, once', async ({ page }) => {
      // Passed on to VS Code, Alt+R would also open its Run menu.
      await openCommit(page);
      await row(page, 'guide.md').click();
      await page.keyboard.press('Shift+Alt+R');
      await expect.poll(() => reveals(page)).toEqual([{ repoRoot: REPO, relPath: 'docs/guide.md' }]);
      await page.waitForTimeout(150);
      expect(await reveals(page)).toHaveLength(1);
      // The row keeps the keyboard.
      await expect(row(page, 'guide.md')).toBeFocused();
    });

    test('Shift+Alt+R in the message box is not the tree’s', async ({ page }) => {
      await openCommit(page);
      await row(page, 'guide.md').click();
      await page.getByTestId('commit-message').click();
      await page.keyboard.press('Shift+Alt+R');
      await page.waitForTimeout(150);
      expect(await reveals(page)).toEqual([]);
    });
  });

  test.describe('on macOS and Linux', () => {
    test.use({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.144.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36',
    });

    test("Shift+Alt+R in the tree is left to VS Code, whose key there is another", async ({ page }) => {
      await openCommit(page);
      await row(page, 'guide.md').click();
      await page.keyboard.press('Shift+Alt+R');
      await page.waitForTimeout(150);
      expect(await reveals(page)).toEqual([]);
    });
  });
});

/**
 * POST-P14bs: Ctrl+Enter (⌘Enter on macOS) in the message box commits, as the
 * Commit button does. The key is VS Code's keybinding, resolved from the key
 * the webview passes on (while `gittree.commitMessageFocus`); the host then asks
 * the webview (`commit/commitKey`), which alone has the message as typed. Here:
 * what the box says and does with the key, and how the window answers the ask.
 */
test.describe('POST-P14bs Ctrl+Enter in the message box', () => {
  const REPO = 'D:/repos/demo-git';
  const WINDOWS_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.144.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36';
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.144.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36';
  // The key is Ctrl+Enter or ⌘Enter by the system: pinned, whichever runs the tests.
  test.use({ userAgent: WINDOWS_UA });

  interface HeardKey {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    defaultPrevented: boolean;
  }

  const postEvent = (page: Page, method: string, params: unknown) =>
    page.evaluate(
      ({ method, params }) => window.postMessage({ v: 1, id: `evt-${method}`, kind: 'evt', method, params }, '*'),
      { method, params },
    );
  const editor = (page: Page) => page.getByTestId('commit-message');
  const commits = async (page: Page): Promise<unknown[]> =>
    (await posted(page)).filter((m) => m.method === 'commit/commit').map((m) => m.params);
  const focusReports = async (page: Page): Promise<unknown[]> =>
    (await posted(page)).filter((m) => m.method === 'commit/messageFocus').map((m) => m.params);

  /** Hears keys as VS Code's webview script does: on the window, after the page's own listeners. */
  async function listenAsVsCode(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as { __heard: HeardKey[] };
      w.__heard = [];
      window.addEventListener('keydown', (e) => {
        w.__heard.push({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, defaultPrevented: e.defaultPrevented });
      });
    });
  }
  const heardEnters = (page: Page): Promise<HeardKey[]> =>
    page.evaluate(() => (window as unknown as { __heard: HeardKey[] }).__heard.filter((e) => e.key === 'Enter'));

  test('the box says when it has the keyboard, which the commit key is bound to', async ({ page }) => {
    await openCommit(page);
    await editor(page).click();
    await expect.poll(() => focusReports(page)).toEqual([{ focused: true }]);
    await row(page, 'guide.md').click();
    await expect.poll(() => focusReports(page)).toEqual([{ focused: true }, { focused: false }]);
    await editor(page).click();
    await page.getByRole('tab', { name: 'Shelf' }).click();
    await expect
      .poll(() => focusReports(page))
      .toEqual([{ focused: true }, { focused: false }, { focused: true }, { focused: false }]);
    // A focus change is no intent: it never raises the failure banner.
    await expect(page.getByTestId('commit-error')).toHaveCount(0);
  });

  test("the host's ask commits as the Commit button does: the message as typed goes first", async ({ page }) => {
    await openCommit(page);
    await editor(page).click();
    // Typed just now: the box has not sent it yet (its persist waits 250 ms).
    await editor(page).pressSequentially('add the key', { delay: 5 });
    await postEvent(page, 'commit/commitKey', {});
    await expect.poll(() => commits(page)).toEqual([{ repoRoot: REPO, andPush: false }]);
    const all = await posted(page);
    const setIdx = all.findIndex((m) => m.method === 'commit/setMessage' && m.params?.['message'] === 'add the key');
    const commitIdx = all.findIndex((m) => m.method === 'commit/commit');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(setIdx);
    // The box keeps the keyboard, as VS Code's Source Control box does.
    await expect(editor(page)).toBeFocused();
  });

  test('the ask commits nothing while the Commit button is disabled', async ({ page }) => {
    await openCommit(page);
    await editor(page).click();
    // No message yet.
    await expect(page.getByTestId('commit-button')).toBeDisabled();
    await postEvent(page, 'commit/commitKey', {});
    await page.waitForTimeout(150);
    expect(await commits(page)).toEqual([]);
  });

  test('a late ask that finds the keyboard elsewhere commits nothing', async ({ page }) => {
    await openCommit(page);
    await editor(page).fill('not yet');
    await row(page, 'guide.md').click();
    await postEvent(page, 'commit/commitKey', {});
    await page.waitForTimeout(150);
    expect(await commits(page)).toEqual([]);
  });

  test('Ctrl+Enter types no line break, and is still passed on to VS Code', async ({ page }) => {
    await openCommit(page);
    await listenAsVsCode(page);
    await editor(page).fill('subject');
    await page.keyboard.press('Control+Enter');
    await expect(editor(page)).toHaveValue('subject');
    // VS Code resolves its keybinding from the key it hears: cancelled, but heard.
    expect(await heardEnters(page)).toEqual([{ key: 'Enter', ctrlKey: true, metaKey: false, defaultPrevented: true }]);
    // Enter alone is still a new line.
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveValue('subject\n');
  });

  test('a held Ctrl+Enter is passed on once', async ({ page }) => {
    await openCommit(page);
    await listenAsVsCode(page);
    await editor(page).fill('subject');
    await page.keyboard.down('Control');
    await page.keyboard.down('Enter');
    // Pressed again while down: the key's repeats.
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Control');
    expect(await heardEnters(page)).toHaveLength(1);
    await expect(editor(page)).toHaveValue('subject');
  });

  test('while an IME is composing, the key and the ask wait for its text', async ({ page }) => {
    await openCommit(page);
    await listenAsVsCode(page);
    await editor(page).fill('fix: ');
    await editor(page).evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await page.keyboard.press('Control+Enter');
    // Held back from VS Code, which would commit without the composed text.
    expect(await heardEnters(page)).toEqual([]);
    await postEvent(page, 'commit/commitKey', {});
    await page.waitForTimeout(150);
    expect(await commits(page)).toEqual([]);

    await editor(page).evaluate((el) => {
      (el as HTMLTextAreaElement).value = 'fix: 日本';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.keyboard.press('Control+Enter');
    expect(await heardEnters(page)).toHaveLength(1);
    await postEvent(page, 'commit/commitKey', {});
    await expect.poll(() => commits(page)).toEqual([{ repoRoot: REPO, andPush: false }]);
    expect(
      (await posted(page)).some((m) => m.method === 'commit/setMessage' && m.params?.['message'] === 'fix: 日本'),
    ).toBe(true);
  });

  test.describe('on macOS', () => {
    test.use({ userAgent: MAC_UA });

    test('⌘Enter is the key there; Ctrl+Enter is left to the box', async ({ page }) => {
      await openCommit(page);
      await listenAsVsCode(page);
      await editor(page).fill('subject');
      await page.keyboard.press('Meta+Enter');
      await page.keyboard.press('Control+Enter');
      expect(await heardEnters(page)).toEqual([
        { key: 'Enter', ctrlKey: false, metaKey: true, defaultPrevented: true },
        { key: 'Enter', ctrlKey: true, metaKey: false, defaultPrevented: false },
      ]);
    });
  });
});

test.describe('POST-P14bu the borders a drag resizes are drawn', () => {
  const LINE = 'rgb(1, 2, 3)';

  async function openWithLine(page: Page): Promise<void> {
    await openCommit(page);
    // VS Code hands every webview the colour as this variable.
    await page.evaluate(
      (colour) => document.documentElement.style.setProperty('--vscode-gittree-sectionBorder', colour),
      LINE,
    );
  }

  const edgeOf = (page: Page) =>
    page.getByTestId('commit-edge').evaluate((el) => {
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        events: s.pointerEvents,
        hidden: el.getAttribute('aria-hidden'),
      };
    });

  test("a line runs along the window's foot, on VS Code's divider under the view, in every tab", async ({
    page,
  }) => {
    await openWithLine(page);
    const { width, height } = page.viewportSize()!;
    // 2px: VS Code can show the page up to a pixel short of its foot, and its
    // divider reaches 2px into the view, so the line stays on it whole or cut.
    expect(await edgeOf(page)).toEqual({
      top: height - 2,
      bottom: height,
      left: 0,
      right: width,
      border: `2px solid ${LINE}`,
      events: 'none',
      hidden: 'true',
    });
    for (const tab of ['Shelf', 'Stash', 'Commit']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect((await edgeOf(page)).bottom).toBe(height);
    }
  });

  test('the line takes no pointer, and the menus and popups draw over it', async ({ page }) => {
    await openWithLine(page);
    const { width, height } = page.viewportSize()!;
    // Whatever is under the line takes the pointer, never the line.
    const under = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.getAttribute('data-testid') ?? '(something else)',
      [width / 2, height - 1],
    );
    expect(under).not.toBe('commit-edge');

    const layer = (selector: string): Promise<number> =>
      page.locator(selector).first().evaluate((el) => Number(getComputedStyle(el).zIndex));
    const edge = await layer('[data-testid="commit-edge"]');
    await page.getByRole('button', { name: 'Commit message history' }).click();
    await expect(page.getByRole('menu', { name: 'Commit message history' })).toBeVisible();
    expect(await layer('.gt-menu')).toBeGreaterThan(edge);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Commit options' }).click();
    await expect(page.locator('.gt-options-popup')).toBeVisible();
    expect(await layer('.gt-options-popup')).toBeGreaterThan(edge);
  });

  test('the divider over the diff preview has a line along its middle until the pointer is on it', async ({
    page,
  }) => {
    await openWithLine(page);
    await page.getByRole('button', { name: 'Preview Diff' }).click();
    const divider = page.getByRole('separator', { name: 'Changes and diff preview' });
    const line = () =>
      divider.evaluate((el) => {
        const s = getComputedStyle(el, '::after');
        return {
          offset: parseFloat(s.top),
          height: el.getBoundingClientRect().height,
          border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
          events: s.pointerEvents,
        };
      });
    // The middle row of the 5px divider.
    expect(await line()).toEqual({ offset: 2, height: 5, border: `1px solid ${LINE}`, events: 'none' });

    // Under the pointer the whole divider lights, and the line makes way for it.
    await divider.hover();
    expect((await line()).border).toBe('1px solid rgba(0, 0, 0, 0)');

    // Grabbed on the line, it drags.
    const before = (await page.getByTestId('commit-preview').boundingBox())!.height;
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 2 - 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await page.getByTestId('commit-preview').boundingBox())!.height).toBeGreaterThan(
      before + 20,
    );
  });
});

test.describe('POST-P14ca a compact Commit tab', () => {
  const tools = (page: Page) => page.getByRole('toolbar', { name: 'Commit actions' });
  const divider = (page: Page) => page.getByRole('separator', { name: 'Resize the commit message' });
  const messageHeight = async (page: Page): Promise<number> =>
    (await page.getByTestId('commit-message').boundingBox())!.height;

  test("the toolbar shares the tabs' row, whole when there is room", async ({ page }) => {
    await openCommit(page);
    const tabs = (await page.getByRole('tablist', { name: 'Commit tool window' }).boundingBox())!;
    const strip = (await tools(page).boundingBox())!;
    // Side by side, on one row.
    expect(strip.x).toBeGreaterThanOrEqual(tabs.x + tabs.width - 1);
    expect(Math.abs(strip.y + strip.height / 2 - (tabs.y + tabs.height / 2))).toBeLessThan(4);
    await expect(tools(page).getByRole('button', { name: 'More Actions' })).toHaveCount(0);
    for (const name of ['Refresh', 'Rollback', 'Show Diff', 'Shelve Changes', 'Preview Diff', 'Expand all', 'Collapse all']) {
      await expect(tools(page).getByRole('button', { name })).toBeVisible();
    }
  });

  test('in a narrow window the rest folds into ⋯, from where each still runs', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 520 });
    await openCommit(page);
    await expect(tools(page).getByRole('button', { name: 'Refresh' })).toBeVisible();
    await expect(tools(page).getByRole('button', { name: 'Rollback' })).toBeVisible();
    await expect(tools(page).getByRole('button', { name: 'Preview Diff' })).toHaveCount(0);
    await tools(page).getByRole('button', { name: 'More Actions' }).click();
    const more = page.getByRole('menu', { name: 'More Actions' });
    // A toggle reads as one there, unticked while it is off.
    const previewItem = more.getByRole('menuitemcheckbox', { name: 'Preview Diff' });
    await expect(previewItem).toHaveAttribute('aria-checked', 'false');
    await expect(more.getByRole('menuitem', { name: 'Collapse all' })).toBeVisible();
    await previewItem.click();
    await expect(more).toHaveCount(0);
    await expect(page.getByTestId('commit-preview')).toBeVisible();
  });

  test('the message box starts at three lines and no longer grows as you type', async ({ page }) => {
    await openCommit(page);
    const box = page.getByTestId('commit-message');
    const start = await messageHeight(page);
    const line = await box.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(start).toBeGreaterThan(3 * line);
    expect(start).toBeLessThan(4 * line + 12);
    await box.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));
    expect(await messageHeight(page)).toBe(start);
    // It scrolls inside instead.
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });

  test('dragging the divider sizes the box, a double-click gives back its first height, and it is remembered', async ({
    page,
  }) => {
    await openCommit(page);
    const start = await messageHeight(page);
    const bar = (await divider(page).boundingBox())!;
    await page.mouse.move(bar.x + 60, bar.y + 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + 60, bar.y + 2 - 80, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => messageHeight(page)).toBeGreaterThan(start + 60);
    const dragged = await messageHeight(page);

    // Kept across a reload, as the window keeps its other sizes.
    await page.reload();
    await expect(row(page, 'Changes, 4 files')).toBeVisible();
    await expect.poll(() => messageHeight(page)).toBe(dragged);

    await divider(page).dblclick();
    await expect.poll(() => messageHeight(page)).toBe(start);
  });

  test('the arrows move the divider a line at a time; Up makes the box taller', async ({ page }) => {
    await openCommit(page);
    const start = await messageHeight(page);
    const line = await page
      .getByTestId('commit-message')
      .evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    await divider(page).focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => messageHeight(page)).toBeCloseTo(start + line, 0);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => messageHeight(page)).toBeCloseTo(start - line, 0);
    await page.keyboard.press('Enter');
    await expect.poll(() => messageHeight(page)).toBe(start);
  });

  test('the box never takes the list under three rows', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 420 });
    await openCommit(page);
    const bar = (await divider(page).boundingBox())!;
    await page.mouse.move(bar.x + 60, bar.y + 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + 60, 5, { steps: 8 });
    await page.mouse.up();
    const list = (await page.getByTestId('commit-tree').boundingBox())!;
    expect(list.height).toBeGreaterThanOrEqual(3 * 22 - 1);
  });

  test('a short window keeps the Commit button whole on screen, and nothing scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 250 });
    await openCommit(page);
    const button = (await page.getByTestId('commit-button').boundingBox())!;
    expect(button.y + button.height).toBeLessThanOrEqual(250);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeLessThanOrEqual(250);
    // The box gave way, but keeps a line.
    const line = await page
      .getByTestId('commit-message')
      .evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(await messageHeight(page)).toBeGreaterThanOrEqual(line);
  });

  test('the box gives its height back when the window grows again', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 700 });
    await openCommit(page);
    const start = await messageHeight(page);
    await page.setViewportSize({ width: 400, height: 230 });
    await expect.poll(() => messageHeight(page)).toBeLessThan(start);
    await page.setViewportSize({ width: 400, height: 700 });
    await expect.poll(() => messageHeight(page)).toBe(start);
  });

  test('the options popup opens clear of the gear', async ({ page }) => {
    await openCommit(page);
    const gear = page.getByRole('button', { name: 'Commit options' });
    await gear.click();
    const popup = page.getByTestId('commit-options-popup');
    await expect(popup).toBeVisible();
    const g = (await gear.boundingBox())!;
    const p = (await popup.boundingBox())!;
    const above = p.y + p.height <= g.y + 1;
    const below = p.y >= g.y + g.height - 1;
    expect(above || below).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });
});

test.describe('POST-P14cb the default: changes without changelist rows', () => {
  /** The mock as a real window starts: no changelist rows, no folder rows. */
  async function openPlain(page: Page, opts: { second?: boolean; directory?: boolean } = {}): Promise<void> {
    await page.addInitScript((o) => {
      const w = window as unknown as {
        __mockSecondRepo?: boolean;
        __mockGroupBy?: string;
        __mockGroupByDirectory?: boolean;
      };
      w.__mockGroupBy = 'none';
      w.__mockGroupByDirectory = o.directory === true;
      if (o.second === true) w.__mockSecondRepo = true;
    }, opts);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(page.getByRole('tree', { name: 'Changes' })).toBeVisible();
  }

  const viewOptions = (page: Page) => page.getByRole('button', { name: 'View Options' });
  const labels = (page: Page) =>
    page.locator('[role="treeitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color);

  test('one repository: every file at the top, in path order, each naming its folder and its status', async ({ page }) => {
    await openPlain(page);
    expect(await labels(page)).toEqual([
      '2.txt, Untracked',
      'guide.md, docs, Modified',
      'ArticleDataController.java, src/main/java/api, Modified',
      'CommentController.java, src/main/java/api, Added',
      'Strings.java, src/main/java/util, Modified',
    ]);
    await expect(page.locator('[role="treeitem"][aria-level="1"]')).toHaveCount(5);
  });

  test("each file's status letter keeps the row's end, in its status colour", async ({ page }) => {
    await openPlain(page);
    const guide = row(page, 'guide.md, docs, Modified');
    await expect(guide.locator('.gt-tree-letter')).toHaveText('M');
    await expect(guide.locator('.gt-tree-letter')).toHaveAttribute('title', 'Modified');
    // The mock's override for modified files wins, as on the name.
    expect(await colour(guide.locator('.gt-tree-letter'))).toBe('rgb(255, 136, 0)');
    expect(await colour(guide.locator('.gt-tree-name'))).toBe('rgb(255, 136, 0)');
    const box = (await guide.boundingBox())!;
    const letter = (await guide.locator('.gt-tree-letter').boundingBox())!;
    expect(box.x + box.width - (letter.x + letter.width)).toBeLessThan(16);
  });

  test('an untracked file looks like the added file it becomes, its name in italics with a U, and starts unticked', async ({
    page,
  }) => {
    await openPlain(page);
    const untracked = row(page, '2.txt, Untracked');
    const added = row(page, 'CommentController.java, src/main/java/api, Added');
    await expect(untracked.locator('.gt-tree-letter')).toHaveText('U');
    await expect(untracked.locator('.gt-tree-name')).toHaveClass(/gt-tree-name-italic/);
    await expect(untracked.locator('.gt-tree-icon')).toHaveClass(/codicon-diff-added/);
    await expect(added.locator('.gt-tree-icon')).toHaveClass(/codicon-diff-added/);
    await expect(added.locator('.gt-tree-name')).not.toHaveClass(/gt-tree-name-italic/);
    expect(await colour(untracked.locator('.gt-tree-letter'))).toBe(await colour(untracked.locator('.gt-tree-name')));
    await expect(untracked).toHaveAttribute('aria-checked', 'false');
    // Its box ticks it into the commit, as with changelists.
    await untracked.locator('.gt-tree-check').click();
    await expect(untracked).toHaveAttribute('aria-checked', 'true');
  });

  test('two repositories: a row each, its colour and branch, its files beneath, its own menu', async ({ page }) => {
    await openPlain(page, { second: true });
    const git = row(page, 'demo-git, 5 files, Branch main, tracking origin/main');
    const lib = row(page, 'demo-lib, 2 files, Branch feature/login');
    await expect(git).toHaveAttribute('aria-level', '1');
    await expect(lib).toHaveAttribute('aria-level', '1');
    await expect(lib.locator('.gt-tree-icon')).toHaveClass(/gt-tree-swatch/);
    await expect(row(page, 'notes.txt, lib, Untracked')).toHaveAttribute('aria-level', '2');
    expect(JSON.parse((await lib.getAttribute('data-vscode-context')) ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitRepository',
      repoRoot: 'D:/repos/demo-lib',
      repoHasTracked: true,
      repoHasUnversioned: true,
      // POST-P14ce: every repository listed.
      repoShownAlone: false,
    });
    // No changelist row anywhere.
    await expect(page.locator('[role="treeitem"][aria-label^="Changes,"]')).toHaveCount(0);
    await expect(page.locator('[role="treeitem"][aria-label^="Unversioned Files,"]')).toHaveCount(0);
  });

  test('the eye shows no dot at the defaults', async ({ page }) => {
    await openPlain(page);
    await expect(viewOptions(page).locator('.gt-toolbar-badge')).toHaveCount(0);
    await viewOptions(page).click();
    const menu = page.getByRole('menu', { name: 'View Options' });
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Changelist' })).toHaveAttribute('aria-checked', 'false');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Directory' })).toHaveAttribute('aria-checked', 'false');
  });

  test('Directory adds folder rows, and Changelist brings the changelist rows back', async ({ page }) => {
    await openPlain(page);
    await viewOptions(page).click();
    await page.getByRole('menuitemcheckbox', { name: 'Directory' }).click();
    await expect(row(page, 'src/main/java, 3 files')).toBeVisible();
    // The files keep their status: the letter is this grouping's, with or without folders.
    await expect(row(page, 'guide.md, Modified').locator('.gt-tree-letter')).toHaveText('M');

    await viewOptions(page).click();
    await page.getByRole('menuitemcheckbox', { name: 'Changelist' }).click();
    await expect(row(page, 'Changes, 4 files')).toBeVisible();
    // IntelliJ's look again: no letters.
    await expect(page.locator('.gt-tree-letter')).toHaveCount(0);

    const sent = (await posted(page)).filter((m) => m.method === 'commit/setGroupBy').map((m) => m.params);
    expect(sent).toEqual([{ directory: true }, { groupBy: 'changelist' }]);
  });

  test('a file selected stays selected when the folder rows come', async ({ page }) => {
    await openPlain(page);
    await row(page, 'Strings.java, src/main/java/util, Modified').click();
    await viewOptions(page).click();
    await page.getByRole('menuitemcheckbox', { name: 'Directory' }).click();
    await expect(row(page, 'Strings.java, Modified')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('POST-P14ce the list narrowed to the repositories picked in the Repositories panel', () => {
  const GIT = 'D:/repos/demo-git';
  const LIB = 'D:/repos/demo-lib';
  const DOCS = 'D:/repos/docs';

  /**
   * The mock's workspace of three — demo-git, demo-lib, and docs with nothing
   * to commit — narrowed to `picked` (null: none picked), without changelist
   * rows, as a real window starts.
   */
  async function openNarrowed(page: Page, picked: string | string[] | null): Promise<void> {
    await page.addInitScript((p) => {
      const w = window as unknown as { __mockFilter?: unknown; __mockGroupBy?: string; __mockGroupByDirectory?: boolean };
      w.__mockFilter = p;
      w.__mockGroupBy = 'none';
      w.__mockGroupByDirectory = false;
    }, picked);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(page.getByRole('tree', { name: 'Changes' }).or(page.getByTestId('commit-empty'))).toBeVisible();
  }

  const bar = (page: Page) => page.getByTestId('commit-filter');
  const sent = async (page: Page, method: string) =>
    (await posted(page)).filter((m) => m.method === method).map((m) => m.params);
  const narrow = (page: Page, roots: string[] | null) =>
    page.evaluate((r) => (window as unknown as { __mockNarrow(roots: string[] | null): void }).__mockNarrow(r), roots);

  test('a bar over the list names the repository shown, and warns of what is ticked out of view', async ({ page }) => {
    await openNarrowed(page, LIB);
    await expect(bar(page).getByTestId('commit-filter-repo')).toHaveText('demo-lib');
    // demo-git, left out, has five changes, three of them ticked; docs has none.
    const rest = page.getByTestId('commit-filter-rest');
    await expect(rest).toHaveText('· 3 ticked elsewhere');
    await expect(rest).toHaveClass(/gt-warn/);
    await expect(bar(page)).toHaveAttribute(
      'title',
      'Showing demo-lib only. Not shown: demo-git, 5 changes, 3 ticked; docs, no changes. ' +
        'Ticked changes out of view stay ticked, and are not committed until shown.',
    );
    await expect(bar(page)).toHaveAttribute('aria-label', 'Showing demo-lib only. 3 ticked elsewhere.');
    await expect(bar(page)).toHaveAttribute('role', 'group');
    // Above the list, under the tabs.
    const barBox = (await bar(page).boundingBox())!;
    const listBox = (await page.getByTestId('commit-tree').boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(listBox.y + 1);
  });

  test("the list keeps the repository's row and shows its changes alone; the counter counts them", async ({ page }) => {
    await openNarrowed(page, LIB);
    await expect(row(page, 'demo-lib, 2 files, Branch feature/login')).toHaveAttribute('aria-level', '1');
    await expect(row(page, 'notes.txt, lib, Untracked')).toHaveAttribute('aria-level', '2');
    await expect(page.locator('[role="treeitem"][aria-label^="demo-git"]')).toHaveCount(0);
    await expect(page.locator('[role="treeitem"][aria-label^="guide.md"]')).toHaveCount(0);
    await expect(page.getByTestId('commit-counter')).toHaveText('0 of 2 files');
    // Nothing ticked in it: nothing to commit, whatever is ticked elsewhere.
    await page.getByTestId('commit-message').fill('not yet');
    await expect(page.getByTestId('commit-button')).toBeDisabled();
  });

  test('Show all shows every repository again, and says so to the host, which tells the Repositories panel', async ({
    page,
  }) => {
    await openNarrowed(page, LIB);
    await bar(page).getByRole('button', { name: 'Show all repositories' }).click();
    expect(await sent(page, 'commit/showAllRepositories')).toHaveLength(1);
    await expect(bar(page)).toHaveCount(0);
    await expect(row(page, 'demo-git, 5 files, Branch main, tracking origin/main')).toBeVisible();
    await expect(row(page, 'demo-lib, 2 files, Branch feature/login')).toBeVisible();
  });

  test("a repository's name on the bar brings the Repositories panel up, on its row", async ({ page }) => {
    await openNarrowed(page, LIB);
    await bar(page).getByTestId('commit-filter-repo').click();
    expect(await sent(page, 'commit/revealRepository')).toEqual([{ root: LIB }]);
    // The pick stays as it is.
    await expect(bar(page)).toBeVisible();
  });

  test('Commit names where it goes and commits only the repositories shown', async ({ page }) => {
    await openNarrowed(page, GIT);
    await expect(page.getByTestId('commit-button')).toHaveText('Commit to demo-git');
    await expect(page.getByTestId('commit-counter')).toHaveText('3 of 5 files');
    await page.getByTestId('commit-message').fill('ship it');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => sent(page, 'commit/commit')).toEqual([{ repoRoot: GIT, andPush: false, roots: [GIT] }]);
  });

  test('every repository shown, Commit names none', async ({ page }) => {
    await openNarrowed(page, null);
    await expect(bar(page)).toHaveCount(0);
    await page.getByTestId('commit-message').fill('ship it');
    await page.getByTestId('commit-button').click();
    await expect.poll(() => sent(page, 'commit/commit')).toEqual([{ repoRoot: GIT, andPush: false }]);
  });

  test("Amend acts on the repository shown; its last message goes into the box on screen, the editor's", async ({
    page,
  }) => {
    await openNarrowed(page, LIB);
    const amend = page.locator('.gt-commit-amend-row .gt-checkbox');
    await expect(amend).toHaveAttribute('title', 'Amend the last commit of demo-lib');
    await amend.locator('input').click();
    expect(await sent(page, 'commit/toggleAmend')).toEqual([{ repoRoot: LIB, messageRepoRoot: GIT }]);
  });

  test('narrowed to a repository with nothing to commit, the list says so, beside the way to the rest', async ({
    page,
  }) => {
    await openNarrowed(page, DOCS);
    const empty = page.getByTestId('commit-empty');
    await expect(empty).toContainText('No changes in docs.');
    // demo-git's five and demo-lib's two.
    await expect(empty).toContainText('Show all repositories · 7 changes');
    await expect(page.getByTestId('commit-filter-rest')).toHaveText('· 3 ticked elsewhere');
    await page.getByTestId('commit-empty-show-all').click();
    expect(await sent(page, 'commit/showAllRepositories')).toHaveLength(1);
    await expect(empty).toHaveCount(0);
  });

  test('several names that do not fit are counted, and the count still brings the panel up', async ({ page }) => {
    await page.setViewportSize({ width: 200, height: 600 });
    await openNarrowed(page, [GIT, LIB]);
    const count = bar(page).getByTestId('commit-filter-count');
    await expect(count).toHaveText('2 of 3 repositories');
    await expect(bar(page).getByTestId('commit-filter-repo')).toHaveCount(0);
    await expect(bar(page).getByRole('button', { name: 'Show all repositories' })).toBeVisible();
    await count.click();
    expect(await sent(page, 'commit/revealRepository')).toEqual([{ root: GIT }]);
    // With room, the names.
    await page.setViewportSize({ width: 600, height: 600 });
    await expect(bar(page).getByTestId('commit-filter-repo')).toHaveText(['demo-git', 'demo-lib']);
    await expect(count).toHaveCount(0);
  });

  test('the one name stays a name in a narrow side bar, cut short if it must be, and Show all stays whole', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 160, height: 600 });
    await openNarrowed(page, LIB);
    await expect(bar(page).getByTestId('commit-filter-repo')).toBeVisible();
    await expect(bar(page).getByTestId('commit-filter-count')).toHaveCount(0);
    const all = bar(page).getByRole('button', { name: 'Show all repositories' });
    const box = (await all.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(160);
    expect(await all.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test("the repository shown alone says so to its row's menu, which offers Show All Repositories", async ({ page }) => {
    await openNarrowed(page, LIB);
    const lib = row(page, 'demo-lib, 2 files, Branch feature/login');
    expect(JSON.parse((await lib.getAttribute('data-vscode-context')) ?? '{}')).toMatchObject({
      webviewSection: 'commitRepository',
      repoRoot: LIB,
      repoShownAlone: true,
    });
  });

  test('a selected row the list leaves out is no longer selected, so Rollback has nothing to act on', async ({
    page,
  }) => {
    await openNarrowed(page, null);
    await row(page, 'guide.md, docs, Modified').click();
    const rollback = page.getByRole('button', { name: 'Rollback' });
    await expect(rollback).toBeEnabled();
    await narrow(page, [LIB]);
    await expect(bar(page)).toBeVisible();
    await expect(rollback).toBeDisabled();
    // Back: the row is there again, not selected.
    await narrow(page, null);
    await expect(row(page, 'guide.md, docs, Modified')).toHaveAttribute('aria-selected', 'false');
  });
});

test.describe('POST-P14cf tick every change, and the menus of the list and the window', () => {
  const GIT = 'D:/repos/demo-git';
  const LIB = 'D:/repos/demo-lib';

  /** The mock: plain list (no changelist or folder rows) unless asked; staging, a second repository, a pick. */
  async function open(
    page: Page,
    o: { groupBy?: string; folders?: boolean; staging?: boolean; second?: boolean; filter?: string } = {},
  ): Promise<void> {
    await page.addInitScript((opts) => {
      const w = window as unknown as Record<string, unknown>;
      w['__mockGroupBy'] = opts.groupBy ?? 'none';
      w['__mockGroupByDirectory'] = opts.folders === true;
      if (opts.staging === true) w['__mockStaging'] = true;
      if (opts.second === true) w['__mockSecondRepo'] = true;
      if (opts.filter !== undefined) w['__mockFilter'] = opts.filter;
    }, o);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(page.getByRole('tree', { name: 'Changes' })).toBeVisible();
  }

  const box = (page: Page) => page.getByTestId('commit-tick-all');
  const counter = (page: Page) => page.getByTestId('commit-counter');
  const sent = async (page: Page, method: string) =>
    (await posted(page)).filter((m) => m.method === method).map((m) => m.params);
  const contextOf = async (l: Locator): Promise<Record<string, unknown>> =>
    JSON.parse((await l.getAttribute('data-vscode-context')) ?? '{}') as Record<string, unknown>;
  const listPane = (page: Page) => page.locator('[data-testid="commit-tree"] > .gt-commit-pane');

  test('the counter is a box, mixed while some changes are ticked, drawn as the rows’ boxes', async ({ page }) => {
    await open(page);
    await expect(box(page)).toHaveAttribute('role', 'checkbox');
    await expect(box(page)).toHaveAttribute('aria-checked', 'mixed');
    await expect(box(page)).toHaveAttribute('title', 'Tick all 5 files');
    await expect(counter(page)).toHaveText('3 of 5 files');
    await expect(box(page).locator('.gt-tricheck')).toHaveClass(/gt-tricheck-partial/);
    // Where it was: at the end of the Amend row, before the gear.
    const gear = (await page.getByRole('button', { name: 'Commit options' }).boundingBox())!;
    const at = (await box(page).boundingBox())!;
    expect(at.x + at.width).toBeLessThanOrEqual(gear.x + 1);
    expect(Math.abs(at.y + at.height / 2 - (gear.y + gear.height / 2))).toBeLessThan(4);
  });

  test('a click ticks every change, and a second unticks them all', async ({ page }) => {
    await open(page);
    await box(page).click();
    expect(await sent(page, 'commit/setAllChecked')).toEqual([{ checked: true, roots: [GIT] }]);
    await expect(box(page)).toHaveAttribute('aria-checked', 'true');
    await expect(counter(page)).toHaveText('5 of 5 files');
    await expect(box(page)).toHaveAttribute('title', 'Untick all 5 files');
    await expect(row(page, '2.txt, Untracked')).toHaveAttribute('aria-checked', 'true');
    await box(page).click();
    expect((await sent(page, 'commit/setAllChecked')).at(-1)).toEqual({ checked: false, roots: [GIT] });
    await expect(box(page)).toHaveAttribute('aria-checked', 'false');
    await expect(counter(page)).toHaveText('0 of 5 files');
  });

  test('narrowed to some repositories, it ticks the ones the list shows', async ({ page }) => {
    await open(page, { filter: GIT });
    await box(page).click();
    expect(await sent(page, 'commit/setAllChecked')).toEqual([{ checked: true, roots: [GIT] }]);
  });

  test('with staging there is no box: the counter says what is staged', async ({ page }) => {
    await open(page, { staging: true });
    await expect(box(page)).toHaveCount(0);
    await expect(counter(page)).toHaveText('1 of 5 files staged');
  });

  test('Ctrl+A selects every row; Space then ticks them all, and selects no text', async ({ page }) => {
    await open(page);
    await row(page, 'guide.md, docs, Modified').click();
    await page.keyboard.press('Control+A');
    const rows = page.locator('[role="treeitem"]');
    await expect(rows).toHaveCount(5);
    for (let i = 0; i < 5; i++) await expect(rows.nth(i)).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    await page.keyboard.press('Space');
    const last = (await sent(page, 'commit/setChecked')).at(-1) as { paths: string[]; checked: boolean };
    expect(last.checked).toBe(true);
    expect([...last.paths].sort()).toEqual(
      [
        '2.txt',
        'docs/guide.md',
        'src/main/java/api/ArticleDataController.java',
        'src/main/java/api/CommentController.java',
        'src/main/java/util/Strings.java',
      ].sort(),
    );
    await expect(box(page)).toHaveAttribute('aria-checked', 'true');
  });

  test('Space on a row of a selection of several ticks all of them, or unticks them all', async ({ page }) => {
    await open(page);
    await row(page, 'guide.md, docs, Modified').click();
    await row(page, '2.txt, Untracked').click({ modifiers: ['Control'] });
    await page.keyboard.press('Space');
    const first = (await sent(page, 'commit/setChecked')).at(-1) as { paths: string[]; checked: boolean };
    expect(first.checked).toBe(true);
    expect([...first.paths].sort()).toEqual(['2.txt', 'docs/guide.md']);
    await expect(row(page, '2.txt, Untracked')).toHaveAttribute('aria-checked', 'true');
    // Every one ticked now: Space unticks them both.
    await page.keyboard.press('Space');
    const second = (await sent(page, 'commit/setChecked')).at(-1) as { paths: string[]; checked: boolean };
    expect(second.checked).toBe(false);
    expect([...second.paths].sort()).toEqual(['2.txt', 'docs/guide.md']);
  });

  test('Space on a row outside the selection ticks that row alone, as before', async ({ page }) => {
    await open(page);
    await row(page, 'guide.md, docs, Modified').click();
    await row(page, '2.txt, Untracked').click({ modifiers: ['Control'] });
    // The keyboard moves on without selecting.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    const last = (await sent(page, 'commit/setChecked')).at(-1) as { paths: string[]; checked: boolean };
    expect(last.paths).toEqual(['src/main/java/api/ArticleDataController.java']);
    expect(last.checked).toBe(false);
  });

  test('a tick across repositories is one request, applied together', async ({ page }) => {
    await open(page, { groupBy: 'changelist', folders: true, second: true });
    const before = (await sent(page, 'commit/setChecked')).length;
    await row(page, 'Changes, 5 files').locator('.gt-tree-check').click();
    const many = await sent(page, 'commit/setCheckedMany');
    expect(many).toHaveLength(1);
    const parts = (many[0] as { parts: Array<{ repoRoot: string; checked: boolean; paths: string[] }> }).parts;
    expect(parts.map((p) => [p.repoRoot, p.checked, p.paths.length])).toEqual([
      [GIT, true, 4],
      [LIB, true, 1],
    ]);
    expect((await sent(page, 'commit/setChecked')).length).toBe(before);
  });

  test("the list's blank space carries its menu's payload, which the filter bar shares", async ({ page }) => {
    await open(page);
    expect(await contextOf(listPane(page))).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitList',
      listShowsChangelists: false,
      listHasUnticked: true,
      listHasTicked: true,
      listCanStage: false,
      listCanUnstage: false,
      listCanFold: false,
      listNarrowed: false,
      listRoots: [GIT],
    });
    // A row keeps its own menu: its section is nearer than the list's.
    expect((await contextOf(row(page, 'guide.md, docs, Modified')))['webviewSection']).toBe('commitFile');
  });

  test('with changelist rows the list offers New Changelist…, and Expand and Collapse All', async ({ page }) => {
    await open(page, { groupBy: 'changelist', folders: true });
    expect(await contextOf(listPane(page))).toMatchObject({ listShowsChangelists: true, listCanFold: true });
  });

  test('narrowed, the list and its bar offer Show All Repositories', async ({ page }) => {
    await open(page, { filter: GIT });
    expect(await contextOf(listPane(page))).toMatchObject({ listNarrowed: true, listRoots: [GIT] });
    expect(await contextOf(page.getByTestId('commit-filter'))).toMatchObject({
      webviewSection: 'commitList',
      listNarrowed: true,
    });
  });

  test('with staging the list offers Stage All and Unstage All, and no ticks', async ({ page }) => {
    await open(page, { staging: true });
    expect(await contextOf(listPane(page))).toMatchObject({
      listCanStage: true,
      listCanUnstage: true,
      listHasTicked: false,
      listHasUnticked: false,
      listShowsChangelists: false,
    });
  });

  test("the menu's Expand All and Collapse All reach the rows", async ({ page }) => {
    await open(page, { groupBy: 'changelist', folders: true });
    await expect(row(page, 'src/main/java, 3 files')).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __mockHostEvent(m: string): void }).__mockHostEvent('commit/collapseAll'),
    );
    await expect(row(page, 'src/main/java, 3 files')).toHaveCount(0);
    await expect(row(page, 'Changes, 4 files')).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() =>
      (window as unknown as { __mockHostEvent(m: string): void }).__mockHostEvent('commit/expandAll'),
    );
    await expect(row(page, 'src/main/java, 3 files')).toBeVisible();
  });

  test('no menu on the window’s chrome; the message box and the option fields keep Cut, Copy and Paste', async ({
    page,
  }) => {
    await open(page);
    expect(await contextOf(page.locator('.gt-commit'))).toEqual({ preventDefaultContextMenuItems: true });
    expect(await contextOf(page.getByTestId('commit-message'))).toEqual({ preventDefaultContextMenuItems: false });
    await page.getByRole('button', { name: 'Commit options' }).click();
    for (const id of ['opt-author', 'opt-cleanup-kind', 'opt-todo-pattern']) {
      expect(await contextOf(page.getByTestId(id))).toEqual({ preventDefaultContextMenuItems: false });
    }
  });
});

/**
 * POST-P14cj: Generate Commit Message. A language model VS Code has writes the
 * message for what Commit would commit (IntelliJ's Generate Commit Message with
 * AI Assistant). Here: where the button stands, what it tells the host, and
 * what the box does with the message that comes back. The model itself is the
 * host's, and the mock's stand-in answers with a fixed text.
 */
test.describe('POST-P14cj Generate Commit Message', () => {
  const GIT = 'D:/repos/demo-git';
  const LIB = 'D:/repos/demo-lib';
  const GENERATED = 'feat: generated subject\n\nGenerated body.';

  async function open(page: Page, o: { hold?: boolean; narrowedTo?: string } = {}): Promise<void> {
    await page.addInitScript((opts) => {
      const w = window as unknown as Record<string, unknown>;
      w['__mockMessageGeneration'] = true;
      if (opts.hold === true) w['__mockHoldGeneration'] = true;
      if (opts.narrowedTo !== undefined) w['__mockFilter'] = opts.narrowedTo;
    }, o);
    await page.addInitScript(mockCommitHostScript);
    await page.goto('/commit.html');
    await expect(page.getByRole('tree', { name: 'Changes' })).toBeVisible();
  }

  const box = (page: Page) => page.getByTestId('commit-message');
  const corner = (page: Page) => page.getByTestId('commit-message-corner');
  const generate = (page: Page) => page.getByRole('button', { name: 'Generate Commit Message' });
  const stop = (page: Page) => page.getByRole('button', { name: 'Stop Generating the Commit Message' });
  const sent = async (page: Page, method: string) =>
    (await posted(page)).filter((m) => m.method === method).map((m) => m.params);
  const release = (page: Page) =>
    page.evaluate(() => (window as unknown as { __releaseGeneration(): void }).__releaseGeneration());

  /** The corner's button and the box, as drawn: what the box leaves the button, and the text. */
  const geometry = (page: Page) =>
    box(page).evaluate((ta) => {
      const button = ta.parentElement!.querySelector('[data-testid="commit-message-corner"] button')!;
      const t = ta.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const style = getComputedStyle(ta);
      const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      return {
        insideLeft: b.left - t.left,
        insideTop: b.top - t.top,
        insideRight: t.right - b.right,
        insideBottom: t.bottom - b.bottom,
        buttonWidth: b.width,
        paddingRight: parseFloat(style.paddingRight),
        // What a vertical scrollbar takes of the box; 0 with none, or an overlay one.
        scrollbar: Math.max(0, Math.round((ta as HTMLElement).offsetWidth - ta.clientWidth - border)),
        scrolls: ta.scrollHeight > ta.clientHeight + 1,
      };
    });

  test('is not offered unless the host says so: the setting, or VS Code’s AI features, are off', async ({ page }) => {
    await openCommit(page);
    await expect(generate(page)).toHaveCount(0);
    await expect(corner(page)).toHaveCount(0);
    // And the box keeps its text's full width.
    const padding = await box(page).evaluate((ta) => [getComputedStyle(ta).paddingLeft, getComputedStyle(ta).paddingRight]);
    expect(padding[1]).toBe(padding[0]);
  });

  test('stands in the message box’s corner, clear of the text, and the Amend row is as it was', async ({ page }) => {
    await open(page);
    await expect(corner(page).getByRole('button', { name: 'Generate Commit Message' })).toBeVisible();
    await expect(page.locator('.gt-commit-amend-row').getByRole('button', { name: 'Generate Commit Message' })).toHaveCount(0);
    const g = await geometry(page);
    expect(g.insideTop).toBeGreaterThanOrEqual(0);
    expect(g.insideRight).toBeGreaterThanOrEqual(0);
    expect(g.insideLeft).toBeGreaterThan(0);
    expect(g.insideBottom).toBeGreaterThan(0);
    // The text stops short of the button.
    expect(g.paddingRight).toBeGreaterThanOrEqual(g.buttonWidth + g.insideRight);
  });

  test('a click asks the host for the box on screen, and for the whole list when it is not narrowed', async ({ page }) => {
    await open(page);
    await generate(page).click();
    await expect.poll(() => sent(page, 'commit/generateMessage')).toEqual([{ repoRoot: GIT }]);
  });

  test('narrowed to the repositories picked, the ask names the ones the list shows', async ({ page }) => {
    await open(page, { narrowedTo: LIB });
    await expect(page.getByTestId('commit-filter')).toBeVisible();
    await generate(page).click();
    await expect.poll(() => sent(page, 'commit/generateMessage')).toEqual([{ repoRoot: GIT, roots: [LIB] }]);
  });

  test('while a model writes, the same place stops it; the message then replaces the draft, and Ctrl+Z brings it back', async ({
    page,
  }) => {
    await open(page, { hold: true });
    await box(page).click();
    await box(page).pressSequentially('my draft', { delay: 5 });
    await generate(page).click();
    await expect(stop(page)).toBeVisible();
    await expect(corner(page).getByRole('button')).toHaveCount(1);
    await expect(generate(page)).toHaveCount(0);
    // Nothing is written until the model is done.
    await expect(box(page)).toHaveValue('my draft');

    await release(page);
    await expect(box(page)).toHaveValue(GENERATED);
    await expect(generate(page)).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    // A programmatic write, on the box's own undo stack.
    await box(page).press('Control+z');
    await expect(box(page)).toHaveValue('my draft');
  });

  test('the message that arrives is the one committed: the host hears it as typed', async ({ page }) => {
    await open(page);
    await generate(page).click();
    await expect(box(page)).toHaveValue(GENERATED);
    await expect
      .poll(async () => (await sent(page, 'commit/setMessage')).at(-1))
      .toEqual({ repoRoot: GIT, message: GENERATED });
    await expect(page.getByTestId('commit-button')).toBeEnabled();
  });

  test('Stop tells the host, and nothing is written', async ({ page }) => {
    await open(page, { hold: true });
    await box(page).click();
    await box(page).pressSequentially('keep me', { delay: 5 });
    await generate(page).click();
    await stop(page).click();
    await expect.poll(() => sent(page, 'commit/stopGenerating')).toHaveLength(1);
    await expect(generate(page)).toBeVisible();
    await expect(box(page)).toHaveValue('keep me');
    // And it can be asked again.
    await generate(page).click();
    await expect.poll(() => sent(page, 'commit/generateMessage')).toHaveLength(2);
  });

  test('a message longer than the box: the button stands clear of its scrollbar, and goes back after', async ({ page }) => {
    await open(page);
    const short = await geometry(page);
    expect(short.scrolls).toBe(false);
    await box(page).click();
    await box(page).pressSequentially(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'), { delay: 2 });
    const long = await geometry(page);
    expect(long.scrolls).toBe(true);
    // Left of whatever the scrollbar takes: nothing with an overlay scrollbar, its width with a classic one.
    expect(long.insideRight).toBeGreaterThanOrEqual(long.scrollbar);
    expect(Math.abs(long.insideRight - short.insideRight - long.scrollbar)).toBeLessThanOrEqual(1);

    await box(page).press('Control+a');
    await box(page).press('Backspace');
    const again = await geometry(page);
    expect(again.scrolls).toBe(false);
    expect(Math.abs(again.insideRight - short.insideRight)).toBeLessThanOrEqual(1);
  });

  test('the count of a long subject keeps clear of the button', async ({ page }) => {
    await open(page);
    await box(page).click();
    await box(page).pressSequentially('x'.repeat(80), { delay: 1 });
    const hint = page.getByTestId('subject-length');
    await expect(hint).toHaveText('80');
    const [hintBox, buttonBox] = [(await hint.boundingBox())!, (await generate(page).boundingBox())!];
    expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(buttonBox.x);
  });

  test('in a 170 px window, the narrowest a sidebar goes, the button is still inside the box', async ({ page }) => {
    await page.setViewportSize({ width: 170, height: 600 });
    await open(page);
    const g = await geometry(page);
    expect(g.insideRight).toBeGreaterThanOrEqual(0);
    expect(g.insideLeft).toBeGreaterThan(0);
    const b = (await generate(page).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(170);
  });
});
