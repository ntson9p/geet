import { expect, test, type Page } from '@playwright/test';

/** P13-T6: the New Worktree dialog — mode switching and the default path. */

const HOST = `
(() => {
  window.__gittreeInitialState = { dialog: 'newWorktree' };
  const PARAMS = {
    repoRoot: 'D:/repos/demo',
    repoLabel: 'demo',
    branches: ['feature/x', 'main', 'wip'],
    seedBranch: 'feature/x',
    defaultPath: 'D:/repos/demo-feature-x',
    showCommandLine: true,
  };
  const handlers = {
    'dialog/init': () => ({ dialog: 'newWorktree', params: JSON.parse(JSON.stringify(PARAMS)) }),
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
  await expect(page.getByRole('dialog', { name: /New Worktree/ })).toBeVisible();
}

async function posted(page: Page): Promise<PostedMsg[]> {
  return (await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown }).__postedMessages,
  )) as PostedMsg[];
}

test.describe('P13-T6 new worktree dialog', () => {
  test('opens on the seed branch with the sibling default path', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('worktree-mode-existing')).toBeChecked();
    await expect(page.getByTestId('worktree-branch')).toHaveValue('feature/x');
    await expect(page.getByTestId('worktree-path')).toHaveValue('D:/repos/demo-feature-x');
    await expect(page.getByTestId('worktree-open-window')).toBeChecked();
    await expect(page.getByTestId('will-run')).toContainText(
      'git worktree add D:/repos/demo-feature-x feature/x',
    );
  });

  test('the path follows the branch until the user edits it', async ({ page }) => {
    await open(page);
    await page.getByTestId('worktree-branch').selectOption('wip');
    await expect(page.getByTestId('worktree-path')).toHaveValue('D:/repos/demo-wip');

    await page.getByTestId('worktree-path').fill('D:/elsewhere/mine');
    await page.getByTestId('worktree-branch').selectOption('main');
    await expect(page.getByTestId('worktree-path')).toHaveValue('D:/elsewhere/mine');
  });

  test('new-branch mode adds -b and keeps the branch as the start point', async ({ page }) => {
    await open(page);
    await page.getByTestId('worktree-mode-new').check();
    await expect(page.getByTestId('worktree-start')).toHaveValue('feature/x');
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();

    await page.getByTestId('worktree-new-branch').fill('feature/y');
    await expect(page.getByTestId('will-run')).toContainText(
      'git worktree add -b feature/y D:/repos/demo-feature-y feature/x',
    );
    await expect(page.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  test('an illegal new-branch name is rejected with a reason', async ({ page }) => {
    await open(page);
    await page.getByTestId('worktree-mode-new').check();
    await page.getByTestId('worktree-new-branch').fill('bad name');
    await expect(page.getByTestId('option-conflicts')).toContainText('cannot contain');
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  test('detach mode takes a free-text revision', async ({ page }) => {
    await open(page);
    await page.getByTestId('worktree-mode-detach').check();
    await page.getByTestId('worktree-revision').fill('abc1234');
    await expect(page.getByTestId('will-run')).toContainText('git worktree add --detach');
    await expect(page.getByTestId('will-run')).toContainText('abc1234');
  });

  test('the options and the accepted payload carry through', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Modify options' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Allow a branch checked out elsewhere/ }).click();
    await page.getByTestId('worktree-force').check();
    await expect(page.getByTestId('will-run')).toContainText('--force');

    await page.getByTestId('worktree-open-window').uncheck();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect
      .poll(async () => (await posted(page)).find((m) => m.method === 'dialog/accept')?.params)
      .toMatchObject({
        openInNewWindow: false,
        options: { mode: 'existing', ref: 'feature/x', force: true },
      });
  });
});
