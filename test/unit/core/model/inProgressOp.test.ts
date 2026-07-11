import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectInProgressOp } from '../../../../src/core/model/inProgressOp';

const roots: string[] = [];

/** Builds a fake .git dir from a { relPath: content|null(dir) } spec. */
function gitDir(spec: Record<string, string | null>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-op-'));
  roots.push(dir);
  for (const [rel, content] of Object.entries(spec)) {
    const p = path.join(dir, rel);
    if (content === null) {
      fs.mkdirSync(p, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  return dir;
}

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* tmp */
    }
  }
});

describe('detectInProgressOp', () => {
  it('detects nothing in a clean .git', () => {
    expect(detectInProgressOp(gitDir({ HEAD: 'ref: refs/heads/main\n' }))).toBeUndefined();
  });

  it('detects an interactive rebase with step/total/branch', () => {
    const op = detectInProgressOp(
      gitDir({
        'rebase-merge/msgnum': '2\n',
        'rebase-merge/end': '5\n',
        'rebase-merge/head-name': 'refs/heads/feature/topic\n',
        'rebase-merge/interactive': '',
      }),
    );
    expect(op).toEqual({
      kind: 'rebase-interactive',
      step: 2,
      total: 5,
      headName: 'feature/topic',
    });
  });

  it('tolerates a rebase-merge dir still being set up (no msgnum yet)', () => {
    const op = detectInProgressOp(gitDir({ 'rebase-merge/': null }));
    expect(op?.kind).toBe('rebase-interactive');
    expect(op?.step).toBeUndefined();
  });

  it('detects an am/apply rebase', () => {
    const op = detectInProgressOp(
      gitDir({
        'rebase-apply/next': '1\n',
        'rebase-apply/last': '3\n',
        'rebase-apply/head-name': 'refs/heads/main\n',
      }),
    );
    expect(op).toEqual({ kind: 'rebase-apply', step: 1, total: 3, headName: 'main' });
  });

  it('rebase wins over a stray MERGE_HEAD', () => {
    const op = detectInProgressOp(
      gitDir({ 'rebase-merge/msgnum': '1', 'rebase-merge/end': '2', MERGE_HEAD: 'a'.repeat(40) }),
    );
    expect(op?.kind).toBe('rebase-interactive');
  });

  it('detects a merge', () => {
    const op = detectInProgressOp(gitDir({ MERGE_HEAD: 'a'.repeat(40) + '\n' }));
    expect(op).toEqual({ kind: 'merge' });
  });

  it('detects a single cherry-pick (no sequencer)', () => {
    const op = detectInProgressOp(gitDir({ CHERRY_PICK_HEAD: 'b'.repeat(40) + '\n' }));
    expect(op).toEqual({ kind: 'cherry-pick' });
  });

  it('detects a multi-pick with sequencer todo count', () => {
    const op = detectInProgressOp(
      gitDir({
        CHERRY_PICK_HEAD: 'b'.repeat(40) + '\n',
        'sequencer/todo': 'pick 1111111 first\npick 2222222 second\n',
      }),
    );
    expect(op).toEqual({ kind: 'cherry-pick', todoRemaining: 2 });
  });

  it('detects a revert', () => {
    const op = detectInProgressOp(gitDir({ REVERT_HEAD: 'c'.repeat(40) + '\n' }));
    expect(op).toEqual({ kind: 'revert' });
  });

  it('classifies a bare sequencer between steps by its first todo line', () => {
    const pick = detectInProgressOp(gitDir({ 'sequencer/todo': 'pick 1111111 next one\n' }));
    expect(pick).toEqual({ kind: 'cherry-pick', todoRemaining: 1 });
    const revert = detectInProgressOp(gitDir({ 'sequencer/todo': 'revert 2222222 undo\n' }));
    expect(revert).toEqual({ kind: 'revert', todoRemaining: 1 });
  });
});
