/**
 * POST-P14ce: what the Commit window says while its list is narrowed to the
 * repositories picked in the Repositories panel: the filter bar, its hover and
 * what a screen reader hears, and the list when what it shows has nothing.
 */
import { describe, expect, it } from 'vitest';
import type { CommitFilterRepoDto, CommitRepoFilterDto } from '../../../src/shared/protocol';
import {
  filterBarText,
  filterEmptyText,
  HOVER_LISTED,
  namesText,
} from '../../../webview-ui/src/commit/repoFilter';

const repo = (label: string, changes = 0, ticked = 0): CommitFilterRepoDto => ({
  root: `D:/repos/${label}`,
  label,
  colorIdx: 0,
  changes,
  ticked,
});

const filter = (shown: CommitFilterRepoDto[], hidden: CommitFilterRepoDto[]): CommitRepoFilterDto => ({ shown, hidden });

describe('namesText', () => {
  it('names one, two, or a list, as a sentence does', () => {
    expect(namesText([])).toBe('');
    expect(namesText(['api'])).toBe('api');
    expect(namesText(['api', 'web'])).toBe('api and web');
    expect(namesText(['api', 'web', 'docs'])).toBe('api, web and docs');
    expect(namesText(['api', 'web'], 'or')).toBe('api or web');
  });
});

describe('the filter bar (POST-P14ce)', () => {
  it('counts the changes left out', () => {
    const text = filterBarText(filter([repo('api', 6, 5)], [repo('web', 3), repo('docs')]), false);
    expect(text.rest).toEqual({ text: '3 changes elsewhere', warn: false });
    expect(filterBarText(filter([repo('api')], [repo('web', 1)]), false).rest?.text).toBe('1 change elsewhere');
  });

  it('says how many are ticked instead, as a warning, when some of what is left out is', () => {
    const text = filterBarText(filter([repo('web', 3, 2)], [repo('api', 6, 5), repo('docs')]), false);
    expect(text.rest).toEqual({ text: '5 ticked elsewhere', warn: true });
  });

  it('says staged, with staging, where a change is in the commit by being staged', () => {
    const text = filterBarText(filter([repo('web')], [repo('api', 4, 2)]), true);
    expect(text.rest).toEqual({ text: '2 staged elsewhere', warn: true });
    expect(text.title).toContain('api, 4 changes, 2 staged');
    expect(text.title).toContain('Staged changes out of view stay staged, and are not committed until shown.');
  });

  it('says nothing after the names when what is left out has nothing', () => {
    expect(filterBarText(filter([repo('api', 2)], [repo('docs')]), false).rest).toBeUndefined();
  });

  it('counts the repositories, for when their names do not fit', () => {
    expect(filterBarText(filter([repo('api'), repo('web')], [repo('a'), repo('b'), repo('c')]), false).count).toBe(
      '2 of 5 repositories',
    );
  });

  it('lists in its hover what is left out, and what that means for a commit', () => {
    const text = filterBarText(filter([repo('api', 6)], [repo('web', 3), repo('docs')]), false);
    expect(text.title).toBe('Showing api only. Not shown: web, 3 changes; docs, no changes.');
    const ticked = filterBarText(filter([repo('web', 3, 2)], [repo('api', 6, 5)]), false);
    expect(ticked.title).toBe(
      'Showing web only. Not shown: api, 6 changes, 5 ticked. Ticked changes out of view stay ticked, and are not committed until shown.',
    );
    expect(filterBarText(filter([repo('api'), repo('web')], [repo('docs', 1)]), false).title).toBe(
      'Showing api and web only. Not shown: docs, 1 change.',
    );
  });

  it('names so many left out, and counts the rest', () => {
    const hidden = Array.from({ length: HOVER_LISTED + 3 }, (_, i) => repo(`r${i}`));
    const text = filterBarText(filter([repo('api')], hidden), false);
    expect(text.title).toContain(`r${HOVER_LISTED - 1}, no changes; and 3 more.`);
    expect(text.title).not.toContain(`r${HOVER_LISTED},`);
  });

  it('is read out as what it shows and what it leaves out', () => {
    expect(filterBarText(filter([repo('api')], [repo('web', 3)]), false).label).toBe(
      'Showing api only. 3 changes elsewhere.',
    );
    expect(filterBarText(filter([repo('api')], [repo('docs')]), false).label).toBe('Showing api only.');
  });
});

describe('the list narrowed to repositories with nothing to commit (POST-P14ce)', () => {
  it('names them, and counts what Show all would bring back', () => {
    expect(filterEmptyText(filter([repo('docs')], [repo('api', 6), repo('web', 3)]))).toEqual({
      text: 'No changes in docs.',
      elsewhere: '9 changes',
    });
    expect(filterEmptyText(filter([repo('docs'), repo('site')], [repo('api', 1)]))).toEqual({
      text: 'No changes in docs or site.',
      elsewhere: '1 change',
    });
    expect(filterEmptyText(filter([repo('a'), repo('b'), repo('c')], [repo('api', 2)])).text).toBe(
      'No changes in the 3 repositories shown.',
    );
  });

  it("is the window's plain No changes. when nothing anywhere has any", () => {
    expect(filterEmptyText(filter([repo('docs')], [repo('api'), repo('web')]))).toEqual({ text: 'No changes.' });
  });
});
