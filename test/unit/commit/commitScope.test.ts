/**
 * POST-P14by: a commit across several repositories, narrowed to those asked for
 * (the Repositories panel's `⋯` with some in view), amends or lets speak only a
 * repository it is committing, never the one the message was typed against
 * when that one lies outside them.
 */
import { describe, expect, it } from 'vitest';
import { amendTarget, singleCommitRepo } from '../../../src/commit/commitScope';

const every = (): boolean => true;
const only =
  (...names: string[]) =>
  (repo: string): boolean =>
    names.includes(repo);

describe('amendTarget', () => {
  it("amends the message's repository when it is being committed and its Amend is ticked", () => {
    expect(amendTarget('api', ['api', 'web'], every, only('api'))).toBe('api');
    // Ticked on both: the message's first.
    expect(amendTarget('api', ['web', 'api'], every, only('api', 'web'))).toBe('api');
  });

  it("else the first being committed whose Amend is, as before (an Amend armed elsewhere by its own command)", () => {
    expect(amendTarget('api', ['api', 'web', 'docs'], every, only('web', 'docs'))).toBe('web');
    expect(amendTarget('api', ['api', 'web'], every, only())).toBeUndefined();
  });

  it("out of the repositories asked for, the message's Amend amends nothing", () => {
    // Typed against api, Amend ticked there; the ⋯ commits web and docs.
    expect(amendTarget('api', ['web', 'docs'], only('web', 'docs'), only('api'))).toBeUndefined();
    // One of those being committed has its own Amend ticked: that one, as before.
    expect(amendTarget('api', ['web', 'docs'], only('web', 'docs'), only('api', 'docs'))).toBe('docs');
  });
});

describe('singleCommitRepo', () => {
  it('commits the one repository with anything ticked', () => {
    expect(singleCommitRepo('api', ['web'], ['api', 'web'], every)).toBe('web');
    expect(singleCommitRepo('api', ['web'], ['web', 'docs'], only('web', 'docs'))).toBe('web');
  });

  it("with none ticked, lets the message's repository speak, as before, when it is asked for", () => {
    expect(singleCommitRepo('api', [], ['api', 'web'], every)).toBe('api');
    expect(singleCommitRepo('web', [], ['api', 'web'], only('api', 'web'))).toBe('web');
  });

  it('with none ticked and the message typed elsewhere, the first repository asked for speaks', () => {
    expect(singleCommitRepo('api', [], ['web', 'docs'], only('web', 'docs'))).toBe('web');
  });
});
