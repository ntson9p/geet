import { describe, expect, it } from 'vitest';
import { repoPickOrder } from '../../../src/ui/repoPickOrder';

/**
 * POST-P14bp — a repository pick that is always asked lists the open file's
 * repository first, so Enter takes what used to be taken silently.
 */
describe('repoPickOrder', () => {
  const api = { root: '/w/api' };
  const web = { root: '/w/web' };
  const docs = { root: '/w/docs' };
  const all = [api, web, docs];

  it("puts the open file's repository first, the rest in workspace order", () => {
    expect(repoPickOrder(all, '/w/docs')).toEqual([docs, api, web]);
    expect(repoPickOrder(all, '/w/web')).toEqual([web, api, docs]);
  });

  it('keeps workspace order with no open file, or one outside every repository', () => {
    expect(repoPickOrder(all, undefined)).toEqual(all);
    expect(repoPickOrder(all, '/elsewhere')).toEqual(all);
  });

  it('matches roots through the key it is given, as the workspace compares them', () => {
    const lower = (root: string): string => root.toLowerCase();
    expect(repoPickOrder(all, '/W/Docs', lower)).toEqual([docs, api, web]);
    expect(repoPickOrder(all, '/W/Docs')).toEqual(all);
  });

  it('returns a new list, the same repositories, never the one it was given', () => {
    const ordered = repoPickOrder(all, '/w/api');
    expect(ordered).not.toBe(all);
    expect(ordered).toEqual(all);
    expect(new Set(repoPickOrder(all, '/w/web'))).toEqual(new Set(all));
  });
});
