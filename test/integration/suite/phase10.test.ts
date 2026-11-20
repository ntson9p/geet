import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../../src/core/core';
import { activateGeet, gitWithRetry, workspaceRepoA } from '../setup';

interface Phase10RegistryShape {
  offerPlaybook(repoRoot: string): Promise<void>;
  generatePlayground(): Promise<string | undefined>;
  telemetryEvents(): { name: string; props: Record<string, string> }[];
  sendTelemetry(name: string, props: Record<string, string | number | boolean>): boolean;
  errorCopy(kind: string): string;
  buildIssueUrl(kind?: string): string;
}

/** P10-T1 step 4: large-repo playbook prompt (threshold + choice seams). */
suite('P10 hardening — large-repo playbook', () => {
  let core: Core;
  let repo: RepoHandle;
  let reg: Phase10RegistryShape;

  const git = (...args: string[]): string => gitWithRetry(repo.root, args);

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGeet();
    repo = core.repoForPath(workspaceRepoA())!;
    assert.ok(repo, 'repoA not discovered');
    reg = core.debugRegistry.get('phase10') as Phase10RegistryShape;
    assert.ok(reg, 'phase10 registry missing');
  });

  test('T1: >threshold repo offers fsmonitor+untrackedCache once; enable writes config', async function () {
    this.timeout(60_000);
    const gitVersion = git('--version');
    const m = /(\d+)\.(\d+)/.exec(gitVersion);
    const supportsFsmonitor =
      m !== null &&
      (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 37));
    if (!supportsFsmonitor) {
      this.skip(); // capability-gated feature — nothing to offer on old git
      return;
    }

    process.env['GITTREE_TEST_LARGE_REPO_THRESHOLD'] = '1';
    process.env['GITTREE_TEST_PLAYBOOK_CHOICE'] = 'enable';
    try {
      await reg.offerPlaybook(repo.root);
      assert.strictEqual(git('config', 'core.fsmonitor').trim(), 'true');
      assert.strictEqual(git('config', 'core.untrackedCache').trim(), 'true');

      // One-time: a second offer must not rewrite config (remembered answer).
      git('config', '--unset', 'core.fsmonitor');
      await reg.offerPlaybook(repo.root);
      assert.throws(() => git('config', 'core.fsmonitor'), 'second offer must be a no-op');
    } finally {
      delete process.env['GITTREE_TEST_LARGE_REPO_THRESHOLD'];
      delete process.env['GITTREE_TEST_PLAYBOOK_CHOICE'];
      try {
        git('fsmonitor--daemon', 'stop');
      } catch {
        // daemon never started — fine
      }
      try {
        git('config', '--unset', 'core.fsmonitor');
      } catch {
        // already unset
      }
      try {
        git('config', '--unset', 'core.untrackedCache');
      } catch {
        // already unset
      }
      await repo.refresher.refreshNow();
    }
  });
});

/** P10-T3: onboarding — playground generator + walkthrough plumbing. */
suite('P10 onboarding — playground generator', () => {
  let reg: Phase10RegistryShape;
  const target = path.join(os.tmpdir(), `gittree-e2e-playground-${process.pid}`);

  suiteSetup(async function () {
    this.timeout(60_000);
    const core = await activateGeet();
    reg = core.debugRegistry.get('phase10') as Phase10RegistryShape;
    assert.ok(reg, 'phase10 registry missing');
  });

  suiteTeardown(() => {
    // .git objects carry the readonly bit on Windows — plain rmSync EPERMs.
    if (!fs.existsSync(target)) return;
    const clearReadonly = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) clearReadonly(full);
        else fs.chmodSync(full, 0o666);
      }
    };
    clearReadonly(target);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  });

  test('T3: generates a walkthrough-shaped repo — history, pending edit, conflicting branch', async function () {
    this.timeout(60_000);
    process.env['GITTREE_TEST_PLAYGROUND_DIR'] = target;
    try {
      const dir = await reg.generatePlayground();
      assert.strictEqual(dir, target);

      const git = (...args: string[]): string => gitWithRetry(target, args);
      // main has 3 commits and blame-worthy history…
      assert.strictEqual(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
      const log = git('log', '--oneline').trim().split('\n');
      assert.strictEqual(log.length, 3, `main history: ${log.join(' | ')}`);
      // …and the pending edit for the user's first commit.
      assert.match(git('status', '--porcelain'), /^ M NOTES\.md/m);

      // Walkthrough order: the first-commit exercise cleans the worktree…
      git('add', 'NOTES.md');
      git('commit', '-m', 'my first commit');

      // …then the conflict exercise: rebasing feature/polish onto main must
      // conflict, specifically on src/greeting.js.
      git('checkout', 'feature/polish');
      try {
        assert.throws(
          () => git('rebase', 'main'),
          /conflict|could not apply|patch failed|failed/i,
          'rebase onto main must conflict',
        );
        assert.match(git('status', '--porcelain'), /^(UU|AA) src\/greeting\.js/m);
      } finally {
        try {
          git('rebase', '--abort');
        } catch {
          // no rebase in progress — the throw happened before conflict state
        }
        git('checkout', 'main');
      }
      // Non-empty target refused (no clobbering).
      assert.strictEqual(await reg.generatePlayground(), undefined);
    } finally {
      delete process.env['GITTREE_TEST_PLAYGROUND_DIR'];
    }
  });

  test('T3: walkthrough + onboarding commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of ['gittree.openWalkthrough', 'gittree.generatePlayground']) {
      assert.ok(all.includes(cmd), `${cmd} missing`);
    }
  });
});

/** P10-T4: telemetry gates + queue instrumentation + error UX. */
suite('P10 telemetry & error UX', () => {
  let core: Core;
  let repo: RepoHandle;
  let reg: Phase10RegistryShape;

  const KINDS = [
    'index-lock',
    'would-overwrite-checkout',
    'merge-conflict',
    'auth',
    'not-fast-forward',
    'no-upstream',
    'unknown',
  ];

  suiteSetup(async function () {
    this.timeout(60_000);
    core = await activateGeet();
    repo = core.repoForPath(workspaceRepoA())!;
    reg = core.debugRegistry.get('phase10') as Phase10RegistryShape;
    assert.ok(typeof reg.telemetryEvents === 'function', 'T4 registry hooks missing');
  });

  test('T4: double gate — nothing sends until env AND setting allow; schema strips leaks', async function () {
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('gittree');
    try {
      // Setting off (default): blocked even with the env gate forced open.
      process.env['GITTREE_TEST_TELEMETRY_ENV'] = '1';
      assert.strictEqual(reg.sendTelemetry('activation', { syncBucket: 'lt100ms' }), false);

      await cfg.update('telemetry.enabled', true, vscode.ConfigurationTarget.Global);
      assert.strictEqual(reg.sendTelemetry('activation', { syncBucket: 'lt100ms' }), true);

      // Schema: unknown events refused, path-shaped values stripped.
      assert.strictEqual(reg.sendTelemetry('made.up.event', { x: 1 }), false);
      assert.strictEqual(
        reg.sendTelemetry('op.errorKind', { kind: 'C:\\Users\\alice\\repo' }),
        true,
      );
      const events = reg.telemetryEvents();
      const last = events[events.length - 1]!;
      assert.strictEqual(last.name, 'op.errorKind');
      assert.strictEqual(last.props['kind'], undefined, 'path value must be stripped');

      // Queue instrumentation: a real mutation lands an op.duration event.
      const before = reg.telemetryEvents().length;
      await repo.queue.enqueue({
        label: 'telemetry probe',
        kind: 'mutate',
        run: () => Promise.resolve(),
      });
      const after = reg.telemetryEvents();
      const durations = after.slice(before).filter((e) => e.name === 'op.duration');
      assert.strictEqual(durations.length, 1);
      assert.match(durations[0]!.props['bucket'] ?? '', /^(lt100ms|lt400ms|lt1s|lt5s|ge5s)$/);

      // Env gate closes → blocked again despite the setting.
      delete process.env['GITTREE_TEST_TELEMETRY_ENV'];
      if (!vscode.env.isTelemetryEnabled) {
        assert.strictEqual(reg.sendTelemetry('activation', { syncBucket: 'lt100ms' }), false);
      }
    } finally {
      delete process.env['GITTREE_TEST_TELEMETRY_ENV'];
      await cfg.update('telemetry.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('T4: every GitError kind has distinct, actionable dialog copy', () => {
    const copies = KINDS.map((k) => reg.errorCopy(k));
    for (const [i, copy] of copies.entries()) {
      assert.ok(copy.length > 40, `${KINDS[i]} copy too thin: "${copy}"`);
    }
    assert.strictEqual(new Set(copies).size, KINDS.length, 'copies must be distinct');
  });

  test('T4: pre-filled issue URL carries environment but no raw paths', async () => {
    const url = reg.buildIssueUrl('auth');
    assert.ok(url.startsWith('https://github.com/ntson9p/git-tree/issues/new?'));
    const decoded = decodeURIComponent(url).replaceAll('+', ' ');
    assert.ok(decoded.includes('error kind: auth'));
    assert.ok(decoded.includes('Geet: '));
    assert.ok(decoded.includes('capabilities: '));
    // The trace tail references workspace repos by absolute path — all of
    // that must have been hashed away.
    assert.ok(!decoded.includes(repo.root), 'repo root leaked');
    assert.ok(!/gittree-ws-/i.test(decoded), 'fixture workspace path leaked');
    assert.ok(await isCommandRegistered('gittree.reportIssue'));
  });
});

async function isCommandRegistered(id: string): Promise<boolean> {
  return (await vscode.commands.getCommands(true)).includes(id);
}
