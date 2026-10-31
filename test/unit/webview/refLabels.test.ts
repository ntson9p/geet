import { describe, expect, it } from 'vitest';
import type { RefChipDto } from '../../../src/shared/protocol';
import { refLabels, tagsTooltip } from '../../../webview-ui/src/log/refLabels';

const branch = (name: string, isHeadTarget = false): RefChipDto => ({
  name,
  type: 'branch',
  ...(isHeadTarget ? { isHeadTarget } : {}),
});
const remote = (name: string): RefChipDto => ({ name, type: 'remote-branch' });
const tag = (name: string): RefChipDto => ({ name, type: 'tag' });

describe('refLabels (Presentation Settings ▾ · Tag Names)', () => {
  it('names every ref, tags included, while Tag Names is on', () => {
    const refs = [branch('main', true), remote('origin/main'), tag('v1.0.0'), tag('v1.0.1')];
    expect(refLabels(refs, true)).toEqual(refs.map((ref) => ({ kind: 'ref', ref })));
  });

  it('gathers a commit\'s tags into one icon while Tag Names is off', () => {
    const labels = refLabels([tag('v1.0.0'), tag('v1.0.1')], false);
    expect(labels).toEqual([{ kind: 'tags', names: ['v1.0.0', 'v1.0.1'] }]);
  });

  it('still names the branches beside that icon', () => {
    const labels = refLabels([branch('main', true), remote('origin/main'), tag('v1.1.0-beta.1')], false);
    expect(labels).toEqual([
      { kind: 'ref', ref: branch('main', true) },
      { kind: 'ref', ref: remote('origin/main') },
      { kind: 'tags', names: ['v1.1.0-beta.1'] },
    ]);
  });

  it('puts the icon where the first tag was, keeping git\'s order', () => {
    const labels = refLabels([tag('v2'), branch('release/2'), tag('v2-final')], false);
    expect(labels).toEqual([
      { kind: 'tags', names: ['v2', 'v2-final'] },
      { kind: 'ref', ref: branch('release/2') },
    ]);
  });

  it('adds nothing to a commit without tags', () => {
    expect(refLabels([branch('main')], false)).toEqual([{ kind: 'ref', ref: branch('main') }]);
    expect(refLabels([], false)).toEqual([]);
    expect(refLabels([], true)).toEqual([]);
  });
});

describe('tagsTooltip', () => {
  it('lists the tags one per line, as hovering the icon should show them', () => {
    expect(tagsTooltip(['v1.0.0', 'v1.0.1'])).toBe('v1.0.0\nv1.0.1');
    expect(tagsTooltip(['v1.0.0'])).toBe('v1.0.0');
  });
});
