import { describe, expect, it } from 'vitest';
import {
  buildCapabilities,
  compareVersion,
  parseGitVersion,
} from '../../../../src/core/git/capabilities';

describe('parseGitVersion', () => {
  it('parses plain versions', () => {
    expect(parseGitVersion('git version 2.43.0')).toBe('2.43.0');
  });
  it('parses windows suffixed versions', () => {
    expect(parseGitVersion('git version 2.28.0.windows.1')).toBe('2.28.0');
  });
  it('parses apple suffixed versions', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toBe('2.39.3');
  });
  it('handles two-part versions', () => {
    expect(parseGitVersion('git version 2.36')).toBe('2.36.0');
  });
  it('returns undefined for garbage', () => {
    expect(parseGitVersion('flurp')).toBeUndefined();
  });
});

describe('compareVersion', () => {
  it('orders correctly', () => {
    expect(compareVersion('2.35.1', [2, 36, 0])).toBe(-1);
    expect(compareVersion('2.36.0', [2, 36, 0])).toBe(0);
    expect(compareVersion('2.36.1', [2, 36, 0])).toBe(1);
    expect(compareVersion('3.0.0', [2, 99, 9])).toBe(1);
  });
});

describe('buildCapabilities', () => {
  it('flags everything on for a modern git', () => {
    const caps = buildCapabilities('2.43.0');
    expect(caps.belowFloor).toBe(false);
    expect(caps.stashStaged).toBe(true);
    expect(caps.commitGraph).toBe(true);
    expect(caps.forceIfIncludes).toBe(true);
    expect(caps.fsmonitor).toBe(true);
    expect(caps.rebaseUpdateRefs).toBe(true);
    expect(caps.mergeAutostash).toBe(true);
  });

  it('degrades for git 2.28 (below floor)', () => {
    const caps = buildCapabilities('2.28.0');
    expect(caps.belowFloor).toBe(true);
    expect(caps.stashStaged).toBe(false);
    expect(caps.commitGraph).toBe(true); // 2.24+
    expect(caps.forceIfIncludes).toBe(false);
    expect(caps.fsmonitor).toBe(false);
    // 2.27 taught `merge` --autostash; this machine's own git sits just above it.
    expect(caps.mergeAutostash).toBe(true);
    expect(buildCapabilities('2.26.2').mergeAutostash).toBe(false);
  });

  it('boundary: 2.35 has stash --staged but is below floor', () => {
    const caps = buildCapabilities('2.35.0');
    expect(caps.stashStaged).toBe(true);
    expect(caps.zdiff3).toBe(true);
    expect(caps.belowFloor).toBe(true);
  });
});
