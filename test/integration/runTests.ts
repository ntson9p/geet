import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

/**
 * Integration entry point: downloads a stable VS Code build, opens a scratch
 * git workspace, and runs the mocha suite in test/integration/suite.
 * Executed from out/test/integration/runTests.js (tsc -p tsconfig.integration.json).
 */
async function main(): Promise<void> {
  // When launched from a terminal inside VS Code (or any Electron app), this
  // inherited flag makes the downloaded VS Code run as plain Node and try to
  // require() the workspace path. Scrub it before test-electron spawns.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // out/test/integration → repo root
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-itest-'));
  const init = spawnSync('git', ['init', '--initial-branch=main'], { cwd: workspace, encoding: 'utf8' });
  if (init.status !== 0) {
    // Older gits lack --initial-branch (< 2.28); fall back to plain init.
    const plain = spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
    if (plain.status !== 0) {
      throw new Error(`git init failed: ${plain.stderr}`);
    }
  }

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: { GITTREE_TEST: '1' },
    });
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows AV/file locks — scratch dir in tmp, safe to leave behind.
    }
  }
}

main().catch((err: unknown) => {
  console.error('Integration tests failed:', err);
  process.exitCode = 1;
});
