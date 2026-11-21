import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { views: Record<string, Array<{ id: string; name: string; icon?: string; when?: string }>> };
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const title = (name: string): string => {
  const key = /^%(.+)%$/u.exec(name)?.[1];
  return key !== undefined ? (nls[key] ?? name) : name;
};
const geetViews = manifest.contributes.views['geet'] ?? [];

/**
 * POST-P14co: the sidebar panel once titled Branches, then Repositories with a
 * REPOSITORIES and a BRANCHES pane, is two panels: Repositories and Branches.
 */
describe('the Repositories and Branches panels', () => {
  it('Branches keeps the id the one panel always had, so layouts and keybindings keep working', () => {
    const panel = geetViews.find((v) => v.id === 'geet.branches');
    expect(panel).toBeDefined();
    expect(title(panel!.name)).toBe('Branches');
    expect(panel!.icon).toBe('$(git-branch)');
    expect(panel!.when).toBeUndefined();
  });

  it('Repositories is a panel of its own, right under the Commit window, shown only with several repositories', () => {
    const ids = geetViews.map((v) => v.id);
    const panel = geetViews.find((v) => v.id === 'geet.repositoryList');
    expect(panel).toBeDefined();
    expect(title(panel!.name)).toBe('Repositories');
    expect(panel!.icon).toBe('$(repo)');
    expect(panel!.when).toBe('geet.multiRepo');
    expect(ids.indexOf('geet.repositoryList')).toBe(ids.indexOf('geet.commit') + 1);
    expect(ids.indexOf('geet.repositoryList')).toBeLessThan(ids.indexOf('geet.branches'));
  });

  it('share their titles with no other Geet view: the opt-in trees are Repositories (Tree) and Branches (Tree)', () => {
    const titles = geetViews.map((v) => title(v.name));
    expect(new Set(titles).size).toBe(titles.length);
    expect(title(geetViews.find((v) => v.id === 'geet.repositories')!.name)).toBe('Repositories (Tree)');
    expect(title(geetViews.find((v) => v.id === 'geet.branchesTree')!.name)).toBe('Branches (Tree)');
  });

  it("the branches' settings and commands name the Branches panel, where those branches are listed now", () => {
    for (const key of [
      'geet.command.branches.newBranchInPanel.title',
      'geet.config.branches.groupByFolder.description',
      'geet.config.branches.showRepositoryDots.description',
      'geet.config.branches.showTags.description',
    ]) {
      expect(nls[key], key).toMatch(/\bBranches [Pp]anel\b/u);
      expect(nls[key], key).not.toMatch(/\bRepositories [Pp]anel\b/u);
    }
  });

  it('never calls a webview panel a "Branches view": the tree is Branches (Tree)', () => {
    const stale = Object.entries(nls)
      .filter(([, text]) => /\bBranches (view|View)\b/u.test(text))
      .map(([key]) => key);
    expect(stale).toEqual([]);
  });
});
