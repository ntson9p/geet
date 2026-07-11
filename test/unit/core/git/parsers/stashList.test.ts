import { describe, expect, it } from 'vitest';
import { parseStashList } from '../../../../../src/core/git/parsers/stashList';
import { fixture } from './fixtures';

describe('parseStashList (captured fixture)', () => {
  const stashes = parseStashList(fixture('stash-list.bin'));

  it('parses both stashes with indices from selectors', () => {
    expect(stashes).toHaveLength(2);
    expect(stashes[0]).toMatchObject({ index: 0, selector: 'stash@{0}' });
    expect(stashes[1]).toMatchObject({ index: 1, selector: 'stash@{1}' });
  });

  it('parses the named stash (message containing a colon)', () => {
    const named = stashes[0]!;
    expect(named.message).toBe('On main: my named stash: with colon');
    expect(named.branch).toBe('main');
  });

  it('parses the WIP stash', () => {
    const wip = stashes[1]!;
    expect(wip.message).toMatch(/^WIP on main: [0-9a-f]+ base$/);
    expect(wip.branch).toBe('main');
    expect(wip.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(wip.time).toBeGreaterThan(1_700_000_000);
  });

  it('leaves branch undefined for exotic subjects (synthetic autostash)', () => {
    const out = 'stash@{0}\0' + 'a'.repeat(40) + '\0' + '1767323045\0autostash\x1e\n';
    const [s] = parseStashList(out);
    expect(s?.branch).toBeUndefined();
    expect(s?.message).toBe('autostash');
  });

  it('tolerates empty output', () => {
    expect(parseStashList('')).toHaveLength(0);
  });
});
