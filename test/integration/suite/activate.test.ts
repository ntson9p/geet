import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../extensionId';

suite('P0-T1 scaffold', () => {
  test('extension is discovered and activates', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });
});
