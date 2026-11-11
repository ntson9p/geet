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

    const file = await ctxOf('ArticleDataController.java, src/main/java/api');
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
    await row(page, 'guide.md, docs').click({ modifiers: ['Control'] });
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
    const first = 'ArticleDataController.java, src/main/java/api';
    const second = 'CommentController.java, src/main/java/api';

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
    await row(page, 'guide.md, docs').click({ button: 'right' });
    expect((await ctxOf('guide.md, docs'))['relPaths']).toEqual(['docs/guide.md']);
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-selected', 'true');
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
    await expect(page.getByTestId('commit-push-button')).toBeVisible();
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
    await row(page, 'guide.md, docs').click({ modifiers: ['Control'] });
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
    await row(page, 'guide.md, docs').dblclick();
    const opens = (await posted(page)).filter((m) => m.method === 'commit/openDiff').length;

    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await expect(row(page, '2.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-selected', 'false');
    expect((await posted(page)).filter((m) => m.method === 'commit/openDiff').length).toBe(opens);
  });

  test('a walk over several selected rows leaves them selected', async ({ page }) => {
    await openCommit(page);
    await row(page, '2.txt').click();
    await row(page, 'guide.md, docs').click({ modifiers: ['Control'] });
    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await page.waitForTimeout(100);
    await expect(row(page, '2.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-selected', 'true');
  });

  test("a walk takes the keyboard's row along", async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md, docs').dblclick();
    await postEvent(page, 'commit/diffFile', { repoRoot: 'D:/repos/demo-git', path: '2.txt' });
    await expect(row(page, '2.txt')).toHaveClass(/gt-focused/);
    await expect(row(page, 'guide.md, docs')).not.toHaveClass(/gt-focused/);
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
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-current', 'true');
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
      diffOnScreen: { repoRoot: 'D:/repos/demo-git', path: 'docs/guide.md' },
    });
    await expect(row(page, 'guide.md, docs')).toHaveAttribute('aria-current', 'true');
  });

  test('Enter on the row the arrows reached selects it as the diff opens it', async ({ page }) => {
    await openCommit(page);
    const first = row(page, 'ArticleDataController.java, src/main/java/api');
    const next = row(page, 'CommentController.java, src/main/java/api');
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
    });
  const chains = async (page: Page): Promise<PostedMsg[]> =>
    (await posted(page)).filter((m) => m.method === 'commit/diffChain');

  test('a walk over the whole list hears when the list changes', async ({ page }) => {
    await openCommit(page);
    await row(page, 'guide.md, docs').dblclick();
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
    await row(page, 'guide.md, docs').click({ modifiers: ['Control'] });
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

    // Defer defaults ON (the §2A reference shows it checked); unticking posts false.
    await expect(page.getByTestId('opt-defer')).toBeChecked();
    await page.getByTestId('opt-defer').click();
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
    // Whether ticked checks run before or after the commit is not a check.
    await expect(page.getByTestId('opt-defer')).toBeChecked();
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
    await expect(row(page, 'guide.md, docs').locator('.gt-tree-name')).toHaveCSS(
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

  test('is offered only where there are repositories to arrange', async ({ page }) => {
    await openCommit(page);
    await expect(viewOptions(page)).toHaveCount(0);
    await expect(page.locator('.gt-tree-swatch')).toHaveCount(0);
  });

  test('offers both groupings, the one shown ticked', async ({ page }) => {
    await openGrouped(page);
    await viewOptions(page).click();
    const menu = page.getByRole('menu', { name: 'View Options' });
    await expect(menu).toBeVisible();
    await expect(menu.locator('.gt-menu-header')).toHaveText('Group By');
    const byList = page.getByRole('menuitemradio', { name: 'Changelist › Repository' });
    const byRepo = page.getByRole('menuitemradio', { name: 'Repository › Changelist' });
    await expect(byList).toHaveAttribute('aria-checked', 'true');
    await expect(byRepo).toHaveAttribute('aria-checked', 'false');
    // The keyboard starts on the choice that holds.
    await expect(byList).toHaveClass(/gt-active/);
    // IntelliJ's dot only when the view is not the default one.
    await expect(viewOptions(page).locator('.gt-toolbar-badge')).toHaveCount(0);
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
    const strings = row(page, 'Strings.java, src/main/java/util');
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
    const notes = row(page, 'notes.txt, lib');
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
    const strings = row(page, 'Strings.java, src/main/java/util');
    await strings.click();
    await expect(strings).toHaveAttribute('tabindex', '0');
    await row(page, 'api, 2 files').locator('.gt-twistie').click();
    await expect(row(page, 'api, 2 files')).toHaveAttribute('aria-expanded', 'false');
    await expect(strings).toHaveAttribute('tabindex', '0');
  });

  test('folded away, its folder takes the keyboard', async ({ page }) => {
    await openCommit(page);
    await row(page, 'Strings.java, src/main/java/util').click();
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
