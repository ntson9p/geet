import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('P0-T1 scaffold', () => {
  test('extension is discovered and activates', async () => {
    const ext = vscode.extensions.getExtension('gittree.gittree');
    assert.ok(ext, 'extension gittree.gittree not found');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
