/**
 * POST-P14by: a commit across several repositories, narrowed to those asked for
 * (the Repositories panel's `⋯` with some in view), amends or lets speak only a
 * repository it is committing, never the one the message was typed against
 * when that one lies outside them.
 */
import { describe, expect, it } from 'vitest';
import { amendTarget, generationScope, singleCommitRepo } from '../../../src/commit/commitScope';

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

  it('with none ticked and the message typed elsewhere, the one asked for with Amend ticked amends (POST-P14ce)', () => {
    // The Commit window narrowed to web and docs, its message box still api's:
    // its Amend is docs', the first it lists, wherever docs is among them.
    expect(singleCommitRepo('api', [], ['web', 'docs'], only('web', 'docs'), only('docs'))).toBe('docs');
    // None armed: the first, as before.
    expect(singleCommitRepo('api', [], ['web', 'docs'], only('web', 'docs'), only())).toBe('web');
    // An Amend armed outside them amends nothing.
    expect(singleCommitRepo('api', [], ['web', 'docs'], only('web', 'docs'), only('api'))).toBe('web');
  });

  it("the message's own repository, asked for, still speaks first, Amend armed elsewhere or not", () => {
    expect(singleCommitRepo('api', [], ['api', 'web'], every, only('web'))).toBe('api');
    // One ticked: that one, whatever is armed.
    expect(singleCommitRepo('api', ['web'], ['api', 'web', 'docs'], every, only('docs'))).toBe('web');
  });
});

/**
 * POST-P14cj, Generate Commit Message: the message is written for the commit a
 * Commit pressed now would make, so its repositories are decided as that
 * commit's are.
 */
describe('generationScope', () => {
  it('describes the one repository with anything ticked, amended if its own Amend is ticked', () => {
    expect(generationScope('api', ['web'], ['api', 'web'], every, only())).toEqual([{ repo: 'web', amend: false }]);
    expect(generationScope('api', ['web'], ['api', 'web'], every, only('web'))).toEqual([{ repo: 'web', amend: true }]);
    // The message's repository has Amend ticked and nothing else: the commit is web's, plain.
    expect(generationScope('api', ['web'], ['api', 'web'], every, only('api'))).toEqual([{ repo: 'web', amend: false }]);
  });

  it("with nothing ticked, describes the repository that would speak: the message's, amended or not", () => {
    expect(generationScope('api', [], ['api', 'web'], every, only())).toEqual([{ repo: 'api', amend: false }]);
    // Amend alone: the last commit, reworded.
    expect(generationScope('api', [], ['api', 'web'], every, only('api'))).toEqual([{ repo: 'api', amend: true }]);
    // The message typed elsewhere: the one asked for with Amend ticked, as the commit picks it.
    expect(generationScope('api', [], ['web', 'docs'], only('web', 'docs'), only('docs'))).toEqual([
      { repo: 'docs', amend: true },
    ]);
  });

  it('describes every repository with something ticked, under the one message, when none is amended', () => {
    expect(generationScope('api', ['api', 'web'], ['api', 'web', 'docs'], every, only())).toEqual([
      { repo: 'api', amend: false },
      { repo: 'web', amend: false },
    ]);
  });

  it('describes the amended repository alone when several have something ticked: Amend commits only it', () => {
    expect(generationScope('api', ['api', 'web'], ['api', 'web'], every, only('web'))).toEqual([
      { repo: 'web', amend: true },
    ]);
    // Ticked on both: the message's first, as the commit amends it.
    expect(generationScope('api', ['web', 'api'], ['api', 'web'], every, only('api', 'web'))).toEqual([
      { repo: 'api', amend: true },
    ]);
  });

  it('never amends a repository outside those asked for', () => {
    // api's Amend is ticked, and api is not among web and docs.
    expect(generationScope('api', ['web', 'docs'], ['web', 'docs'], only('web', 'docs'), only('api'))).toEqual([
      { repo: 'web', amend: false },
      { repo: 'docs', amend: false },
    ]);
  });
});
