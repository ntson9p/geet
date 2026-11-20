import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../extensionId';

/**
 * P0-T9 host side: the demo command builds CSP'd HTML pointing at
 * dist/webviews/demo and opens a panel without throwing.
 */
suite('P0-T9 webview host factory', () => {
  test('demo command opens a webview panel', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    await vscode.commands.executeCommand('gittree.debug.webviewDemo');
    // Tab state updates asynchronously; look for the webview tab anywhere.
    const findDemoTab = (): vscode.Tab | undefined =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputWebview && t.label === 'Geet Webview Demo');
    const deadline = Date.now() + 5000;
    while (!findDemoTab() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(findDemoTab(), 'demo webview tab did not appear');
  });
});
