/**
 * POST-P14cw: the Rebase dialog's Interactive opened nothing. It handed
 * `geet.rebase.interactive` a repository and a new base, and the command
 * looked only for commits picked in the Log. The two are told apart by shape.
 */
import { describe, expect, it } from 'vitest';
import { isRebaseOntoArgs } from '../../../src/rewrite/rebase/rebaseOnto';

describe('isRebaseOntoArgs', () => {
  it('takes what the Rebase dialog sends, with or without From', () => {
    expect(isRebaseOntoArgs({ repoRoot: 'C:\\w\\api', onto: 'main' })).toBe(true);
    expect(isRebaseOntoArgs({ repoRoot: '/w/api', onto: 'origin/main', from: 'v1.2' })).toBe(true);
  });

  it('leaves what the Log sends to the Log’s path', () => {
    expect(isRebaseOntoArgs({ sha: 'a'.repeat(40) })).toBe(false);
    expect(isRebaseOntoArgs({ shas: ['a'.repeat(40), 'b'.repeat(40)] })).toBe(false);
    // A Log row knows its repository too, but names no new base.
    expect(isRebaseOntoArgs({ repoRoot: '/w/api', sha: 'a'.repeat(40) })).toBe(false);
  });

  it('refuses nothing, other types, and a From that is not text', () => {
    expect(isRebaseOntoArgs(undefined)).toBe(false);
    expect(isRebaseOntoArgs(null)).toBe(false);
    expect(isRebaseOntoArgs('main')).toBe(false);
    expect(isRebaseOntoArgs({ repoRoot: '/w/api', onto: 42 })).toBe(false);
    expect(isRebaseOntoArgs({ repoRoot: '/w/api', onto: 'main', from: 7 })).toBe(false);
  });
});
