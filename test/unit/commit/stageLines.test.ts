/**
 * POST-QA F1: line staging against real git — the right lines, in the right
 * place, with the blob's line endings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selectChanges, stageWorktreeLines, unstageIndexLines } from '../../../src/commit/staging/stageLines';
import { GitExecutorImpl } from '../../../src/core/git/executor';
import { correspondingChanges, type LineChange } from '../../../src/core/patch/patchBuilder';
import { FixtureRepo } from '../../fixtures/fixtureRepo';

const git = new GitExecutorImpl({ gitPath: 'git', version: '2.43.0' });

const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.dispose();
});

function fixture(files: Record<string, string>): FixtureRepo {
  const repo = FixtureRepo.create({ prefix: 'geet-stagelines-' });
  repos.push(repo);
  repo.commit('base', files);
  return repo;
}

const index = (repo: FixtureRepo, rel: string): string => repo.git('show', `:0:${rel}`);
const all = (fresh: readonly LineChange[]): readonly LineChange[] => fresh;

describe('stageWorktreeLines', () => {
  it('stages the bottom change where it is, with three unstaged lines above it', async () => {
    // The QA repro: three lines added at the top stay unstaged; the line typed
    // above the closing brace is staged, above the closing brace.
    const repo = fixture({ 'task.ts': 'export function f() {\n  return 1;\n}\n' });
    const worktree = '// a\n// b\n// c\nexport function f() {\n  return 1;\n  // bottom\n}\n';
    fs.writeFileSync(path.join(repo.root, 'task.ts'), worktree);
    const o = await stageWorktreeLines(git, repo.root, 'task.ts', worktree, (fresh) =>
      fresh.filter((c) => c.modifiedStartLineNumber > 3),
    );
    expect(o).toBe('done');
    expect(index(repo, 'task.ts')).toBe('export function f() {\n  return 1;\n  // bottom\n}\n');
  });

  it('matches a change measured against HEAD onto the index', async () => {
    const repo = fixture({ 'a.txt': 'one\ntwo\nthree\nfour\n' });
    // Staged already: TWO. Unstaged on top of it: FOUR.
    fs.writeFileSync(path.join(repo.root, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    repo.git('add', 'a.txt');
    const worktree = 'one\nTWO\nthree\nFOUR\n';
    fs.writeFileSync(path.join(repo.root, 'a.txt'), worktree);
    // The bar the user clicked, measured HEAD → worktree: line 4.
    const clicked: LineChange = {
      originalStartLineNumber: 4,
      originalEndLineNumber: 4,
      modifiedStartLineNumber: 4,
      modifiedEndLineNumber: 4,
    };
    const o = await stageWorktreeLines(git, repo.root, 'a.txt', worktree, (fresh) => correspondingChanges(fresh, clicked));
    expect(o).toBe('done');
    expect(index(repo, 'a.txt')).toBe(worktree);
  });

  it('says so when the picked lines already match the index', async () => {
    const repo = fixture({ 'a.txt': 'one\ntwo\n' });
    fs.writeFileSync(path.join(repo.root, 'a.txt'), 'one\nTWO\n');
    repo.git('add', 'a.txt');
    const clicked: LineChange = {
      originalStartLineNumber: 2,
      originalEndLineNumber: 2,
      modifiedStartLineNumber: 2,
      modifiedEndLineNumber: 2,
    };
    const o = await stageWorktreeLines(git, repo.root, 'a.txt', 'one\nTWO\n', (fresh) => correspondingChanges(fresh, clicked));
    expect(o).toBe('nothing');
  });

  it('reports a file with no index entry', async () => {
    const repo = fixture({ 'a.txt': 'one\n' });
    fs.writeFileSync(path.join(repo.root, 'new.txt'), 'hello\n');
    expect(await stageWorktreeLines(git, repo.root, 'new.txt', 'hello\n', all)).toBe('notInIndex');
  });

  it('stages LF lines from a CRLF checkout (core.autocrlf=true)', async () => {
    const repo = fixture({ 'w.txt': 'a\nb\nc\nd\n' });
    repo.git('config', 'core.autocrlf', 'true');
    // What a checkout under autocrlf=true leaves in the working tree.
    const worktree = 'a\r\nb\r\nNEW\r\nc\r\nd\r\nEND\r\n';
    fs.writeFileSync(path.join(repo.root, 'w.txt'), worktree);
    const o = await stageWorktreeLines(git, repo.root, 'w.txt', worktree, (fresh) => {
      // Two real changes, not one change per line.
      expect(fresh).toHaveLength(2);
      return [fresh[0]!];
    });
    expect(o).toBe('done');
    const staged = index(repo, 'w.txt');
    expect(staged).toBe('a\nb\nNEW\nc\nd\n');
    expect(staged).not.toContain('\r');
  });

  it('stages a selection, the way Stage Selected Ranges asks', async () => {
    const repo = fixture({ 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' });
    const worktree = 'new0\nl1\nl2\nL3\nl4\nl5\nnew6\n';
    fs.writeFileSync(path.join(repo.root, 'a.txt'), worktree);
    // 0-based editor line 3 is "L3".
    const o = await stageWorktreeLines(git, repo.root, 'a.txt', worktree, (fresh) =>
      selectChanges(fresh, [{ startLine: 3, endLine: 3 }]),
    );
    expect(o).toBe('done');
    expect(index(repo, 'a.txt')).toBe('l1\nl2\nL3\nl4\nl5\n');
  });
});

describe('unstageIndexLines', () => {
  it('takes only the picked staged change out of the index', async () => {
    const repo = fixture({ 'a.txt': 'a\nb\nc\nd\ne\n' });
    fs.writeFileSync(path.join(repo.root, 'a.txt'), 'a\nNEW1\nNEW2\nb\nc\nd\nINS\ne\n');
    repo.git('add', 'a.txt');
    // 0-based index line 6 is "INS".
    const o = await unstageIndexLines(git, repo.root, 'a.txt', (fresh) => selectChanges(fresh, [{ startLine: 6, endLine: 6 }]));
    expect(o).toBe('done');
    expect(index(repo, 'a.txt')).toBe('a\nNEW1\nNEW2\nb\nc\nd\ne\n');
    // The working tree is never touched.
    expect(fs.readFileSync(path.join(repo.root, 'a.txt'), 'utf8')).toBe('a\nNEW1\nNEW2\nb\nc\nd\nINS\ne\n');
  });

  it('treats a file HEAD does not have as empty there', async () => {
    const repo = fixture({ 'a.txt': 'x\n' });
    fs.writeFileSync(path.join(repo.root, 'n.txt'), 'one\ntwo\n');
    repo.git('add', 'n.txt');
    const o = await unstageIndexLines(git, repo.root, 'n.txt', all);
    expect(o).toBe('done');
    expect(index(repo, 'n.txt')).toBe('');
  });

  it('says so when nothing on those lines is staged', async () => {
    const repo = fixture({ 'a.txt': 'x\ny\n' });
    expect(await unstageIndexLines(git, repo.root, 'a.txt', all)).toBe('nothing');
  });
});
