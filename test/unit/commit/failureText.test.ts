import { describe, expect, it } from 'vitest';
import { FAILURE_LINES, failureText } from '../../../src/commit/window/failureText';

const hook = (stderr: string) => ({ message: stderr.split('\n').find((l) => l.trim()) ?? '', stderr });

describe('failureText (POST-QA)', () => {
  it('shows every line a failed hook printed, not git\'s first', () => {
    const err = hook('lint: notes.md line 3: trailing whitespace\nlint: src/x.ts line 9: missing semicolon\n\nlint: 2 problems\n');
    expect(failureText(err)).toBe(
      'lint: notes.md line 3: trailing whitespace\nlint: src/x.ts line 9: missing semicolon\nlint: 2 problems',
    );
  });

  it('names the repository when there are several', () => {
    expect(failureText(hook('lint: 1 problem\n'), 'notes-repo')).toBe('notes-repo: lint: 1 problem');
  });

  it('keeps it to a dozen lines and says where the rest is', () => {
    const many = Array.from({ length: FAILURE_LINES + 3 }, (_, i) => `line ${i + 1}`).join('\n');
    const text = failureText(hook(many));
    expect(text.split('\n')).toHaveLength(FAILURE_LINES + 1);
    expect(text).toMatch(/… 3 more lines in the GitTree output$/u);
  });

  it('falls back to the message without stderr, and takes any error', () => {
    expect(failureText({ message: 'git exited with code 1', stderr: '' })).toBe('git exited with code 1');
    expect(failureText(new Error('boom'), 'local')).toBe('local: boom');
  });
});
