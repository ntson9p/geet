import { describe, expect, it } from 'vitest';
import type { StatusEntry } from '../../../src/core/git/parsers/statusV2';
import { formatGitCommands } from '../../../src/scm/dialogs/commandLine';
import {
  buildDetachArgs,
  buildIntegrateArgs,
  buildReattachArgs,
  buildResetToRemoteArgs,
  buildUpdatePlan,
  buildUpdateFetchArgs,
  buildUpdateQuestion,
  hasStagedChanges,
  hasStashableChanges,
  intentToAddPaths,
  normalizeStrategySetting,
  planSetAside,
  updateChoices,
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

describe('setting local changes aside (POST-P14ac)', () => {
  /** A porcelain-v2 entry, as `parseStatusV2` would produce it. */
  const entry = (
    path: string,
    x: string,
    y: string,
    kind: StatusEntry['kind'] = 'ordinary',
  ): StatusEntry => ({ kind, path, x, y, submodule: 'N...' });
  const edited = entry('src/a.ts', '.', 'M');
  const staged = entry('src/b.ts', 'M', '.');
  const halfStaged = entry('src/c.ts', 'M', 'M');
  const intentToAdd = entry('src/new.ts', '.', 'A');

  it('passes --autostash between the verb and the ref', () => {
    expect(buildIntegrateArgs('rebase', 'origin/main', true)).toEqual([
      'rebase',
      '--autostash',
      'origin/main',
    ]);
    expect(buildIntegrateArgs('merge', 'origin/main', true)).toEqual([
      'merge',
      '--autostash',
      'origin/main',
    ]);
  });

  it('recognises intent-to-add entries, and nothing else, as intent-to-add', () => {
    expect(intentToAddPaths([edited, staged, halfStaged, intentToAdd])).toEqual(['src/new.ts']);
    // A really staged new file is `A.`, not `.A` — it has content in the index.
    expect(intentToAddPaths([entry('src/staged-new.ts', 'A', '.')])).toEqual([]);
  });

  it('autostashes an edited tree, which a bare rebase refuses outright', () => {
    expect(planSetAside([edited], 'rebase', true)).toEqual({ autostash: true, detach: [] });
    expect(planSetAside([edited], 'merge', true)).toEqual({ autostash: true, detach: [] });
  });

  it('detaches intent-to-add entries, which git stash cannot save', () => {
    // Measured: with one of these present, --autostash dies with "Cannot
    // autostash" even though a plain merge succeeds — so they go around it.
    expect(planSetAside([edited, intentToAdd], 'merge', true)).toEqual({
      autostash: true,
      detach: ['src/new.ts'],
    });
  });

  it('never autostashes over staged content — it would come back unstaged', () => {
    // Measured: `MM` returns from an autostash as ` M`. Content survives, the
    // user's staging does not, so the plain command runs and git decides.
    for (const e of [staged, halfStaged]) {
      expect(planSetAside([e], 'rebase', true).autostash).toBe(false);
      expect(planSetAside([e], 'merge', true).autostash).toBe(false);
    }
    // An intent-to-add entry is not staged content: it has none.
    expect(hasStagedChanges([intentToAdd])).toBe(false);
  });

  it('only asks the merge half whether git can autostash (2.27)', () => {
    expect(planSetAside([edited], 'merge', false).autostash).toBe(false);
    expect(planSetAside([edited], 'rebase', false).autostash).toBe(true);
  });

  it('counts only what a stash would carry', () => {
    expect(hasStashableChanges([])).toBe(false);
    expect(hasStashableChanges([intentToAdd])).toBe(false);
    expect(hasStashableChanges([entry('x.txt', '.', '.', 'untracked')])).toBe(false);
    expect(hasStashableChanges([edited])).toBe(true);
  });

  it('wraps the integrate step, and only it, in the detach', () => {
    const aside = { autostash: true, detach: ['src/new.ts'] };
    expect(buildUpdatePlan('update', 'merge', 'origin/main', 'origin', aside)).toEqual([
      ['fetch', '--prune', 'origin'],
      ['rm', '--cached', '-q', '--', 'src/new.ts'],
      ['merge', '--autostash', 'origin/main'],
      ['add', '-N', '--', 'src/new.ts'],
    ]);
    expect(buildDetachArgs(['a', 'b'])).toEqual(['rm', '--cached', '-q', '--', 'a', 'b']);
    expect(buildReattachArgs(['a'])).toEqual(['add', '-N', '--', 'a']);
  });

  it('never sets anything aside around a reset, whose whole job is to discard it', () => {
    const aside = { autostash: true, detach: ['src/new.ts'] };
    expect(buildUpdatePlan('reset', 'merge', 'origin/main', 'origin', aside)).toEqual([
      ['fetch', '--prune', 'origin'],
      ['reset', '--hard', 'origin/main'],
    ]);
  });

  it('shows the set-aside in the question, per strategy', () => {
    const q = buildUpdateQuestion('merge', 'origin/main', 'origin', (s) =>
      s === 'rebase' ? { autostash: true, detach: [] } : { autostash: false, detach: [] },
    );
    expect(q.commands.rebase).toBe('git fetch --prune origin && git rebase --autostash origin/main');
    expect(q.commands.merge).toBe('git fetch --prune origin && git merge origin/main');
  });
});

describe('updateChoices (POST-P14ae)', () => {
  it('offers Reset for one repository, last', () => {
    expect(updateChoices('merge')).toEqual(['merge', 'rebase', 'reset']);
  });

  it('never offers Reset across several repositories', () => {
    // One button hard-resetting every repository at once is not a question
    // IntelliJ's single-repository dialog ever asked.
    expect(updateChoices('merge', false)).toEqual(['merge', 'rebase']);
    expect(updateChoices('rebase', false)).toEqual(['rebase', 'merge']);
  });
});
