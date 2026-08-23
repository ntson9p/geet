import { describe, expect, it } from 'vitest';
import { formatGitCommands } from '../../../src/scm/dialogs/commandLine';
import {
  buildIntegrateArgs,
  buildResetToRemoteArgs,
  buildUpdatePlan,
  buildUpdateFetchArgs,
  normalizeStrategySetting,
} from '../../../src/scm/dialogs/updateArgs';

/**
 * P13-T2. The dialog previews `buildUpdatePlan` and the host executes the same
 * pieces, so these tests pin both at once.
 */

describe('normalizeStrategySetting', () => {
  it('keeps the two real strategies', () => {
    expect(normalizeStrategySetting('merge')).toBe('merge');
    expect(normalizeStrategySetting('rebase')).toBe('rebase');
  });

  it('treats anything else — including unset — as "ask"', () => {
    expect(normalizeStrategySetting('ask')).toBe('ask');
    expect(normalizeStrategySetting(undefined)).toBe('ask');
    expect(normalizeStrategySetting('')).toBe('ask');
    expect(normalizeStrategySetting('MERGE')).toBe('ask');
  });
});

describe('buildUpdateFetchArgs', () => {
  it('prunes, and narrows to the tracked remote when there is one', () => {
    expect(buildUpdateFetchArgs('origin')).toEqual(['fetch', '--prune', 'origin']);
    expect(buildUpdateFetchArgs()).toEqual(['fetch', '--prune']);
    expect(buildUpdateFetchArgs('')).toEqual(['fetch', '--prune']);
  });
});

describe('buildIntegrateArgs', () => {
  it('merges plainly — no --no-ff, so an undiverged branch fast-forwards', () => {
    expect(buildIntegrateArgs('merge', 'origin/main')).toEqual(['merge', 'origin/main']);
  });

  it('rebases onto the tracking ref', () => {
    expect(buildIntegrateArgs('rebase', 'origin/main')).toEqual(['rebase', 'origin/main']);
  });

  it('targets the tracking ref, never a bare `git pull` that pull.rebase could redirect', () => {
    for (const s of ['merge', 'rebase'] as const) {
      expect(buildIntegrateArgs(s, 'origin/feature/x')[0]).not.toBe('pull');
      expect(buildIntegrateArgs(s, 'origin/feature/x')[1]).toBe('origin/feature/x');
    }
  });
});

describe('buildResetToRemoteArgs', () => {
  it('is a hard reset onto the tracking ref', () => {
    expect(buildResetToRemoteArgs('origin/main')).toEqual(['reset', '--hard', 'origin/main']);
  });
});

describe('buildUpdatePlan', () => {
  it('is fetch-then-integrate for the OK path', () => {
    expect(buildUpdatePlan('update', 'merge', 'origin/main', 'origin')).toEqual([
      ['fetch', '--prune', 'origin'],
      ['merge', 'origin/main'],
    ]);
    expect(buildUpdatePlan('update', 'rebase', 'origin/main', 'origin')).toEqual([
      ['fetch', '--prune', 'origin'],
      ['rebase', 'origin/main'],
    ]);
  });

  it('is fetch-then-reset for Reset to the Remote Branch, whatever the radio says', () => {
    for (const s of ['merge', 'rebase'] as const) {
      expect(buildUpdatePlan('reset', s, 'origin/main', 'origin')).toEqual([
        ['fetch', '--prune', 'origin'],
        ['reset', '--hard', 'origin/main'],
      ]);
    }
  });

  it('renders as the dialog shows it', () => {
    expect(formatGitCommands(buildUpdatePlan('update', 'rebase', 'origin/main', 'origin'))).toBe(
      'git fetch --prune origin && git rebase origin/main',
    );
  });
});
