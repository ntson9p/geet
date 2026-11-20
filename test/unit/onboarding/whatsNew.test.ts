/** P10-T3: the per-minor "What's new" gate; POST-P14cr: the changelog it opens. */
import { describe, expect, it } from 'vitest';
import { CHANGELOG_NAMES, changelogName, whatsNewDecision } from '../../../src/onboarding/whatsNewGate';

describe('changelogName (POST-P14cr)', () => {
  it('an installed Geet has changelog.md, as vsce packages it: that one', () => {
    // On Linux the folder has no CHANGELOG.md at all, and the preview was of nothing.
    expect(changelogName((n) => n === 'changelog.md')).toBe('changelog.md');
  });

  it('a development host runs from the repository, where it is CHANGELOG.md', () => {
    expect(changelogName((n) => n === 'CHANGELOG.md')).toBe('CHANGELOG.md');
  });

  it('a case-insensitive file system answers yes to both: the packaged name first', () => {
    expect(changelogName(() => true)).toBe('changelog.md');
    expect(CHANGELOG_NAMES[0]).toBe('changelog.md');
  });

  it('none there: nothing to open', () => {
    expect(changelogName(() => false)).toBeUndefined();
  });
});

describe('whatsNewDecision', () => {
  it('fresh install: records the minor without showing', () => {
    expect(whatsNewDecision(undefined, '0.2.1')).toEqual({ minor: '0.2', show: false });
  });

  it('same minor (patch bumps included): silent', () => {
    expect(whatsNewDecision('0.2', '0.2.0')).toEqual({ minor: '0.2', show: false });
    expect(whatsNewDecision('0.2', '0.2.9')).toEqual({ minor: '0.2', show: false });
  });

  it('minor bump: shows once', () => {
    expect(whatsNewDecision('0.2', '0.3.0')).toEqual({ minor: '0.3', show: true });
  });

  it('major bump: shows too', () => {
    expect(whatsNewDecision('0.9', '1.0.0')).toEqual({ minor: '1.0', show: true });
  });

  it('downgrade: still just compares minors', () => {
    expect(whatsNewDecision('1.1', '1.0.5')).toEqual({ minor: '1.0', show: true });
  });
});
