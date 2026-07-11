import { describe, expect, it } from 'vitest';
import { parseForEachRef, type RefInfo } from '../../../../../src/core/git/parsers/refs';
import { fixture } from './fixtures';

function named(refs: RefInfo[], name: string): RefInfo {
  const r = refs.find((x) => x.name === name);
  if (!r) throw new Error(`ref ${name} missing; got ${refs.map((x) => x.name).join(', ')}`);
  return r;
}

describe('parseForEachRef (captured fixture)', () => {
  const refs = parseForEachRef(fixture('for-each-ref.bin'));

  it('finds locals, remotes and tags', () => {
    expect(refs.map((r) => r.type).sort()).toEqual(['head', 'head', 'remote', 'tag', 'tag']);
  });

  it('marks HEAD on the current branch only', () => {
    expect(named(refs, 'main').isHead).toBe(true);
    expect(named(refs, 'feature/topic').isHead).toBe(false);
    expect(refs.filter((r) => r.isHead)).toHaveLength(1);
  });

  it('parses upstream and track counts', () => {
    const main = named(refs, 'main');
    expect(main.upstream).toBe('origin/main');
    expect(main.ahead).toBe(1);
    expect(main.behind).toBe(1);
    expect(main.upstreamGone).toBeUndefined();
  });

  it('classifies remote refs with their remote name', () => {
    const remote = named(refs, 'origin/main');
    expect(remote.type).toBe('remote');
    expect(remote.remote).toBe('origin');
    expect(remote.fullName).toBe('refs/remotes/origin/main');
  });

  it('distinguishes annotated from lightweight tags', () => {
    expect(named(refs, 'v1.0').objectType).toBe('tag');
    expect(named(refs, 'lightweight-tag').objectType).toBe('commit');
  });

  it('parses creator dates and subjects', () => {
    const main = named(refs, 'main');
    expect(main.creatorDate).toBeGreaterThan(1_700_000_000);
    expect(main.subject).toBe('from a');
    expect(named(refs, 'v1.0').subject).toBe('release v1.0');
  });
});

describe('parseForEachRef (synthetic edges)', () => {
  it('parses a gone upstream', () => {
    const line =
      'refs/heads/doomed\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0commit\0origin/doomed\0[gone]\0 \0' +
      '1767323046\0\0subject\n';
    const [ref] = parseForEachRef(line);
    expect(ref?.upstreamGone).toBe(true);
    expect(ref?.ahead).toBeUndefined();
  });

  it('parses origin/HEAD symref', () => {
    const line =
      'refs/remotes/origin/HEAD\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0commit\0\0\0 \0' +
      '1767323046\0refs/remotes/origin/main\0subject\n';
    const [ref] = parseForEachRef(line);
    expect(ref?.name).toBe('origin/HEAD');
    expect(ref?.symrefTarget).toBe('refs/remotes/origin/main');
  });

  it('parses ahead-only and behind-only tracking', () => {
    const mk = (track: string) =>
      `refs/heads/b\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0commit\0origin/b\0${track}\0 \0` + '1\0\0s\n';
    expect(parseForEachRef(mk('[ahead 3]'))[0]).toMatchObject({ ahead: 3 });
    expect(parseForEachRef(mk('[behind 7]'))[0]).toMatchObject({ behind: 7 });
    expect(parseForEachRef(mk(''))[0]?.ahead).toBeUndefined();
  });

  it('skips refs outside the known namespaces', () => {
    const line = 'refs/stash\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0commit\0\0\0 \0' + '1\0\0s\n';
    expect(parseForEachRef(line)).toHaveLength(0);
  });
});
