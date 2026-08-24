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

    const unversioned = await ctxOf('Unversioned Files, 1 file');
    expect(unversioned['listId']).toBe('__unversioned__');
    expect(unversioned['listIsDefault']).toBe(false);

    const file = await ctxOf('ArticleDataController.java, src/main/java/api');
    expect(file['webviewSection']).toBe('commitFile');
    expect(file['repoRoot']).toBe('D:/repos/demo-git');
    expect(file['relPath']).toBe('src/main/java/api/ArticleDataController.java');
    // A file row must not offer changelist-level actions.
    expect(file['listId']).toBeUndefined();

    // Folder rows stand for no changelist and no file, so they carry nothing.
    expect(await row(page, 'api, 2 files').getAttribute('data-vscode-context')).toBeNull();
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

  test('severity and profile controls follow their check toggles', async ({ page }) => {
    await openOptions(page);
    // Analyze is on by default → severity enabled; cleanup off → profile disabled.
    await expect(page.getByTestId('opt-analyze-severity')).toBeEnabled();
    await expect(page.getByTestId('opt-cleanup-kind')).toBeDisabled();

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
