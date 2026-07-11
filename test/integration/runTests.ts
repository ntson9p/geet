import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runTests } from '@vscode/test-electron';

/**
 * Integration entry point: downloads a stable VS Code build and opens a
 * multi-root workspace of two scratch git repos (P0-T7 discovery acceptance),
 * then runs the mocha suite in test/integration/suite.
 * Executed from out/test/integration/runTests.js (tsc -p tsconfig.integration.json).
 */

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git('init');
  git('config', 'user.email', 'itest@gittree.dev');
  git('config', 'user.name', 'GitTree ITest');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  git('add', '.');
  git('commit', '-m', 'initial');
}

async function main(): Promise<void> {
  // When launched from a terminal inside VS Code (or any Electron app), this
  // inherited flag makes the downloaded VS Code run as plain Node and try to
  // require() the workspace path. Scrub it before test-electron spawns.
  delete process.env.ELECTRON_RUN_AS_NODE;

  // out/test/integration → repo root
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-itest-'));
  const repoA = path.join(scratch, 'repoA');
  const repoB = path.join(scratch, 'repoB');
  initRepo(repoA);
  initRepo(repoB);
  const workspaceFile = path.join(scratch, 'gittree-itest.code-workspace');
  fs.writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: [{ path: 'repoA' }, { path: 'repoB' }] }, null, 2),
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspaceFile,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        GITTREE_TEST: '1',
        GITTREE_TEST_REPO_A: repoA,
        GITTREE_TEST_REPO_B: repoB,
      },
    });
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows AV/file locks — scratch dir in tmp, safe to leave behind.
    }
  }
}

main().catch((err: unknown) => {
  console.error('Integration tests failed:', err);
  process.exitCode = 1;
});
