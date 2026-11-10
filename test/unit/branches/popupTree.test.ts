import { describe, expect, it } from 'vitest';
import type { RefInfo } from '../../../src/core/model/refs';
import {
  applyShowTags,
  childRows,
  flattenTree,
  rootRows,
  type RepoRefs,
  type TreeContext,
} from '../../../src/branches/popupTree';

function ref(name: string, type: RefInfo['type']): RefInfo {
  const fullName =
    type === 'tag' ? `refs/tags/${name}` : type === 'remote' ? `refs/remotes/${name}` : `refs/heads/${name}`;
  return {
    name,
    fullName,
    type,
    sha: 'a'.repeat(40),
    objectType: 'commit',
    isHead: false,
    ...(type === 'remote' ? { remote: 'origin' } : {}),
  };
}

function repo(root: string, name: string): RepoRefs {
  return {
    root,
    name,
    currentBranch: 'main',
    locals: [ref('main', 'head'), ref('feature/a', 'head')],
    remotes: [ref('origin/main', 'remote')],
    tags: [ref('v1.0.0', 'tag'), ref('v1.0.1', 'tag')],
    favorites: new Set(),
  };
}

function ctxOf(repos: RepoRefs[]): TreeContext {
  return {
    repos,
    commonLocals: ['main'],
    commonRemotes: ['origin/main'],
    commonTags: ['v1.0.0', 'v1.0.1'],
    showInOut: true,
  };
}

const tagRows = (rows: ReturnType<typeof rootRows>) => rows.filter((r) => r.ref?.type === 'tag');

describe('applyShowTags (gittree.branches.showTags)', () => {
  it('leaves the context alone while Show Tags is on', () => {
    const ctx = ctxOf([repo('/a', 'a')]);
    expect(applyShowTags(ctx, true)).toBe(ctx);
  });

  it('drops every tag, and the common tags, when it is off', () => {
    const ctx = ctxOf([repo('/a', 'a'), repo('/b', 'b')]);
    const off = applyShowTags(ctx, false);
    expect(off.repos.map((r) => r.tags)).toEqual([[], []]);
    expect(off.commonTags).toEqual([]);
    // Branches are what the surfaces are for; they are untouched.
    expect(off.repos.map((r) => r.locals.map((b) => b.name))).toEqual([
      ['main', 'feature/a'],
      ['main', 'feature/a'],
    ]);
    expect(off.commonLocals).toEqual(['main']);
    expect(off.commonRemotes).toEqual(['origin/main']);
  });

  it('does not change the context it was given', () => {
    const ctx = ctxOf([repo('/a', 'a')]);
    applyShowTags(ctx, false);
    expect(ctx.repos[0]?.tags.map((t) => t.name)).toEqual(['v1.0.0', 'v1.0.1']);
    expect(ctx.commonTags).toEqual(['v1.0.0', 'v1.0.1']);
  });

  it('takes the Tags node out of a single repository', () => {
    const ctx = ctxOf([repo('/a', 'a')]);
    expect(rootRows(ctx).some((r) => r.section === 'tag')).toBe(true);
    const off = rootRows(applyShowTags(ctx, false));
    expect(off.some((r) => r.section === 'tag')).toBe(false);
    expect(off.some((r) => r.section === 'local')).toBe(true);
    expect(off.some((r) => r.section === 'remote')).toBe(true);
  });

  it('takes Common Tags, and each repository\'s Tags, out of a multi-repository project', () => {
    const ctx = ctxOf([repo('/a', 'a'), repo('/b', 'b')]);
    expect(rootRows(ctx).some((r) => r.commonKind === 'tag')).toBe(true);
    const off = applyShowTags(ctx, false);
    const rows = rootRows(off);
    expect(rows.some((r) => r.commonKind === 'tag')).toBe(false);
    expect(rows.some((r) => r.commonKind === 'local')).toBe(true);
    // Opening a repository lists its sections: no Tags among them.
    const repoRow = rows.find((r) => r.kind === 'repo' && r.repoRoot === '/a');
    expect(repoRow).toBeDefined();
    const opened = childRows(off, repoRow!);
    expect(opened.some((r) => r.section === 'tag')).toBe(false);
    expect(opened.some((r) => r.section === 'local')).toBe(true);
  });

  it('keeps tags out of a search', () => {
    const ctx = ctxOf([repo('/a', 'a')]);
    expect(tagRows(flattenTree(ctx, new Set(), 'v1').rows)).not.toHaveLength(0);
    expect(tagRows(flattenTree(applyShowTags(ctx, false), new Set(), 'v1').rows)).toHaveLength(0);
  });

  it('keeps tags out of a project-wide search too', () => {
    const ctx = ctxOf([repo('/a', 'a'), repo('/b', 'b')]);
    expect(tagRows(flattenTree(ctx, new Set(), 'v1').rows)).not.toHaveLength(0);
    expect(tagRows(flattenTree(applyShowTags(ctx, false), new Set(), 'v1').rows)).toHaveLength(0);
  });
});

describe('Update Project Without Fetching among the verbs (POST-P14bm)', () => {
  it('sits right under Update Project, with no key of its own', () => {
    const verbs = rootRows(ctxOf([repo('/r', 'r')])).filter((r) => r.kind === 'verb');
    const commands = verbs.map((r) => r.verb?.command);
    const at = commands.indexOf('gittree.update.dialog');
    expect(commands[at + 1]).toBe('gittree.update.withoutFetch');
    expect(verbs[at + 1]?.label).toBe('Update Project Without Fetching…');
    expect(verbs[at + 1]?.verb?.accelerator).toBeUndefined();
  });

  it('acts on the project: a repository of several has no copy of its own', () => {
    const ctx = ctxOf([repo('/a', 'a'), repo('/b', 'b')]);
    const project = rootRows(ctx).filter((r) => r.kind === 'verb');
    expect(project.map((r) => r.verb?.command)).toContain('gittree.update.withoutFetch');
    const repoRow = rootRows(ctx).find((r) => r.kind === 'repo');
    expect(repoRow).toBeDefined();
    const inRepo = childRows(ctx, repoRow!).filter((r) => r.kind === 'verb');
    // It does have verbs of its own — just not this one.
    expect(inRepo.length).toBeGreaterThan(0);
    expect(inRepo.map((r) => r.verb?.command)).not.toContain('gittree.update.withoutFetch');
  });
});

describe('verb rows and their keys (POST-QA)', () => {
  it('keep the accelerator on the verb, out of the description, for the surface to show when bound', () => {
    const verbs = rootRows(ctxOf([repo('/r', 'r')])).filter((r) => r.kind === 'verb');
    const update = verbs.find((r) => r.verb?.command === 'gittree.update.dialog');
    expect(update?.verb?.accelerator).toBe('Ctrl+T');
    expect(update?.description).toBeUndefined();
    expect(verbs.every((r) => r.description === undefined)).toBe(true);
  });
});
