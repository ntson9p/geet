/**
 * P10-T1 perf entry point: builds two synthetic fixtures — a 100k-commit
 * fast-import history (log/blame/memory benchmarks) and a 10k-tracked-file
 * worktree (status/snapshot benchmarks) — then runs the benchmark suite in a
 * downloaded VS Code build. Budgets from master §13 are asserted inside the
 * suite with a 15% CI-noise tolerance; the measured numbers are printed here
 * (and recorded in docs/perf.md).
 * Executed from out/test/perf/runPerf.js (tsc -p tsconfig.integration.json).
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { runTests } from '@vscode/test-electron';
import { FixtureRepo } from '../fixtures/fixtureRepo';

const LOG_COMMITS = 100_000;
const STATUS_FILES = 10_000;

async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;

  // out/test/perf → repo root
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  console.log(`[perf] building ${LOG_COMMITS.toLocaleString()}-commit log fixture…`);
  let t = Date.now();
  const repoLog = FixtureRepo.create({ prefix: 'gittree-perf-log-' });
  const commits: Array<{
    mark: number;
    parents?: number[];
    message: string;
    files?: Record<string, string>;
  }> = [];
  for (let i = 1; i <= LOG_COMMITS; i++) {
    commits.push({
      mark: i,
      ...(i === 1 ? {} : { parents: [i - 1] }),
      message: `perf commit ${i}`,
      files: { [`f${i % 10}.txt`]: `${i}\n` },
    });
  }
  repoLog.fastImport(commits);
  // 5k-line blame target built across 5 commits (realistic run distribution).
  let blame = '';
  for (let c = 0; c < 5; c++) {
    for (let l = 1; l <= 1000; l++) blame += `line ${c * 1000 + l} from commit ${c}\n`;
    repoLog.commit(`blame chunk ${c}`, { 'blame.txt': blame });
  }
  console.log(`[perf] log fixture ready in ${Date.now() - t} ms`);

  console.log(`[perf] building ${STATUS_FILES.toLocaleString()}-file status fixture…`);
  t = Date.now();
  const repoStatus = FixtureRepo.create({ prefix: 'gittree-perf-status-' });
  const files: Record<string, string> = {};
  for (let i = 0; i < STATUS_FILES; i++) {
    files[`dir${Math.floor(i / 100)}/file${i}.txt`] = `content ${i}\n`;
  }
  repoStatus.fastImport([{ mark: 1, message: 'seed files', files }]);
  console.log(`[perf] status fixture ready in ${Date.now() - t} ms`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-perf-'));
  const workspaceFile = path.join(scratch, 'gittree-perf.code-workspace');
  fs.writeFileSync(
    workspaceFile,
    JSON.stringify({ folders: [{ path: repoLog.root }, { path: repoStatus.root }] }, null, 2),
  );
  const resultsFile = path.join(scratch, 'perf-results.json');

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
        GITTREE_PERF_REPO_LOG: repoLog.root,
        GITTREE_PERF_REPO_STATUS: repoStatus.root,
        GITTREE_PERF_RESULTS: resultsFile,
      },
    });
  } finally {
    if (fs.existsSync(resultsFile)) {
      console.log('[perf] results:');
      console.log(fs.readFileSync(resultsFile, 'utf8'));
    }
    repoLog.dispose();
    repoStatus.dispose();
    try {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // tmp scratch — safe to leave to the OS
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
