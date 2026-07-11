import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  branchy,
  conflictBasic,
  FixtureRepo,
  linear,
  midRebase,
} from '../../fixtures/fixtureRepo';
import { detectInProgressOp } from '../../../src/core/model/inProgressOp';
import { parseStatusV2 } from '../../../src/core/git/parsers/statusV2';
import { activateGitTree, workspaceRepoA } from '../setup';

/**
 * P0-T10: the fixture builder and canned histories, exercised on the CI
 * matrix, plus the sample "activate → model has HEAD" acceptance test.
 */
suite('P0-T10 test harness & fixture repos', () => {
  const repos: FixtureRepo[] = [];
  suiteTeardown(() => {
    for (const r of repos) r.dispose();
  });

  test('sample acceptance: activate → model has HEAD', async function () {
    this.timeout(30_000);
    const core = await activateGitTree();
    const repo = core.repoForPath(workspaceRepoA());
    assert.ok(repo, 'workspace repoA not discovered');
    assert.match(repo.model.snapshot.headSha ?? '', /^[0-9a-f]{40}$/);
  });

  test('linear(200) builds 200 commits fast', function () {
    this.timeout(30_000);
    const repo = linear(200);
    repos.push(repo);
    const count = Number.parseInt(repo.git('rev-list', '--count', 'HEAD').trim(), 10);
    assert.strictEqual(count, 200);
    assert.ok(fs.existsSync(path.join(repo.root, 'file.txt')), 'worktree not materialized');
  });

  test('branchy(300) contains real two-parent merges', function () {
    this.timeout(60_000);
    const repo = branchy(300);
    repos.push(repo);
    const total = Number.parseInt(repo.git('rev-list', '--count', 'HEAD').trim(), 10);
    assert.ok(total >= 290, `expected ~300 commits, got ${total}`);
    const merges = Number.parseInt(repo.git('rev-list', '--count', '--merges', 'HEAD').trim(), 10);
    assert.ok(merges >= 20, `expected many merges, got ${merges}`);
  });

  test('conflict-basic leaves UU entries and MERGE_HEAD', function () {
    this.timeout(30_000);
    const repo = conflictBasic();
    repos.push(repo);
    const status = repo.git('status', '--porcelain=v2', '-z', '--branch');
    const { entries } = parseStatusV2(status);
    assert.ok(entries.some((e) => e.kind === 'unmerged'), 'no unmerged entries');
    assert.strictEqual(detectInProgressOp(repo.gitDir)?.kind, 'merge');
  });

  test('mid-rebase leaves rebase state detectable', function () {
    this.timeout(30_000);
    const repo = midRebase();
    repos.push(repo);
    const op = detectInProgressOp(repo.gitDir);
    assert.ok(op, 'no in-progress op detected');
    assert.ok(op.kind === 'rebase-interactive' || op.kind === 'rebase-apply', `got ${op.kind}`);
  });

  test('builder cases: unicode paths, CRLF preservation, renames, detach', function () {
    this.timeout(30_000);
    const repo = FixtureRepo.create();
    repos.push(repo);
    repo.commit('base', { 'a.txt': 'one\n' });

    const unicodeFiles = repo.addUnicodeFiles();
    const listed = repo.git('-c', 'core.quotepath=false', 'ls-files');
    for (const f of unicodeFiles) assert.ok(listed.includes(f), `missing ${f}`);

    repo.addCrlfFile('win.txt');
    const raw = fs.readFileSync(path.join(repo.root, 'win.txt'), 'utf8');
    assert.ok(raw.includes('\r\n'), 'CRLF content was normalized');

    repo.rename('a.txt', 'b.txt');
    const nameStatus = repo.git('diff', '--name-status', '-M', 'HEAD~1', 'HEAD');
    assert.match(nameStatus, /^R100\s+a\.txt\s+b\.txt/m);

    repo.detach();
    const status = parseStatusV2(repo.git('status', '--porcelain=v2', '-z', '--branch'));
    assert.strictEqual(status.header.detached, true);
  });

  test('dispose removes scratch dirs (retry-based on Windows)', function () {
    this.timeout(30_000);
    const repo = FixtureRepo.create();
    repo.commit('x', { 'f.txt': 'x\n' });
    const root = repo.root;
    repo.dispose();
    assert.ok(!fs.existsSync(root), 'scratch dir still exists after dispose');
  });
});
