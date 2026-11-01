import { describe, expect, it } from 'vitest';
import { pushSpecTargetRef } from '../../../src/scm/dialogs/pushSpecParser';

/**
 * `remote.<name>.push` read as IntelliJ's `GitPushSpecParser` reads it — the
 * cases of its own `GitPushSpecParserTest`.
 */
const target = (branch: string, ...specs: string[]): string | undefined => pushSpecTargetRef(branch, specs);

describe('pushSpecTargetRef', () => {
  it('refuses specs whose stars are not at the end of both sides', () => {
    expect(target('master', 'HEAD:refs/heads/*')).toBeUndefined();
    expect(target('master', 'refs/heads/*:refs/for/master')).toBeUndefined();
    expect(target('master', 'refs/for/*/branch:refs/for/*')).toBeUndefined();
    expect(target('master', 'refs/heads/*:refs/*/for')).toBeUndefined();
    expect(target('master', 'refs/for/*:refs/remotes/origin/*')).toBeUndefined();
  });

  it('accepts a spec without stars, with both at the end, or a sole star', () => {
    expect(target('master', 'HEAD:refs/for/master')).toBe('refs/for/master');
    expect(target('master', '+refs/heads/*:refs/remotes/origin/*')).toBe('refs/remotes/origin/master');
    expect(target('master', '*:refs/remotes/origin/*')).toBeDefined();
    expect(target('master', '*:*')).toBe('refs/heads/master');
  });

  it('substitutes the branch, slashes and all, for the star', () => {
    expect(target('qa/ticket1', 'refs/heads/qa/*:refs/remotes/origin/qa/*')).toBe(
      'refs/remotes/origin/qa/ticket1',
    );
  });

  it('takes the spec that matches among several, or none', () => {
    const specs = ['refs/heads/qa/*:refs/remotes/origin/qa/*', '+refs/heads/master:refs/remotes/origin/master'];
    expect(target('qa/ticket1', ...specs)).toBe('refs/remotes/origin/qa/ticket1');
    expect(target('master', ...specs)).toBe('refs/remotes/origin/master');
    expect(target('feature', ...specs)).toBeUndefined();
  });

  it('lets an exact match win over an earlier wildcard', () => {
    expect(target('master', 'refs/heads/*:refs/heads/pr/*', 'refs/heads/master:refs/heads/qa/master')).toBe(
      'refs/heads/qa/master',
    );
    expect(target('qa/ticket1', 'refs/heads/*:refs/heads/pr/*', 'refs/heads/master:refs/heads/qa/master')).toBe(
      'refs/heads/pr/qa/ticket1',
    );
  });

  it('does not match a wildcard against a short name', () => {
    expect(target('qa/ticket1', 'ma*:refs/heads/ma*')).toBeUndefined();
  });

  it('skips specs that are not `src:dst`', () => {
    expect(target('master', 'refs/heads/master', 'a:b:c', 'HEAD:refs/for/main')).toBe('refs/for/main');
  });
});
