import { describe, expect, it } from 'vitest';
import { repoLabels, sortRootsByLabel } from '../../../../src/core/util/repoLabels';

/**
 * POST-P14u. The rule was a private method on `LogViewProvider` until the
 * sidebar grew two more lists of the same repositories. What makes it worth a
 * module is not the arithmetic — it is that a repository has to be called the
 * same thing in the log's `Roots`, the Repositories view and the Branches
 * view's header, or the user cannot tell that the three mean one repository.
 */
describe('repoLabels', () => {
  it('names a repository by its folder', () => {
    const labels = repoLabels(['/w/sample-app-client', '/w/sample-app-server']);
    expect(labels.get('/w/sample-app-client')).toBe('sample-app-client');
    expect(labels.get('/w/sample-app-server')).toBe('sample-app-server');
  });

  it('grows the parent only for the names that actually collide', () => {
    const labels = repoLabels(['/w/web/api', '/w/mobile/api', '/w/docs']);
    expect(labels.get('/w/web/api')).toBe('web/api');
    expect(labels.get('/w/mobile/api')).toBe('mobile/api');
    // A name nobody else claims is left alone — growing every label to disambiguate
    // two of them would make five unambiguous rows harder to read.
    expect(labels.get('/w/docs')).toBe('docs');
  });

  // `node:path` splits on backslashes only on Windows, which is the only place a
  // root has them; on Linux and macOS a backslash is part of a name. Run there,
  // this test failed in CI from its first run (POST-P14cv).
  it.runIf(process.platform === 'win32')('handles backslash paths, which is every root on Windows', () => {
    const labels = repoLabels(['C:\\w\\web\\api', 'C:\\w\\mobile\\api']);
    expect([...labels.values()].sort()).toEqual(['mobile/api', 'web/api']);
  });
});

describe('sortRootsByLabel', () => {
  it('orders by the name the user reads, not by the path', () => {
    // Sorting by path would put `/w/a/zebra` first; nobody reading the list
    // can predict that, because the paths are not on screen.
    expect(sortRootsByLabel(['/w/a/zebra', '/w/b/alpha'])).toEqual(['/w/b/alpha', '/w/a/zebra']);
  });

  it('is stable when two roots end up with the same label', () => {
    // `a/web/api` and `b/web/api` both label as `web/api`; without the path
    // tiebreak the two rows could swap on an unrelated refresh.
    const roots = ['/w/b/web/api', '/w/a/web/api'];
    expect(sortRootsByLabel(roots)).toEqual(['/w/a/web/api', '/w/b/web/api']);
    expect(sortRootsByLabel([...roots].reverse())).toEqual(['/w/a/web/api', '/w/b/web/api']);
  });

  it('does not mutate what it is given', () => {
    const roots = ['/w/z', '/w/a'];
    sortRootsByLabel(roots);
    expect(roots).toEqual(['/w/z', '/w/a']);
  });
});
