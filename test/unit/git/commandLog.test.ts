/**
 * P12-T8: the Console tab's structured ring. Acceptance pins from the phase
 * plan: redaction of a tokenized remote URL and an askpass handshake before
 * anything enters the buffer, and the 2000-entry cap.
 */
import { describe, expect, it } from 'vitest';
import {
  CommandLog,
  type CommandRun,
  redactArgv,
  redactText,
} from '../../../src/core/git/commandLog';

function run(partial: Partial<CommandRun>): CommandRun {
  return {
    ts: 1700000000000,
    argv: ['status'],
    exitCode: 0,
    durationMs: 5,
    stdout: '',
    stderr: '',
    ...partial,
  };
}

describe('commandLog (P12-T8)', () => {
  describe('redactText', () => {
    it('strips userinfo from tokenized remote URLs', () => {
      expect(redactText('fetching https://x-access-token:ghp_abc123@github.com/o/r.git done')).toBe(
        'fetching https://***@github.com/o/r.git done',
      );
      expect(redactText('ssh://git:hunter2@host.example/repo')).toBe(
        'ssh://***@host.example/repo',
      );
      // user-only (no password) URLs are still identity-bearing
      expect(redactText('https://alice@example.com/r.git')).toBe('https://***@example.com/r.git');
    });

    it('strips askpass handshakes and generic token/password/secret values', () => {
      expect(redactText('GIT_ASKPASS=/tmp/creds.sh echo')).toBe('GIT_ASKPASS=*** echo');
      expect(redactText('token=deadbeef rest')).toBe('token=*** rest');
      expect(redactText('password: hunter2')).toBe('password: ***');
      expect(redactText('secret:s3cr3t')).toBe('secret:***');
    });

    it('redacts --author identities inside output text', () => {
      expect(redactText('git commit --author=Alice <a@x.dev> -m msg')).toBe(
        'git commit --author=*** -m msg',
      );
      expect(redactText('ran with --author=Bob <b@x.dev>')).toBe('ran with --author=***');
    });

    it('leaves ordinary text and plain URLs alone', () => {
      const s = 'https://example.com/no-userinfo and a@b in prose stay';
      expect(redactText(s)).toBe(s);
    });
  });

  describe('redactArgv', () => {
    it('replaces --author= argv elements wholesale and redacts URLs in others', () => {
      expect(redactArgv(['commit', '--author=Alice <a@x.dev>', '-m', 'msg'])).toEqual([
        'commit',
        '--author=***',
        '-m',
        'msg',
      ]);
      expect(redactArgv(['fetch', 'https://user:tok@example.com/r.git'])).toEqual([
        'fetch',
        'https://***@example.com/r.git',
      ]);
    });
  });

  describe('CommandLog ring', () => {
    it('assigns increasing seqs and serves deltas via entriesAfter', () => {
      const log = new CommandLog();
      log.push(run({ argv: ['status'] }));
      log.push(run({ argv: ['log'] }));
      log.push(run({ argv: ['diff'] }));
      expect(log.entries().map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(log.entriesAfter(1).map((e) => e.argv[0])).toEqual(['log', 'diff']);
      expect(log.entriesAfter(3)).toHaveLength(0);
    });

    it('redacts argv and output before they enter the buffer', () => {
      const log = new CommandLog();
      log.push(
        run({
          argv: ['push', 'https://x:tok@host/r.git'],
          stderr: 'remote: https://x:tok@host/r.git rejected\nGIT_ASKPASS=/tmp/a.sh',
          exitCode: 1,
        }),
      );
      const e = log.entries()[0]!;
      expect(e.argv).toEqual(['push', 'https://***@host/r.git']);
      expect(e.output).not.toContain('tok@');
      expect(e.output).toContain('https://***@host/r.git');
      expect(e.output).toContain('GIT_ASKPASS=***');
    });

    it('joins stderr before stdout and caps the output head at 2000 chars', () => {
      const log = new CommandLog();
      log.push(run({ stdout: 'OUT', stderr: 'ERR' }));
      expect(log.entries()[0]!.output).toBe('ERR\nOUT');
      log.push(run({ stdout: 'y'.repeat(5000) }));
      expect(log.entries()[1]!.output).toHaveLength(2000);
    });

    it('buffer caps at 2000 entries, dropping the oldest, seq still rising', () => {
      const log = new CommandLog();
      for (let i = 0; i < 2100; i++) log.push(run({ argv: ['n', String(i)] }));
      expect(log.size).toBe(2000);
      expect(log.entries()[0]!.argv[1]).toBe('100');
      expect(log.entries()[log.size - 1]!.seq).toBe(2100);
    });

    it('respects a custom limit and clear() empties the buffer', () => {
      let fired = 0;
      const log = new CommandLog(3);
      const sub = log.onDidChange(() => {
        fired++;
      });
      for (let i = 0; i < 5; i++) log.push(run({}));
      expect(log.size).toBe(3);
      log.clear();
      expect(log.size).toBe(0);
      expect(log.entriesAfter(0)).toHaveLength(0);
      expect(fired).toBe(6); // 5 pushes + 1 clear
      sub.dispose();
      log.dispose();
    });
  });
});
