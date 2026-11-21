import { expect, test, type Page } from '@playwright/test';

/** P13-T8 · S7: the `Files Merged with Conflicts` gate. */

const HOST = `
(() => {
  window.__geetInitialState = { dialog: 'conflicts' };
  const PARAMS = {
    repoRoot: 'D:/repos/demo',
    repoLabel: 'demo',
    operation: 'merge',
    files: [
      { path: 'src/app.ts', kind: 'both-modified', mergeable: true },
      { path: 'src/other.ts', kind: 'added-by-both', mergeable: true },
      { path: 'docs/gone.md', kind: 'deleted-by-them', mergeable: false },
    ],
    colors: {},
  };
  const handlers = {
    'dialog/init': () => ({ dialog: 'conflicts', params: JSON.parse(JSON.stringify(PARAMS)) }),
  };
  let state;
  const api = {
    postMessage(msg) {
      if (!msg || msg.v !== 1) return;
      (window.__postedMessages = window.__postedMessages || []).push(msg);
      if (msg.kind !== 'req') return;
      const handler = handlers[msg.method];
      const response = handler
        ? { v: 1, id: msg.id, kind: 'res', result: handler(msg.params) }
        : { v: 1, id: msg.id, kind: 'res', error: { code: 'unknown-method', message: msg.method } };
      setTimeout(() => window.postMessage(response, '*'), 5);
    },
    getState() { return state; },
    setState(s) { state = s; },
  };
  window.acquireVsCodeApi = () => api;
})();
`;

interface PostedMsg {
  kind: string;
  method?: string;
  params?: Record<string, unknown>;
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(HOST);
  await page.goto('/dialogs.html');
  await expect(page.getByRole('dialog', { name: /Files Merged with Conflicts/ })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

function acceptOf(page: PostedMsg[]): Record<string, unknown> | undefined {
  return page.find((m) => m.method === 'dialog/accept')?.params;
}

/** The frame's title bar also has a Close — scope to the footer's action row. */
function footerButton(page: Page, name: string) {
  return page.locator('.gt-dialog-actions').getByRole('button', { name, exact: true });
}

test.describe('P13-T8 files merged with conflicts', () => {
  test('lists the conflicts, all ticked, with their kinds', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('conflicts-summary')).toContainText(
      'merge produced 3 conflicted files',
    );
    await expect(page.getByTestId('conflicts-summary')).toContainText('3 selected');
    await expect(page.getByTestId('conflicts-list')).toContainText('modified on both sides');
    // A conflict with no line-level merge says so.
    await expect(page.getByTestId('conflicts-list')).toContainText('no line merge');
    for (const p of ['src/app.ts', 'src/other.ts', 'docs/gone.md']) {
      await expect(page.getByTestId(`conflict-${p}`)).toBeChecked();
    }
  });

  test('offers the four reference actions', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('button', { name: 'Merge…' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Accept Yours' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Accept Theirs' })).toBeEnabled();
    await expect(page.getByTestId('conflicts-simple')).toBeVisible();
    await expect(footerButton(page, 'Close')).toBeVisible();
  });

  test('Accept Yours carries only the ticked files', async ({ page }) => {
    await open(page);
    await page.getByTestId('conflict-docs/gone.md').uncheck();
    await expect(page.getByTestId('conflicts-summary')).toContainText('2 selected');

    await page.getByRole('button', { name: 'Accept Yours' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toEqual({
      action: 'acceptYours',
      paths: ['src/app.ts', 'src/other.ts'],
    });
  });

  test('Accept Theirs posts the other side', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Accept Theirs' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      action: 'acceptTheirs',
    });
  });

  test('Merge… opens the first mergeable file, never a special conflict', async ({ page }) => {
    await open(page);
    // Untick the two mergeable files: Merge… has nothing to open.
    await page.getByTestId('conflict-src/app.ts').uncheck();
    await page.getByTestId('conflict-src/other.ts').uncheck();
    await expect(page.getByRole('button', { name: 'Merge…' })).toBeDisabled();

    await page.getByTestId('conflict-src/other.ts').check();
    await page.getByRole('button', { name: 'Merge…' }).click();
    await expect.poll(async () => acceptOf(await posted(page))).toEqual({
      action: 'merge',
      paths: ['src/other.ts'],
    });
  });

  test('Resolve Simple posts the resolve-all action', async ({ page }) => {
    await open(page);
    await page.getByTestId('conflicts-simple').click();
    await expect.poll(async () => acceptOf(await posted(page))).toMatchObject({
      action: 'resolveSimple',
    });
  });

  test('unticking everything disables the accept buttons', async ({ page }) => {
    await open(page);
    for (const p of ['src/app.ts', 'src/other.ts', 'docs/gone.md']) {
      await page.getByTestId(`conflict-${p}`).uncheck();
    }
    await expect(page.getByRole('button', { name: 'Accept Yours' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Accept Theirs' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Merge…' })).toBeDisabled();
  });

  test('Close cancels without acting', async ({ page }) => {
    await open(page);
    await footerButton(page, 'Close').click();
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.method === 'dialog/cancel').length)
      .toBe(1);
    expect(acceptOf(await posted(page))).toBeUndefined();
  });
});
