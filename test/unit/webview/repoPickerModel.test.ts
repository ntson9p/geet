import { describe, expect, it } from 'vitest';
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';
import {
  mentionAt,
  pickerRows,
  pickToggled,
  withoutMention,
  type PickerRow,
} from '../../../webview-ui/src/branches/repoPickerModel';

/**
 * POST-P14co: the Branches panel's `@`, which lists the repositories, a
 * square box each, for the side bar's one pick. Ticked is picked; none ticked
 * is every repository.
 */

function repo(root: string, label = root.slice(1)): BranchPanelRepoDto {
  return {
    root,
    label,
    colorIdx: 0,
    detached: false,
    unborn: false,
    changes: 0,
    fetching: false,
    locals: [],
    remotes: [],
    tags: [],
    recent: [],
    favorites: [],
    merged: [],
    head: 'main',
  };
}

const API = repo('/api');
const SHARED = repo('/shared');
const WEB = repo('/web');
const REPOS = [API, SHARED, WEB];

/** The rows as they read: `[x] api`, `[ ] all`. */
const read = (rows: readonly PickerRow[]): string[] =>
  rows.map((r) => `${r.ticked ? '[x]' : '[ ]'} ${r.kind === 'all' ? 'all' : r.repo.label}`);

describe('the @ the caret is after', () => {
  it('starts the filter, or follows a space, and runs to the caret', () => {
    expect(mentionAt('@we', 3)).toEqual({ start: 0, end: 3, query: 'we' });
    expect(mentionAt('log @we', 7)).toEqual({ start: 4, end: 7, query: 'we' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('inside a word is part of what is searched for: a branch name may hold one', () => {
    expect(mentionAt('a@b', 3)).toBeUndefined();
    expect(mentionAt('user@host', 9)).toBeUndefined();
  });

  it('is none while the caret is before it', () => {
    expect(mentionAt('log @we', 3)).toBeUndefined();
    expect(mentionAt('log @we', 4)).toBeUndefined();
    expect(mentionAt('log @we', 5)).toEqual({ start: 4, end: 5, query: '' });
  });

  it('runs on over spaces: a repository may be named `local - Copy`', () => {
    expect(mentionAt('@local - c', 10)).toEqual({ start: 0, end: 10, query: 'local - c' });
  });

  it('is the last one before the caret', () => {
    expect(mentionAt('x @a @b', 7)).toEqual({ start: 5, end: 7, query: 'b' });
    expect(mentionAt('x @a @b', 4)).toEqual({ start: 2, end: 4, query: 'a' });
  });

  it('takes no caret as the end of the text, and keeps the caret within it', () => {
    expect(mentionAt('@we', null)).toEqual({ start: 0, end: 3, query: 'we' });
    expect(mentionAt('@we', undefined)).toEqual({ start: 0, end: 3, query: 'we' });
    expect(mentionAt('@we', 99)).toEqual({ start: 0, end: 3, query: 'we' });
    expect(mentionAt('@we', -4)).toBeUndefined();
  });
});

describe('the filter without the @', () => {
  it('is what the branches are filtered by: the rest of the text', () => {
    expect(withoutMention('log @we', mentionAt('log @we', 7))).toBe('log ');
    expect(withoutMention('@we', mentionAt('@we', 3))).toBe('');
    expect(withoutMention('feat', undefined)).toBe('feat');
  });

  it('keeps what lies past the caret', () => {
    expect(withoutMention('@webe', mentionAt('@webe', 3))).toBe('be');
  });
});

describe("the picker's rows", () => {
  it('with nothing typed: All repositories, ticked while none is picked, then each repository in order', () => {
    expect(read(pickerRows(REPOS, [], ''))).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
    expect(pickerRows(REPOS, [], '')[0]).toEqual({ kind: 'all', id: 'all', ticked: true });
  });

  it('tick the ones picked, and then All repositories is not', () => {
    expect(read(pickerRows(REPOS, ['/web'], ''))).toEqual(['[ ] all', '[ ] api', '[ ] shared', '[x] web']);
    expect(read(pickerRows(REPOS, ['/web', '/api'], ''))).toEqual(['[ ] all', '[x] api', '[ ] shared', '[x] web']);
  });

  it('take a pick of repositories since closed as no pick, as the panels do', () => {
    expect(read(pickerRows(REPOS, ['/gone'], ''))).toEqual(['[x] all', '[ ] api', '[ ] shared', '[ ] web']);
  });

  it('narrow to the names holding every word typed, marked, without All repositories', () => {
    const rows = pickerRows([...REPOS, repo('/local-copy', 'local - Copy')], [], 'loc co');
    expect(read(rows)).toEqual(['[ ] local - Copy']);
    expect(rows[0]).toMatchObject({ kind: 'repo', id: 'pick:/local-copy', highlights: [[0, 3], [8, 10]] });
    expect(read(pickerRows(REPOS, ['/shared'], 'A'))).toEqual(['[ ] api', '[x] shared']);
  });

  it('are none when nothing matches', () => {
    expect(pickerRows(REPOS, [], 'nope')).toEqual([]);
  });
});

describe('a tick', () => {
  it('with every repository shown, picks that one alone', () => {
    expect(pickToggled(REPOS, [], '/web')).toEqual(['/web']);
  });

  it('adds a repository to the pick, and an untick takes one out', () => {
    expect(pickToggled(REPOS, ['/web'], '/api')).toEqual(['/web', '/api']);
    expect(pickToggled(REPOS, ['/web', '/api'], '/web')).toEqual(['/api']);
  });

  it('unticking the last picked shows every repository again', () => {
    expect(pickToggled(REPOS, ['/web'], '/web')).toEqual([]);
  });

  it('ticking the last one not picked is every repository: no pick', () => {
    expect(pickToggled(REPOS, ['/web', '/api'], '/shared')).toEqual([]);
  });

  it('starts from what is in view: a pick of closed repositories is none', () => {
    expect(pickToggled(REPOS, ['/gone'], '/api')).toEqual(['/api']);
  });
});
