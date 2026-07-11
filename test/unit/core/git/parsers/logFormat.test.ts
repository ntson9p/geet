import { describe, expect, it } from 'vitest';
import {
  parseDecorations,
  parseLogOutput,
  parseLogRecord,
  LOG_RECORD_SEPARATOR,
} from '../../../../../src/core/git/parsers/logFormat';
import { fixture } from './fixtures';

describe('parseLogOutput (captured fixture: merge history)', () => {
  const commits = parseLogOutput(fixture('log.bin'));

  it('parses all five commits in topo order', () => {
    expect(commits).toHaveLength(5);
    expect(commits.map((c) => c.subject)).toEqual([
      'merge topic into main',
      'topic work',
      'mainline work',
      'second: subject with ünïcode',
      'first: simple subject',
    ]);
  });

  it('parses parents: merge has two, root has none', () => {
    const merge = commits[0]!;
    expect(merge.parents).toHaveLength(2);
    expect(merge.parents.every((p) => /^[0-9a-f]{40}$/.test(p))).toBe(true);
    expect(commits[4]!.parents).toHaveLength(0);
  });

  it('parses unicode author and times', () => {
    const c = commits[3]!;
    expect(c.authorName).toBe('Åsa Ünicode');
    expect(c.authorEmail).toBe('asa@example.com');
    expect(c.authorTime).toBeGreaterThan(1_700_000_000);
    expect(c.committerName).toBe('Committer Person');
    expect(c.committerTime).toBeGreaterThanOrEqual(c.authorTime);
  });

  it('parses decorations on the merge tip', () => {
    const merge = commits[0]!;
    expect(merge.refs).toEqual(['HEAD -> main', 'tag: v0.1']);
    const { headTarget, decorations } = parseDecorations(merge.refs);
    expect(headTarget).toBe('main');
    expect(decorations).toEqual([
      { name: 'main', type: 'branch' },
      { name: 'v0.1', type: 'tag' },
    ]);
    expect(parseDecorations(commits[1]!.refs).decorations).toEqual([{ name: 'topic', type: 'branch' }]);
    expect(commits[2]!.refs).toEqual([]);
  });

  it('parses multi-line bodies and strips the trailing newline', () => {
    const c = commits[3]!;
    expect(c.body).toBe('A body paragraph.\n\nSecond paragraph with special chars: <>&"éフ.');
  });
});

describe('parseLogRecord (streaming frames)', () => {
  it('parses a single \\x1e-framed record with leading newline', () => {
    const frames = fixture('log.bin').split(LOG_RECORD_SEPARATOR);
    expect(parseLogRecord(frames[0]!)?.subject).toBe('merge topic into main');
    expect(parseLogRecord(frames[1]!)?.subject).toBe('topic work');
  });

  it('returns undefined for the empty trailing frame', () => {
    expect(parseLogRecord('\n')).toBeUndefined();
    expect(parseLogRecord('')).toBeUndefined();
  });

  it('rejects malformed frames', () => {
    expect(parseLogRecord('garbage\0fields')).toBeUndefined();
  });
});

describe('parseLogOutput repair path', () => {
  it('re-joins a body that contained the record separator', () => {
    const mk = (sha: string, body: string) =>
      `${sha}\0\0A\0a@x\0` + '1\0C\0' + '2\0\0subj\0' + body;
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const evil = `${mk(sha1, 'body with \x1e inside')}\x1e\n${mk(sha2, 'clean')}\x1e\n`;
    const commits = parseLogOutput(evil);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.body).toBe('body with \x1e inside');
    expect(commits[1]!.body).toBe('clean');
  });

  it('parses remote-branch decorations', () => {
    const { decorations } = parseDecorations(['origin/main', 'HEAD']);
    expect(decorations).toEqual([
      { name: 'origin/main', type: 'remote-branch' },
      { name: 'HEAD', type: 'head' },
    ]);
  });
});
