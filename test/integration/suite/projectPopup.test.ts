import * as assert from 'node:assert';
import * as path from 'node:path';
import type { Core, RepoHandle } from '../../../src/core/core';
import type { Phase02Registry } from '../../../src/branches/register';
import type { BranchAction, BranchActionContext } from '../../../src/branches/branchActions';
import {
  applicableCommonActions,
  buildCommonActionItems,
  buildPopupItems,
  buildProjectPopupItems,
  COMMON_ACTIONS,
  commonActionLabel,
  commonContexts,
  commonRefNames,
  HUB_VERBS,
  repoRowDescription,
  runCommonAction,
  type CommonRef,
  type RepoRow,
} from '../../../src/branches/branchesPopup';
import type { NotificationsRegistry } from '../../../src/ui/notify';
import { repoLabels } from '../../../src/core/util/repoLabels';
import { activateGeet, gitWithRetry, waitFor, workspaceRepoD, workspaceRepoE } from '../setup';

/**
 * POST-P14p — the branches popup's **project level**, which a multi-root
 * workspace opens at.
 *
 * The QuickPick itself cannot be driven from a test (the P13-T5 suite says the
 * same), so these target the pure halves it is assembled from, plus the one
 * live behaviour that is drivable and load-bearing: `runCommonAction` really
 * running one operation over several roots.
 */
suite('POST-P14p project-level branches popup', () => {
  let core: Core;
  let p2: Phase02Registry;
  let repoD: RepoHandle;
  let repoE: RepoHandle;

  const cli = (cwd: string, ...args: string[]): string => gitWithRetry(cwd, args);
  const headOf = (repo: RepoHandle): string =>
    cli(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

  const COMMON_BRANCH = 'p14p/common';

  suiteSetup(async function () {
    this.timeout(90_000);
    core = await activateGeet();
    p2 = core.debugRegistry.get('phase02') as Phase02Registry;
    repoD = core.repoForPath(workspaceRepoD())!;
    repoE = core.repoForPath(workspaceRepoE())!;
    assert.ok(p2 && repoD && repoE, 'phase02 registry or repoD/repoE missing');
  });

  const row = (over: Partial<RepoRow> = {}): RepoRow => ({
    root: 'X:/repoA',
    name: 'repoA',
    currentBranch: 'main',
    ...over,
  });

  const projectInput = (over: Partial<Parameters<typeof buildProjectPopupItems>[0]> = {}) => ({
    repos: [row(), row({ root: 'X:/repoB', name: 'repoB', currentBranch: 'develop' })],
    commonLocals: ['develop', 'main'],
    commonRemotes: ['origin/develop'],
    commonTags: ['v1.0'],
    filtering: false,
    showInOut: false,
    ...over,
  });

  // ---- the project level's shape ------------------------------------------

  test('the verbs come first, then a row per repository, then the common refs', () => {
    const items = buildProjectPopupItems(projectInput());
    const firstVerb = items.findIndex((i) => i.command !== undefined);
    const firstRepo = items.findIndex((i) => i.repoRoot !== undefined);
    const firstCommon = items.findIndex((i) => i.common !== undefined);
    assert.ok(firstVerb >= 0 && firstRepo >= 0 && firstCommon >= 0, 'a whole section is missing');
    assert.ok(firstVerb < firstRepo, 'the verbs must precede the repository rows');
    assert.ok(firstRepo < firstCommon, 'the repository rows must precede the common refs');
    // The same verbs as the repository level — one hub, two scopes.
    assert.deepStrictEqual(
      items.filter((i) => i.command !== undefined).map((i) => i.command),
      HUB_VERBS.map((v) => v.command),
    );
  });

  test('every repository is listed, named, and carries its current branch', () => {
    const items = buildProjectPopupItems(projectInput());
    const repos = items.filter((i) => i.repoRoot !== undefined);
    assert.deepStrictEqual(repos.map((i) => i.repoRoot), ['X:/repoA', 'X:/repoB']);
    assert.ok(repos[0]!.label.includes('repoA'), `label: ${repos[0]!.label}`);
    assert.strictEqual(repos[0]!.description, 'main');
    assert.strictEqual(repos[1]!.description, 'develop');
  });

  test('the three common sections carry their kind, so the actions can differ', () => {
    const items = buildProjectPopupItems(projectInput());
    const commons = items.filter((i) => i.common !== undefined).map((i) => i.common!);
    assert.deepStrictEqual(commons, [
      { name: 'develop', kind: 'local' },
      { name: 'main', kind: 'local' },
      { name: 'origin/develop', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
    ]);
  });

  test('typing hides the verbs but keeps the repositories and common refs searchable', () => {
    const items = buildProjectPopupItems(projectInput({ filtering: true }));
    assert.strictEqual(items.filter((i) => i.command !== undefined).length, 0);
    assert.ok(items.some((i) => i.repoRoot !== undefined), 'repository rows must survive a filter');
    assert.ok(items.some((i) => i.common !== undefined), 'common rows must survive a filter');
  });

  test('a detached root says so instead of naming a branch it does not have', () => {
    assert.strictEqual(
      repoRowDescription(row({ detached: true, headSha: 'abcdef1234' }), false),
      'detached at abcdef1',
    );
    assert.strictEqual(
      repoRowDescription(row({ ahead: 2, behind: 1 }), true),
      'main · ↓1 · ↑2',
    );
    // The counts are the toggle's; off, the row is just the branch.
    assert.strictEqual(repoRowDescription(row({ ahead: 2, behind: 1 }), false), 'main');
  });

  // ---- what "common" means -------------------------------------------------

  test('common means present in EVERY root, not in any of them', () => {
    assert.deepStrictEqual(
      commonRefNames([
        ['main', 'develop', 'only-a'],
        ['main', 'develop', 'only-b'],
        ['main', 'only-c'],
      ]),
      ['main'],
    );
  });

  test('one root with none of that kind leaves nothing common', () => {
    assert.deepStrictEqual(commonRefNames([['main'], []]), []);
    assert.deepStrictEqual(commonRefNames([]), []);
  });

  test('a single root is trivially common with itself, sorted', () => {
    assert.deepStrictEqual(commonRefNames([['b', 'a']]), ['a', 'b']);
  });

  // ---- which operations a common ref can carry across roots ----------------

  const fakeAction = (id: string, applies: (ctx: BranchActionContext) => boolean): BranchAction => ({
    id,
    label: () => id,
    applies,
    run: () => Promise.resolve(),
  });

  test('an action offered by only some roots is still offered, and says how many', () => {
    const contexts = commonContexts([repoD, repoE], { name: 'x', kind: 'local' });
    const actions = [fakeAction('checkout', (ctx) => ctx.repo === repoD)];
    const offerable = applicableCommonActions(
      [{ id: 'checkout', verb: 'Checkout', kinds: ['local'] }],
      actions,
      { name: 'x', kind: 'local' },
      contexts,
    );
    assert.strictEqual(offerable.length, 1, 'partial applicability must not hide the row');
    assert.strictEqual(offerable[0]!.appliesIn, 1);
    assert.strictEqual(
      buildCommonActionItems(offerable, 2)[0]!.label,
      'Checkout in 1 of 2 repositories',
    );
  });

  test('an action no root can run is not offered at all', () => {
    const contexts = commonContexts([repoD, repoE], { name: 'x', kind: 'local' });
    const offerable = applicableCommonActions(
      [{ id: 'checkout', verb: 'Checkout', kinds: ['local'] }],
      [fakeAction('checkout', () => false)],
      { name: 'x', kind: 'local' },
      contexts,
    );
    assert.deepStrictEqual(offerable, []);
  });

  test('the kind gates the verb: pull belongs to a remote row, update to a local one', () => {
    const actions = p2.actions;
    const localCtx = commonContexts([repoD, repoE], { name: 'main', kind: 'local' });
    const remote: CommonRef = { name: 'origin/main', kind: 'remote' };
    const remoteCtx = commonContexts([repoD, repoE], remote);

    const localIds = applicableCommonActions(
      COMMON_ACTIONS,
      actions,
      { name: 'main', kind: 'local' },
      localCtx,
    ).map((o) => o.spec.id);
    const remoteIds = applicableCommonActions(COMMON_ACTIONS, actions, remote, remoteCtx).map(
      (o) => o.spec.id,
    );

    assert.ok(!localIds.includes('pullIntoCurrent'), 'pull is a remote-row verb');
    assert.ok(!remoteIds.includes('update'), 'update is a local-branch verb');
    // And nothing that would prompt once per root is ever offered here (D27).
    for (const ids of [localIds, remoteIds]) {
      for (const banned of ['newFrom', 'rename', 'delete', 'deleteOnRemote', 'newWorktree']) {
        assert.ok(!ids.includes(banned), `${banned} would prompt once per repository`);
      }
    }
  });

  test('every COMMON_ACTIONS id is a real registry action', () => {
    for (const spec of COMMON_ACTIONS) {
      assert.ok(
        p2.actions.some((a) => a.id === spec.id),
        `${spec.id} is not in the branch-action registry`,
      );
    }
  });

  test('the label tells the truth about how many roots it will touch', () => {
    assert.strictEqual(commonActionLabel('Checkout', 7, 7), 'Checkout in all 7 repositories');
    assert.strictEqual(commonActionLabel('Checkout', 4, 7), 'Checkout in 4 of 7 repositories');
  });

  // ---- the repository level, one level down --------------------------------

  test('a repository popup inside a project offers Back before any drill-in', () => {
    const base = {
      current: undefined,
      locals: [],
      remotes: [],
      tags: [],
      recent: [] as string[],
      favorites: new Set<string>(),
      prefix: '',
      filtering: false,
      showInOut: false,
    };
    assert.ok(
      !buildPopupItems(base).some((i) => i.back === true),
      'a single-root popup at the top level has nowhere to go back to',
    );
    assert.ok(
      buildPopupItems({ ...base, forceBack: true }).some((i) => i.back === true),
      'inside a project, the repository level sits below the project level',
    );
  });

  // ---- the live half -------------------------------------------------------

  test('POST-P14ad: a fan-out stops at the first root whose action reports a failure', async function () {
    this.timeout(30_000);
    const ran: string[] = [];
    // Shaped like `Update`: it reports its own failure and resolves `false`
    // rather than throwing, which is exactly the case that used to slip past.
    const fake: BranchAction = {
      id: 'p14ad/fake-update',
      label: () => 'Fake update',
      applies: () => true,
      run: (ctx) => {
        ran.push(ctx.repo.root);
        return Promise.resolve(ctx.repo === repoD ? false : undefined);
      },
    };
    await runCommonAction([repoD, repoE], { name: 'p14ad/any', kind: 'local' }, [fake], fake.id);
    assert.deepStrictEqual(ran, [repoD.root], 'a root after a failed one must not run');
  });

  test('runCommonAction really runs the operation in every root it applies to', async function () {
    this.timeout(120_000);
    const beforeD = headOf(repoD);
    const beforeE = headOf(repoE);
    for (const repo of [repoD, repoE]) {
      try {
        cli(repo.root, 'branch', COMMON_BRANCH);
      } catch {
        /* left over from a previous run */
      }
      await repo.refresher.refreshNow();
    }
    await waitFor(
      () =>
        [repoD, repoE].every((r) =>
          r.model.snapshot.refs.some((ref) => ref.name === COMMON_BRANCH),
        ),
      30_000,
    );

    try {
      const common: CommonRef = { name: COMMON_BRANCH, kind: 'local' };
      const notes = core.debugRegistry.get('notifications') as NotificationsRegistry;
      notes.clear();
      // The extension's own fan-out, so its notifications are the ones recorded.
      await p2.runCommonAction([repoD, repoE], common, 'checkout');

      await waitFor(() => headOf(repoD) === COMMON_BRANCH && headOf(repoE) === COMMON_BRANCH, 60_000);
      assert.strictEqual(headOf(repoD), COMMON_BRANCH);
      assert.strictEqual(headOf(repoE), COMMON_BRANCH);
      // POST-P14ap: said once for both repositories, as IntelliJ says it.
      // POST-P14ax: and which they are, since it is one run across them.
      const labels = repoLabels(core.repos.map((r) => r.root));
      assert.deepStrictEqual(
        notes.recent().map((n) => n.message),
        [`Checked out ${COMMON_BRANCH} in ${labels.get(repoD.root)} and ${labels.get(repoE.root)}.`],
      );

      // Running it again is a no-op, not a failure: both roots are already
      // there, so `checkout` applies in neither.
      await runCommonAction([repoD, repoE], common, p2.actions, 'checkout');
      assert.strictEqual(headOf(repoD), COMMON_BRANCH);
      assert.strictEqual(headOf(repoE), COMMON_BRANCH);
    } finally {
      cli(repoD.root, 'checkout', beforeD);
      cli(repoE.root, 'checkout', beforeE);
      for (const repo of [repoD, repoE]) {
        try {
          cli(repo.root, 'branch', '-D', COMMON_BRANCH);
        } catch {
          /* already gone */
        }
        await repo.refresher.refreshNow();
      }
    }
    assert.strictEqual(headOf(repoD), beforeD, 'repoD must be handed back as it was found');
    assert.strictEqual(headOf(repoE), beforeE, 'repoE must be handed back as it was found');
  });

  test('a root the action does not apply to is skipped, not attempted', async function () {
    this.timeout(60_000);
    const seen: string[] = [];
    const only = repoD;
    const probe: BranchAction = {
      id: 'probe',
      label: () => 'probe',
      applies: (ctx) => ctx.repo === only,
      run: (ctx) => {
        seen.push(path.basename(ctx.repo.root));
        return Promise.resolve();
      },
    };
    await runCommonAction([repoD, repoE], { name: 'whatever', kind: 'local' }, [probe], 'probe');
    assert.deepStrictEqual(seen, [path.basename(repoD.root)]);
  });

  test('a failing root stops the fan-out rather than half-applying it', async function () {
    this.timeout(60_000);
    const seen: string[] = [];
    const boom: BranchAction = {
      id: 'boom',
      label: () => 'boom',
      applies: () => true,
      run: (ctx) => {
        seen.push(path.basename(ctx.repo.root));
        return Promise.reject(new Error('fatal: refusing\nhint: ignored'));
      },
    };
    await runCommonAction([repoD, repoE], { name: 'whatever', kind: 'local' }, [boom], 'boom');
    assert.deepStrictEqual(
      seen,
      [path.basename(repoD.root)],
      'the second root must not be attempted after the first refuses',
    );
  });
});
