import { describe, expect, it } from 'vitest';
import type { RefChipDto } from '../../../src/shared/protocol';
import {
  DETACHED_HEAD,
  NO_REPO_REFS,
  groupColors,
  groupRefs,
  iconWidth,
  labelTooltip,
  labelsBudget,
  layoutLabels,
  repoRefs,
  shortenRefName,
  type RefGroup,
  type RepoRefs,
} from '../../../webview-ui/src/log/refLabels';

const branch = (name: string, isHeadTarget = false): RefChipDto => ({
  name,
  type: 'branch',
  ...(isHeadTarget ? { isHeadTarget } : {}),
});
const remote = (name: string): RefChipDto => ({ name, type: 'remote-branch' });
const tag = (name: string): RefChipDto => ({ name, type: 'tag' });
const detachedHead: RefChipDto = { name: 'HEAD', type: 'head' };

const ON_MAIN: RepoRefs = { currentBranch: 'main', upstreams: new Map(), remotes: ['origin'] };
const COMPACT = { compact: true, showTagNames: false };
const FULL = { compact: false, showTagNames: false };

/** A group as names: what a test reads. */
const shape = (groups: RefGroup[]) =>
  groups.map((g) => ({ name: g.name, refs: g.refs.map((r) => r.name), ...(g.detached ? { detached: true } : {}) }));

/** Seven pixels a character: easy to reckon with. */
const measure = (text: string): number => text.length * 7;

describe("groupRefs (IntelliJ's GitRefManager.groupForTable)", () => {
  it('draws nothing for a commit without refs', () => {
    expect(groupRefs([], ON_MAIN, COMPACT)).toEqual([]);
  });

  it("names the current branch and puts HEAD in its icon, as in IntelliJ's first row", () => {
    const groups = groupRefs([branch('main', true)], ON_MAIN, COMPACT);
    expect(shape(groups)).toEqual([{ name: 'main', refs: ['HEAD', 'main'] }]);
    expect(groupColors(groups[0]!)).toEqual(['head', 'local']);
  });

  it('Compact References View: every ref in one label, named after the first group', () => {
    const repo: RepoRefs = { ...ON_MAIN, upstreams: new Map([['main', 'origin/main']]) };
    const groups = groupRefs([tag('v1'), remote('origin/main'), branch('main', true)], repo, COMPACT);
    // main and the remote branch it tracks are a pair, named as IntelliJ names it.
    expect(shape(groups)).toEqual([{ name: 'origin & main', refs: ['HEAD', 'main', 'origin/main', 'v1'] }]);
    expect(groupColors(groups[0]!)).toEqual(['head', 'local', 'remote', 'tag']);
  });

  it('a commit with only tags is the tag icon alone, unless Tag Names is on', () => {
    expect(shape(groupRefs([tag('v1.0'), tag('v1.0.1')], ON_MAIN, COMPACT))).toEqual([
      { name: '', refs: ['v1.0', 'v1.0.1'] },
    ]);
    expect(shape(groupRefs([tag('v1.0'), tag('v1.0.1')], ON_MAIN, { compact: true, showTagNames: true }))).toEqual([
      { name: 'v1.0', refs: ['v1.0', 'v1.0.1'] },
    ]);
  });

  it('without Compact References View each branch is its own label and the tags share one', () => {
    const groups = groupRefs(
      [tag('v2'), remote('origin/dev'), branch('feature/x'), tag('v1'), branch('main', true)],
      ON_MAIN,
      FULL,
    );
    expect(shape(groups)).toEqual([
      { name: 'main', refs: ['HEAD', 'main'] },
      { name: 'feature/x', refs: ['feature/x'] },
      { name: 'origin/dev', refs: ['origin/dev'] },
      { name: '', refs: ['v1', 'v2'] },
    ]);
    expect(groupColors(groups[3]!)).toEqual(['tag', 'tag']);
  });

  it('with Tag Names on, the shared tag label is named after its first tag', () => {
    const groups = groupRefs([tag('v2'), tag('v1')], ON_MAIN, { compact: false, showTagNames: true });
    expect(shape(groups)).toEqual([{ name: 'v1', refs: ['v1', 'v2'] }]);
  });

  it("orders as IntelliJ's labels do: main/master, origin/main, other locals, other remotes", () => {
    const repo: RepoRefs = { upstreams: new Map(), remotes: [] };
    const groups = groupRefs(
      [remote('origin/alpha'), branch('zeta'), remote('origin/main'), branch('main')],
      repo,
      FULL,
    );
    expect(groups.map((g) => g.name)).toEqual(['main', 'zeta', 'origin/main', 'origin/alpha']);
  });

  it("pairs a branch with <remote>/<name> when it has no upstream recorded", () => {
    const repo: RepoRefs = { upstreams: new Map(), remotes: ['origin'] };
    expect(shape(groupRefs([branch('dev'), remote('origin/dev')], repo, FULL))).toEqual([
      { name: 'origin & dev', refs: ['dev', 'origin/dev'] },
    ]);
  });

  it('pairs a branch with the upstream it tracks, under any name', () => {
    const repo: RepoRefs = {
      upstreams: new Map([['dev', 'upstream/develop']]),
      remotes: ['origin', 'upstream'],
    };
    expect(shape(groupRefs([branch('dev'), remote('upstream/develop')], repo, FULL))).toEqual([
      { name: 'upstream & dev', refs: ['dev', 'upstream/develop'] },
    ]);
  });

  it('a detached HEAD gets its own Detached HEAD label first', () => {
    const repo: RepoRefs = { upstreams: new Map(), remotes: [] };
    const groups = groupRefs([detachedHead, branch('main')], repo, COMPACT);
    expect(shape(groups)).toEqual([
      { name: DETACHED_HEAD, refs: ['HEAD'], detached: true },
      { name: 'main', refs: ['main'] },
    ]);
    expect(groupColors(groups[0]!)).toEqual([]);
    expect(shape(groupRefs([detachedHead], repo, COMPACT))).toEqual([
      { name: DETACHED_HEAD, refs: ['HEAD'], detached: true },
    ]);
  });

  it('marks a kind held more than once with a doubled colour', () => {
    const repo: RepoRefs = { ...ON_MAIN, upstreams: new Map([['dev', 'origin/dev']]) };
    const groups = groupRefs([branch('main', true), branch('dev'), remote('origin/dev'), tag('v1')], repo, COMPACT);
    expect(shape(groups)).toEqual([{ name: 'main', refs: ['HEAD', 'main', 'dev', 'origin/dev', 'v1'] }]);
    expect(groupColors(groups[0]!)).toEqual(['head', 'local', 'local', 'remote', 'tag']);
  });
});

describe('iconWidth', () => {
  it('widens by one step for each colour past the first', () => {
    expect(iconWidth(1)).toBe(16);
    expect(iconWidth(2)).toBe(21);
    expect(iconWidth(3)).toBe(26);
  });
});

describe('shortenRefName (LabelPainter)', () => {
  const long = 'origin/feature/a-very-long-branch-name';

  it('never shortens a name that fits, or one of 22 characters or fewer', () => {
    expect(shortenRefName(long, measure, 1000)).toBe(long);
    expect(shortenRefName('feature/short', measure, 0)).toBe('feature/short');
  });

  it('drops what is before the first slash, then the end, but keeps 22 characters', () => {
    expect(shortenRefName(long, measure, 100)).toBe('../feature/a-very-lon…');
    expect(shortenRefName(long, measure, 0)).toBe('../feature/a-very-lon…');
  });

  it('keeps as much as the room allows', () => {
    expect(shortenRefName(long, measure, 7 * 25)).toBe('../feature/a-very-long-b…');
  });

  it('keeps a short first part', () => {
    expect(shortenRefName('ab/cdefghijklmnopqrstuvwxyz', measure, 0)).toBe('ab/cdefghijklmnopqrst…');
  });
});

describe('labelsBudget (GraphCommitCellRenderer.getAvailableWidth)', () => {
  it('compact: what the message leaves, at most a third of the column', () => {
    expect(labelsBudget(600, 100, true, false)).toBe(200);
    expect(labelsBudget(600, 550, true, false)).toBe(50);
    expect(labelsBudget(600, 700, true, false)).toBe(0);
  });

  it('otherwise: at least half the column, or all of it bar 80 pixels of message', () => {
    expect(labelsBudget(600, 550, false, false)).toBe(520);
    expect(labelsBudget(600, 400, false, false)).toBe(520);
    // More than that when the message leaves more.
    expect(labelsBudget(600, 50, false, false)).toBe(550);
  });

  it('on the left, the message is not counted', () => {
    expect(labelsBudget(600, 700, true, true)).toBe(200);
    expect(labelsBudget(600, 700, false, true)).toBe(600);
  });
});

describe('layoutLabels (LabelPainter.calculatePresentation)', () => {
  const groups = (names: string[]): RefGroup[] =>
    names.map((name) => ({ name, refs: [{ name, kind: 'local' as const }] }));

  it('sizes a label as icon, gap and text, with padding at both ends', () => {
    const { labels, width } = layoutLabels(groupRefs([branch('main', true)], ON_MAIN, COMPACT), 500, true, measure);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ text: 'main', colors: ['head', 'local'], width: 21 + 1 + 28 });
    expect(width).toBe(50 + 8);
  });

  it('draws every label that fits', () => {
    expect(layoutLabels(groups(['a', 'b', 'c']), 1000, false, measure).labels.map((l) => l.text)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('folds the labels that do not fit into one last icon carrying their colours', () => {
    const { labels } = layoutLabels(groups(['a', 'b', 'c']), 78, false, measure);
    expect(labels.map((l) => l.text)).toEqual(['a', '']);
    expect(labels[1]!.colors).toEqual(['local', 'local']);
    expect(labels[1]!.refs.map((r) => r.name)).toEqual(['b', 'c']);
  });

  it('names the folded icon when nothing fits before it', () => {
    const { labels } = layoutLabels(groups(['feature/one', 'feature/two', 'feature/three']), 80, false, measure);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe('feature/one');
    expect(labels[0]!.refs).toHaveLength(3);
  });

  it('never folds in compact view: there is only the one label', () => {
    const { labels } = layoutLabels(groupRefs([branch('main', true), tag('v1')], ON_MAIN, COMPACT), 0, true, measure);
    expect(labels.map((l) => l.text)).toEqual(['main']);
  });

  it('puts Detached HEAD first, with its warning icon', () => {
    const repo: RepoRefs = { upstreams: new Map(), remotes: [] };
    const { labels } = layoutLabels(groupRefs([detachedHead, branch('main')], repo, COMPACT), 500, true, measure);
    expect(labels.map((l) => l.text)).toEqual([DETACHED_HEAD, 'main']);
    expect(labels[0]).toMatchObject({ detached: true, width: 16 + 3 + 1 + DETACHED_HEAD.length * 7 });
  });

  it('is empty for no groups', () => {
    expect(layoutLabels([], 500, true, measure)).toEqual({ labels: [], width: 0 });
  });
});

describe('labelTooltip', () => {
  it("lists a label's refs one per line, leaving HEAD out", () => {
    const [label] = layoutLabels(groupRefs([branch('main', true), tag('v1')], ON_MAIN, COMPACT), 500, true, measure)
      .labels;
    expect(labelTooltip(label!)).toBe('main\nv1');
  });

  it('explains a detached HEAD, as IntelliJ does', () => {
    const [label] = layoutLabels(groupRefs([detachedHead], NO_REPO_REFS, COMPACT), 500, true, measure).labels;
    expect(labelTooltip(label!)).toContain('not on any branch');
  });
});

describe('repoRefs', () => {
  it('reads the current branch, each upstream and the remotes from the Branches data', () => {
    const repo = repoRefs({
      current: 'main',
      locals: [{ name: 'main', upstream: 'origin/main' }, { name: 'wip' }],
      remotes: [{ remote: 'origin' }, { remote: 'fork' }],
    });
    expect(repo.currentBranch).toBe('main');
    expect([...repo.upstreams]).toEqual([['main', 'origin/main']]);
    expect(repo.remotes).toEqual(['origin', 'fork']);
  });

  it('knows nothing before the Branches data arrives', () => {
    expect(repoRefs(null)).toBe(NO_REPO_REFS);
  });
});
