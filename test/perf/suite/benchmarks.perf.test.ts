/**
 * P10-T1 benchmark suite. Budgets are master §13 with a 15% CI-noise
 * tolerance; medians of 5 (p95 for status, per the §13 row). Measured numbers
 * are written to GEET_PERF_RESULTS for the runner to print and for
 * docs/perf.md. Metrics without a §13 row (snapshot overhead, first-chunk
 * latency) are recorded for trend, not asserted.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { GeetApi } from '../../../src/extension';
import { SNAPSHOT_LABELS } from '../../../src/localHistory/hooks';
import { BlameService } from '../../../src/log/blame/blameService';
import type { Phase04Registry } from '../../../src/log/register';
import { GraphLayout } from '../../../src/log/graphLayout/layout';
import { LogService, PAGE_SIZE } from '../../../src/log/logService';
import { computeChanges } from '../../../src/scm/gutter/changeModel';
import { activateGeet } from '../../integration/setup';
import { EXTENSION_ID } from '../../integration/extensionId';

const NOISE = 1.15; // §13 budgets carry a 15% CI-noise tolerance
const BUDGET = {
  activationSyncMs: 100,
  statusP95Ms: 400,
  logFirstPageMs: 600,
  blameColdMs: 300,
  blameWarmMs: 30,
  logSessionMemoryMb: 150,
  changeBarsP95Ms: 50,
  blameAnnotateMs: 150,
} as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};
const round = (x: number): number => Math.round(x * 10) / 10;

suite('P10-T1 performance benchmarks (§13 budgets, 15% tolerance)', () => {
  let core: Core;
  let repoLog: RepoHandle;
  let repoStatus: RepoHandle;
  const results: Record<string, unknown> = {};
  const baselineRss = process.memoryUsage().rss;

  suiteSetup(async function () {
    this.timeout(120_000);
    core = await activateGeet();
    const logRoot = process.env['GEET_PERF_REPO_LOG'];
    const statusRoot = process.env['GEET_PERF_REPO_STATUS'];
    assert.ok(logRoot && statusRoot, 'perf fixture env missing');
    repoLog = core.repoForPath(logRoot)!;
    repoStatus = core.repoForPath(statusRoot)!;
    assert.ok(repoLog, 'log fixture repo not discovered');
    assert.ok(repoStatus, 'status fixture repo not discovered');
  });

  suiteTeardown(() => {
    const out = process.env['GEET_PERF_RESULTS'];
    if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
  });

  test('activation sync path ≤ 100 ms', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension<GeetApi>(EXTENSION_ID);
    assert.ok(ext, 'extension missing');
    const api = await ext.activate();
    const ms = api.perf?.activationSyncMs;
    assert.ok(ms !== undefined, 'activation perf marker missing');
    results['activationSyncMs'] = round(ms);
    assert.ok(
      ms <= BUDGET.activationSyncMs * NOISE,
      `activation sync path ${round(ms)}ms exceeds ${BUDGET.activationSyncMs}ms budget`,
    );
  });

  test('status refresh p95 @ 10k tracked files ≤ 400 ms', async function () {
    this.timeout(180_000);
    // Dirty 200 tracked files + 50 untracked — a realistic working set.
    for (let i = 0; i < 200; i++) {
      const rel = `dir${Math.floor((i * 50) / 100)}/file${i * 50}.txt`;
      fs.writeFileSync(path.join(repoStatus.root, rel), `dirtied ${i}\n`);
    }
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(repoStatus.root, `untracked-${i}.txt`), `${i}\n`);
    }
    // Let the watcher flood from the dirtying writes drain, so no background
    // refresh chain is in flight when sampling starts.
    await new Promise((r) => setTimeout(r, 1500));
    const samples: number[] = [];
    for (let run = 0; run < 20; run++) {
      const before = repoStatus.refresher.refreshCount;
      const t0 = performance.now();
      await repoStatus.refresher.refreshNow();
      // refreshNow coalesces into an in-flight pass and returns early — a
      // sample only counts once a fresh status actually landed in the model.
      while (repoStatus.refresher.refreshCount === before) {
        await new Promise((r) => setTimeout(r, 1));
      }
      samples.push(performance.now() - t0);
    }
    results['statusRefresh10k'] = {
      p95Ms: round(p95(samples)),
      medianMs: round(median(samples)),
    };
    assert.ok(
      p95(samples) <= BUDGET.statusP95Ms * NOISE,
      `status refresh p95 ${round(p95(samples))}ms exceeds ${BUDGET.statusP95Ms}ms budget`,
    );
  });

  test('log first page (2000 rows) + graph layout @ 100k commits ≤ 600 ms', async function () {
    this.timeout(180_000);
    const totals: number[] = [];
    const firstChunks: number[] = [];
    for (let run = 0; run < 5; run++) {
      const svc = new LogService(repoLog); // fresh instance — no page cache
      const t0 = performance.now();
      let firstChunkAt: number | undefined;
      const page = await svc.getPage({ sort: 'topo', refs: 'HEAD' }, 0, () => {
        firstChunkAt ??= performance.now() - t0;
      });
      const layout = new GraphLayout();
      layout.appendPage(page.rows.map((r) => ({ sha: r.sha, parents: r.parents })));
      totals.push(performance.now() - t0);
      if (firstChunkAt !== undefined) firstChunks.push(firstChunkAt);
      assert.strictEqual(page.rows.length, PAGE_SIZE, 'full first page streamed');
    }
    results['logFirstPage100k'] = {
      medianMs: round(median(totals)),
      firstChunkMedianMs: round(median(firstChunks)),
    };
    assert.ok(
      median(totals) <= BUDGET.logFirstPageMs * NOISE,
      `log first page ${round(median(totals))}ms exceeds ${BUDGET.logFirstPageMs}ms budget`,
    );
  });

  test('blame 5k-line file: cold ≤ 300 ms, cached ≤ 30 ms', async function () {
    this.timeout(120_000);
    const fsPath = path.join(repoLog.root, 'blame.txt');
    const content = fs.readFileSync(fsPath, 'utf8');
    const lineCount = content.split('\n').length - 1;
    assert.ok(lineCount >= 5000, `blame fixture has ${lineCount} lines`);

    const colds: number[] = [];
    for (let run = 0; run < 5; run++) {
      const svc = new BlameService(repoLog);
      const t0 = performance.now();
      const blame = await svc.blameFile(fsPath, content, false, 1, lineCount);
      colds.push(performance.now() - t0);
      assert.ok(blame, 'blame produced');
    }
    const svc = new BlameService(repoLog);
    await svc.blameFile(fsPath, content, false, 1, lineCount);
    const warms: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      await svc.blameFile(fsPath, content, false, 1, lineCount);
      warms.push(performance.now() - t0);
    }
    results['blame5k'] = { coldMedianMs: round(median(colds)), warmMedianMs: round(median(warms)) };
    assert.ok(
      median(colds) <= BUDGET.blameColdMs * NOISE,
      `cold blame ${round(median(colds))}ms exceeds ${BUDGET.blameColdMs}ms budget`,
    );
    assert.ok(
      median(warms) <= BUDGET.blameWarmMs * NOISE,
      `cached blame ${round(median(warms))}ms exceeds ${BUDGET.blameWarmMs}ms budget`,
    );
  });

  test('annotating a 5k-line file ≤ 150 ms once the blame is cached', async function () {
    this.timeout(120_000);
    // No §13 row: this guards the *decoration* half of blame, which nothing
    // measured before POST-P14h. It matters because the gutter emits one
    // decoration per line with its own `renderOptions`, and the editor
    // registers a CSS sub-type per distinct `hash(renderOptions)`. Both fields
    // that vary — the label and the age shade — are commit-derived, so the
    // rule count tracks the file's *commits*; a change that made it track
    // *lines* would not fail any other test in this repo.
    const reg = core.debugRegistry.get('phase04') as Phase04Registry;
    assert.ok(reg?.blameUi, 'phase04 registry missing');
    const uri = vscode.Uri.file(path.join(repoLog.root, 'blame.txt'));
    const editor = await vscode.window.showTextDocument(uri);
    assert.ok(editor.document.lineCount >= 5000, 'blame fixture is 5k lines');

    try {
      await reg.blameUi.toggle(editor); // on, and warms the blame cache
      assert.ok(reg.blameUi.isEnabled(editor.document), 'blame did not turn on');

      const refreshes: number[] = [];
      for (let run = 0; run < 5; run++) {
        const t0 = performance.now();
        await reg.blameUi.refresh();
        refreshes.push(performance.now() - t0);
      }
      const ms = median(refreshes);
      // The blame lookup inside refresh() is the cached path measured above,
      // so the decoration share is this minus `blame5k.warmMedianMs`.
      results['blameAnnotate5k'] = { medianMs: round(ms) };
      assert.ok(
        ms <= BUDGET.blameAnnotateMs * NOISE,
        `annotate 5k lines ${round(ms)}ms exceeds ${BUDGET.blameAnnotateMs}ms budget`,
      );
    } finally {
      if (reg.blameUi.isEnabled(editor.document)) await reg.blameUi.toggle(editor);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  test('P12-T9 selection → Details + Changed Files panes (recorded, no §13 budget)', async function () {
    this.timeout(120_000);
    // The four-pane window populates lazily: selecting a commit pushes ids and
    // each right pane fetches its own data — log/details and log/changedFiles
    // both resolve through getCommitDetails host-side. Measure the concurrent
    // pair on a fresh service (no details cache), the way a first click lands.
    const head1 = (
      await core.git.exec(repoLog.root, ['rev-parse', 'HEAD~1'])
    ).stdout.trim();
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const svc = new LogService(repoLog);
      const t0 = performance.now();
      const [details, files] = await Promise.all([
        svc.getCommitDetails(head1),
        svc.getCommitDetails(head1),
      ]);
      times.push(performance.now() - t0);
      assert.ok(details && files, 'both pane feeds resolved');
    }
    results['selectionToPanes'] = { medianMs: round(median(times)) };
  });

  test('P12-T9 Changed Files @ 5000-file commit (recorded, no §13 budget)', async function () {
    this.timeout(120_000);
    // HEAD of the log fixture is the 5 000-file wide commit (runPerf.ts).
    const wideSha = (await core.git.exec(repoLog.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const times: number[] = [];
    let fileCount = 0;
    for (let run = 0; run < 5; run++) {
      const svc = new LogService(repoLog);
      const t0 = performance.now();
      const details = await svc.getCommitDetails(wideSha);
      times.push(performance.now() - t0);
      fileCount = details?.files.length ?? 0;
    }
    assert.strictEqual(fileCount, 5000, 'wide commit reports all 5000 files');
    results['changedFiles5000'] = { medianMs: round(median(times)), files: fileCount };
  });

  test('P14-T3 change-bar recompute p95 @ 5k lines ≤ 50 ms', function () {
    this.timeout(120_000);
    // The recompute is dominated by the line diff, which is the term the
    // `changeBars.maxFileLines` cutoff exists to bound. Measured on the pure
    // function: the decoration apply is O(changes) and never the cost.
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} of the fixture file`).join('\n') + '\n';
    const lines = base.split('\n');
    // A realistic edit spread: 40 scattered modifications, one insert block,
    // one delete block — not one big rewrite, which would be the easy case.
    for (let i = 0; i < 40; i++) lines[i * 120 + 7] = `line ${i * 120 + 8} EDITED`;
    lines.splice(2500, 0, ...Array.from({ length: 20 }, (_, i) => `inserted ${i}`));
    lines.splice(4000, 15);
    const modified = lines.join('\n');

    const samples: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      const changes = computeChanges(base, modified);
      samples.push(performance.now() - t0);
      assert.ok(changes.length > 0, 'fixture must actually differ');
    }
    results['changeBars5kLines'] = { p95Ms: round(p95(samples)), medianMs: round(median(samples)) };
    assert.ok(
      p95(samples) <= BUDGET.changeBarsP95Ms * NOISE,
      `change-bar recompute p95 ${round(p95(samples))}ms exceeds ${BUDGET.changeBarsP95Ms}ms budget`,
    );
  });

  test('P9 snapshot overhead @ 2k dirty files (recorded, no §13 budget)', async function () {
    this.timeout(300_000);
    const dirtyAll = (tag: string): void => {
      for (let i = 0; i < 2000; i++) {
        const rel = `dir${Math.floor((i * 5) / 100)}/file${i * 5}.txt`;
        fs.writeFileSync(path.join(repoStatus.root, rel), `snapshot ${tag} ${i}\n`);
      }
    };
    const noop = async (withSnapshot: boolean): Promise<number> => {
      const t0 = performance.now();
      await repoStatus.queue.enqueue({
        label: 'perf snapshot probe',
        kind: 'mutate',
        ...(withSnapshot ? { isDestructive: true, snapshotLabel: SNAPSHOT_LABELS.rollback } : {}),
        run: () => Promise.resolve(),
      });
      return performance.now() - t0;
    };
    const withSnap: number[] = [];
    const without: number[] = [];
    for (let run = 0; run < 3; run++) {
      dirtyAll(`w${run}`); // fresh bytes each run — dedupe would flatter the number
      await repoStatus.refresher.refreshNow();
      withSnap.push(await noop(true));
      without.push(await noop(false));
    }
    results['snapshot2kDirty'] = {
      withSnapshotMedianMs: round(median(withSnap)),
      baselineMedianMs: round(median(without)),
      overheadMs: round(median(withSnap) - median(without)),
    };
  });

  test('extension-host memory after a 100k-commit log session ≤ 150 MB (session delta)', async function () {
    this.timeout(300_000);
    // A real session: 5 pages (10k rows) streamed + laid out, details cached.
    const svc = new LogService(repoLog);
    const layout = new GraphLayout();
    for (let page = 0; page < 5; page++) {
      const res = await svc.getPage({ sort: 'topo', refs: 'HEAD' }, page);
      layout.appendPage(res.rows.map((r) => ({ sha: r.sha, parents: r.parents })));
    }
    globalThis.gc?.();
    const rss = process.memoryUsage().rss;
    const deltaMb = (rss - baselineRss) / (1024 * 1024);
    results['memory100kLogSession'] = {
      rssMb: round(rss / (1024 * 1024)),
      suiteBaselineRssMb: round(baselineRss / (1024 * 1024)),
      sessionDeltaMb: round(deltaMb),
    };
    assert.ok(
      deltaMb <= BUDGET.logSessionMemoryMb * NOISE,
      `log session added ${round(deltaMb)}MB RSS, exceeds ${BUDGET.logSessionMemoryMb}MB budget`,
    );
  });
});
