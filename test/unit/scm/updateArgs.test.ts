import { describe, expect, it } from 'vitest';
import { formatGitCommands } from '../../../src/scm/dialogs/commandLine';
import {
  buildIntegrateArgs,
  buildResetToRemoteArgs,
  buildUpdatePlan,
  buildUpdateFetchArgs,
  buildUpdateQuestion,
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

describe('buildUpdateQuestion (POST-P14ab)', () => {
  it('offers the remembered strategy first, so Enter repeats it', () => {
    // The first button of a modal is its default. IntelliJ pre-selects the
    // radio you used last and OK runs it; this is the same gesture.
    expect(buildUpdateQuestion('merge', 'origin/main', 'origin').choices).toEqual([
      'merge',
      'rebase',
      'reset',
    ]);
    expect(buildUpdateQuestion('rebase', 'origin/main', 'origin').choices).toEqual([
      'rebase',
      'merge',
      'reset',
    ]);
  });

  it('never lets Enter reach Reset to the Remote Branch', () => {
    for (const remembered of ['merge', 'rebase'] as const) {
      const { choices } = buildUpdateQuestion(remembered, 'origin/main', 'origin');
      expect(choices[0]).not.toBe('reset');
      expect(choices[choices.length - 1]).toBe('reset');
    }
  });

  it('describes each button with the exact commands the host runs', () => {
    const { commands } = buildUpdateQuestion('merge', 'origin/feature/x', 'origin');
    expect(commands.merge).toBe(
      formatGitCommands(buildUpdatePlan('update', 'merge', 'origin/feature/x', 'origin')),
    );
    expect(commands.rebase).toBe('git fetch --prune origin && git rebase origin/feature/x');
    expect(commands.reset).toBe('git fetch --prune origin && git reset --hard origin/feature/x');
  });
});
