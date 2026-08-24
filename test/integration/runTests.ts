import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runTests } from '@vscode/test-electron';
import { FixtureRepo } from '../fixtures/fixtureRepo';

/**
 * Integration entry point: downloads a stable VS Code build and opens a
 * multi-root workspace of five FixtureRepo repos (P0-T7 discovery acceptance),
 * then runs the mocha suite in test/integration/suite. Repos are claimed per
 * suite — A→P1, B→P2/P7/P9, C→P3/P11, D+E→multiRoot — because the suites share
 * one window and cross-suite dirt cascades into false failures.
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

  const repoA = FixtureRepo.create({ prefix: 'gittree-ws-repoA-' });
  repoA.commit('initial', { 'README.md': '# repoA\n', 'src/a.ts': 'export const a = 1;\n' });
  const repoB = FixtureRepo.create({ prefix: 'gittree-ws-repoB-' });
  repoB.commit('initial', { 'README.md': '# repoB\n' });
  // repoC belongs to the Phase 3 commit-lifecycle suite.
  const repoC = FixtureRepo.create({ prefix: 'gittree-ws-repoC-' });
  repoC.commit('initial', { 'README.md': '# repoC\n', 'src/code.ts': 'export const one = 1;\n' });
  // repoD/repoE belong to the multi-root commit suite, which needs two repos
  // dirty at once and commits in both. Borrowing A/B/C for that would leave
  // commits behind in repos three other suites assert against.
  const repoD = FixtureRepo.create({ prefix: 'gittree-ws-repoD-' });
  repoD.commit('initial', { 'README.md': '# repoD\n', 'src/d.ts': 'export const d = 1;\n' });
  const repoE = FixtureRepo.create({ prefix: 'gittree-ws-repoE-' });
  repoE.commit('initial', { 'README.md': '# repoE\n', 'src/e.ts': 'export const e = 1;\n' });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-itest-'));
  const workspaceFile = path.join(scratch, 'gittree-itest.code-workspace');
  fs.writeFileSync(
    workspaceFile,
    JSON.stringify(
      {
        folders: [
          { path: repoA.root },
          { path: repoB.root },
          { path: repoC.root },
          { path: repoD.root },
          { path: repoE.root },
        ],
      },
      null,
      2,
    ),
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
        GITTREE_TEST_AUTOCONFIRM: '1',
        GITTREE_TEST_REPO_A: repoA.root,
        GITTREE_TEST_REPO_B: repoB.root,
        GITTREE_TEST_REPO_C: repoC.root,
        GITTREE_TEST_REPO_D: repoD.root,
        GITTREE_TEST_REPO_E: repoE.root,
        // Local-iteration filter (mocha grep on suite/test titles). The full
        // suite remains the gate; this only narrows ad-hoc runs.
        ...(process.env['GITTREE_TEST_ONLY'] ? { GITTREE_TEST_ONLY: process.env['GITTREE_TEST_ONLY'] } : {}),
      },
    });
  } finally {
    repoA.dispose();
    repoB.dispose();
    repoC.dispose();
    repoD.dispose();
    repoE.dispose();
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
