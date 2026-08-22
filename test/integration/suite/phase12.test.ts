import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { Phase04Registry } from '../../../src/log/register';
import { LOG_METHODS } from '../../../src/shared/protocol';
import { activateGitTree, waitFor, workspaceRepoC } from '../setup';

/**
 * P12 Git tool window — host half. The four-pane layout, pane cycling and
 * persistence are Playwright-covered (log.spec.ts); these tests pin the host
 * contract: every webview→host method is answered, and the selection model
 * lives host-side.
 */
suite('P12 git tool window', () => {
  let reg: Phase04Registry;

  suiteSetup(async function () {
    this.timeout(60_000);
    workspaceRepoC();
    const core = await activateGitTree();
    reg = core.debugRegistry.get('phase04') as Phase04Registry;
    assert.ok(reg, 'phase04 registry missing');
  });

  test('T1: every webview→host log method has a host handler', async function () {
    this.timeout(30_000);
    await vscode.commands.executeCommand('gittree.log.focus');
    await waitFor(() => reg.logView.hasHandler(LOG_METHODS.init), 15_000);
    // The P11-T3 lesson: `on()` and `onEvent()` are different routers, and a
    // missing handler fails in total silence. Assert the whole surface.
    for (const [name, method] of Object.entries(LOG_METHODS)) {
      if (name.startsWith('evt')) continue; // host → webview
      assert.ok(reg.logView.hasHandler(method), `no host handler for ${method}`);
    }
  });

  test('T1: the selection model lives host-side and starts empty', function () {
    this.timeout(15_000);
    assert.deepStrictEqual([...reg.logView.selectedCommits], []);
  });
});
