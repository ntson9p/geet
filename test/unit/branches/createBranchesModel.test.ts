import { describe, expect, it } from 'vitest';
import { summarizeNewBranch, type CreateResult } from '../../../src/branches/createBranchesModel';

/**
 * POST-P14ax — the New Branch form's notification once its branch is made in
 * several repositories, in IntelliJ's words, problems first.
 */
const made = (label: string, extra: Partial<Extract<CreateResult, { kind: 'created' }>> = {}): CreateResult => ({
  kind: 'created',
  label,
  checkedOut: true,
  ...extra,
});

describe('summarizeNewBranch', () => {
  it("in one repository, IntelliJ's own sentence", () => {
    expect(summarizeNewBranch('feature/x', 'main', [made('api')]).message).toBe(
      'Checked out new branch feature/x from main.',
    );
    expect(summarizeNewBranch('feature/x', 'HEAD', [made('api', { checkedOut: false })]).message).toBe(
      'Branch feature/x was created.',
    );
  });

  it('in several, where; past four, how many', () => {
    expect(summarizeNewBranch('feature/x', 'main', [made('api'), made('web')]).message).toBe(
      'Checked out new branch feature/x from main in api and web.',
    );
    const five = ['a', 'b', 'c', 'd', 'e'].map((l) => made(l));
    expect(summarizeNewBranch('feature/x', 'origin/main', five).message).toBe(
      'Checked out new branch feature/x from origin/main in 5 repositories.',
    );
    expect(summarizeNewBranch('feature/x', 'HEAD', [made('api'), made('web')]).message).toBe(
      'Branch feature/x was created and checked out in api and web.',
    );
  });

  it('puts a failure first, as a warning, and goes on to the rest', () => {
    const summary = summarizeNewBranch('feature/x', 'main', [
      made('api'),
      { kind: 'failed', label: 'web', reason: 'cannot lock ref' },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.message).toBe("Couldn't create feature/x in web: cannot lock ref. Checked out new branch feature/x from main in api.");
  });

  it('says which repositories have the branch but stayed where they were', () => {
    const summary = summarizeNewBranch('feature/x', 'main', [
      made('api'),
      { kind: 'blocked', label: 'tools', head: 'main', files: ['config.txt'] },
    ]);
    expect(summary.kind).toBe('warning');
    expect(summary.message).toBe(
      'tools stays on main: your local changes to config.txt would be overwritten. feature/x is there, not checked out. Checked out new branch feature/x from main in api.',
    );
  });

  it('says what became of local changes that were in the way', () => {
    expect(summarizeNewBranch('x', 'main', [made('api'), made('tools', { setAside: 'restored' })]).message).toBe(
      'Checked out new branch x from main in api and tools. Your local changes in tools were set aside and put back.',
    );
    const kept = summarizeNewBranch('x', 'main', [made('tools', { setAside: 'kept' })]);
    expect(kept.conflicts).toBe(true);
    expect(kept.kind).toBe('warning');
    expect(summarizeNewBranch('x', 'main', [made('tools', { forced: true })]).message).toBe(
      'Checked out new branch x from main. Your local changes in tools were discarded; Local History has them.',
    );
  });
});
