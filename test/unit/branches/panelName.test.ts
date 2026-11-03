import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { views: Record<string, Array<{ id: string; name: string; icon?: string }>> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const title = (name: string): string => {
  const key = /^%(.+)%$/u.exec(name)?.[1];
  return key !== undefined ? (nls[key] ?? name) : name;
};
const gittreeViews = manifest.contributes.views['gittree'] ?? [];

describe('the sidebar panel once titled Branches', () => {
  it('is Repositories now, under the id it always had, so layouts and keybindings keep working', () => {
    const panel = gittreeViews.find((v) => v.id === 'gittree.branches');
    expect(panel).toBeDefined();
    expect(title(panel!.name)).toBe('Repositories');
    expect(panel!.icon).toBe('$(repo)');
  });

  it('shares its title with no other GitTree view: the opt-in tree it replaced is Repositories (Tree)', () => {
    const titles = gittreeViews.map((v) => title(v.name));
    expect(new Set(titles).size).toBe(titles.length);
    const tree = gittreeViews.find((v) => v.id === 'gittree.repositories');
    expect(title(tree!.name)).toBe('Repositories (Tree)');
  });

  it('is never called the Branches panel or view in what a user reads', () => {
    const stale = Object.entries(nls)
      .filter(([, text]) => /\bBranches (panel|Panel|view|View)\b/u.test(text))
      .map(([key]) => key);
    expect(stale).toEqual([]);
  });
});
