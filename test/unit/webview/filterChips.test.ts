import { describe, expect, it } from 'vitest';
import type { LogFilterDto, LogRootDto } from '../../../src/shared/protocol';
import {
  MAX_CHIP_VALUE,
  authorName,
  branchChip,
  dateChip,
  displayableText,
  hasFilters,
  missingRefsText,
  pathsChip,
  resetFilters,
  userChip,
} from '../../../webview-ui/src/log/filterChips';

const base: LogFilterDto = { sort: 'date', refs: 'HEAD' };
const BEN = 'Ben Okafor <ben@sandbox.invalid>';
const ROOTS: LogRootDto[] = [
  { root: '/w/local', label: 'local', colorIdx: 0 },
  { root: '/w/local - Copy', label: 'local - Copy', colorIdx: 1 },
];

describe("displayableText (IntelliJ's own value shortening)", () => {
  it('shows one value as it is and joins several with |', () => {
    expect(displayableText(['main'])).toBe('main');
    expect(displayableText(['main', 'dev'])).toBe('main|dev');
  });

  it('cuts anything longer than 20 characters, ending in …', () => {
    expect(MAX_CHIP_VALUE).toBe(20);
    const exactly = 'a'.repeat(20);
    expect(displayableText([exactly])).toBe(exactly);
    const cut = displayableText(['feature/priority', 'main']);
    expect(cut).toBe('feature/priority|ma…');
    expect(cut).toHaveLength(20);
  });
});

describe('authorName', () => {
  it('drops the e-mail', () => {
    expect(authorName(BEN)).toBe('Ben Okafor');
    expect(authorName('  Đặng Trần Côn <dtc@example.jp> ')).toBe('Đặng Trần Côn');
  });

  it('keeps an author that is only an e-mail, or no e-mail at all', () => {
    expect(authorName('<ben@sandbox.invalid>')).toBe('ben@sandbox.invalid');
    expect(authorName('ben@sandbox.invalid')).toBe('ben@sandbox.invalid');
    expect(authorName('Ben')).toBe('Ben');
  });
});

describe('the chips, compact (the default, D39)', () => {
  it('Branch: nothing for HEAD, All, the names cut short, a comparison by its ends', () => {
    expect(branchChip(base, 'compact')).toEqual({ value: undefined, full: undefined });
    expect(branchChip({ ...base, refs: 'ALL' }, 'compact')).toEqual({ value: 'All', full: 'All branches' });
    expect(branchChip({ ...base, refs: ['feature/priority', 'main'] }, 'compact')).toEqual({
      value: 'feature/priority|ma…',
      full: 'feature/priority, main',
    });
    expect(branchChip({ ...base, range: { a: 'feature/f1', b: 'main' } }, 'compact')).toEqual({
      value: 'feature/f1...main',
      full: 'feature/f1...main',
    });
    // An update's Show in Log: two hashes, written short.
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    expect(branchChip({ ...base, range: { a, b } }, 'compact').value).toBe('aaaaaaa...bbbbbbb');
  });

  it('User: the name without the e-mail, and you as me', () => {
    expect(userChip(base, 'compact')).toEqual({ value: undefined, full: undefined });
    expect(userChip({ ...base, authors: [BEN] }, 'compact', 'me@x.dev')).toEqual({ value: 'Ben Okafor', full: BEN });
    // The dropdown's `Me` row filters by your user.email…
    expect(userChip({ ...base, authors: ['me@x.dev'] }, 'compact', 'me@x.dev').value).toBe('me');
    // …and picking yourself from the list by name is you too.
    expect(userChip({ ...base, authors: ['Ann Me <me@x.dev>', BEN] }, 'compact', 'me@x.dev').value).toBe(
      'me|Ben Okafor',
    );
    expect(userChip({ ...base, authors: [BEN, 'Ava Tran <ava@x.dev>'] }, 'compact').value).toBe('Ben Okafor|Ava Tran');
  });

  it("Date: IntelliJ's words, and the Date column's way of writing a day", () => {
    expect(dateChip(base, 'compact', 'YYYY/MM/DD HH:mm')).toEqual({ value: undefined, full: undefined });
    expect(dateChip({ ...base, dateRange: { from: '2026-10-31' } }, 'compact', 'YYYY/MM/DD HH:mm')).toEqual({
      value: 'Since 2026/10/31',
      full: '2026-10-31 → …',
    });
    expect(dateChip({ ...base, dateRange: { to: '2026-11-05' } }, 'compact', 'YYYY/MM/DD HH:mm').value).toBe(
      'Until 2026/11/05',
    );
    expect(
      dateChip({ ...base, dateRange: { from: '2026-10-31', to: '2026-11-05' } }, 'compact', 'YYYY/MM/DD HH:mm').value,
    ).toBe('2026/10/31–2026/11/05');
    expect(dateChip({ ...base, dateRange: { from: '2026-10-31' } }, 'compact', 'locale', 'en-US').value).toBe(
      'Since 10/31/2026',
    );
  });

  it('Paths: the repository when there is a choice, then each path by its last part', () => {
    expect(pathsChip(base, 'compact', ROOTS.slice(0, 1), '/w/local')).toEqual({ value: undefined, full: undefined });
    expect(pathsChip(base, 'compact', ROOTS, '/w/local - Copy')).toEqual({
      value: 'local - Copy',
      full: 'local - Copy',
    });
    expect(pathsChip({ ...base, paths: ['src/main/ui.ts', 'docs/'] }, 'compact', ROOTS, '/w/local')).toEqual({
      value: 'local|ui.ts|docs',
      full: 'local, src/main/ui.ts, docs/',
    });
  });

  it("POST-P14ck: Paths shows a picked file by its name, not the `:(literal)` git is told it with", () => {
    const f: LogFilterDto = { ...base, paths: [':(literal)app/[id]/page.tsx', ':(literal)[id].tsx'] };
    expect(pathsChip(f, 'compact', ROOTS.slice(0, 1), '/w/local')).toEqual({
      value: 'page.tsx|[id].tsx',
      full: 'app/[id]/page.tsx, [id].tsx',
    });
    // A typed pattern is shown as it was typed.
    const typed: LogFilterDto = { ...base, paths: [':(literal)[id].tsx', 'src/*.ts'] };
    expect(pathsChip(typed, 'full', ROOTS.slice(0, 1), '/w/local').value).toBe('[id].tsx, src/*.ts');
  });
});

describe('the chips, full (the look before, `gittree.log.filterChips: full`)', () => {
  it('writes every value out, as the row always did', () => {
    expect(branchChip({ ...base, refs: ['a', 'b'] }, 'full').value).toBe('a, b');
    expect(branchChip({ ...base, refs: ['a', 'b', 'c'] }, 'full').value).toBe('3 refs');
    expect(branchChip({ ...base, refs: 'ALL' }, 'full').value).toBe('All');
    expect(userChip({ ...base, authors: [BEN] }, 'full', 'ben@sandbox.invalid').value).toBe(BEN);
    expect(dateChip({ ...base, dateRange: { from: '2026-10-31' } }, 'full', 'YYYY/MM/DD HH:mm').value).toBe(
      '2026-10-31 → …',
    );
    expect(pathsChip({ ...base, paths: ['src/main/ui.ts'] }, 'full', ROOTS, '/w/local').value).toBe(
      'local, src/main/ui.ts',
    );
  });

  it('gives the tooltip the same whole value either way', () => {
    const f: LogFilterDto = { ...base, refs: ['feature/priority', 'main'], authors: [BEN] };
    expect(branchChip(f, 'full').full).toBe(branchChip(f, 'compact').full);
    expect(userChip(f, 'full').full).toBe(userChip(f, 'compact').full);
  });
});

describe('hasFilters / resetFilters', () => {
  it('counts what Reset filters clears, and not how the graph is drawn', () => {
    expect(hasFilters(base)).toBe(false);
    expect(hasFilters({ sort: 'topo' })).toBe(false);
    expect(hasFilters({ ...base, firstParent: true })).toBe(false);
    expect(hasFilters({ ...base, text: { q: '', regex: false, matchCase: false } })).toBe(false);
    for (const f of [
      { ...base, refs: 'ALL' as const },
      { ...base, refs: ['main'] },
      { ...base, range: { a: 'a', b: 'b' } },
      { ...base, authors: [BEN] },
      { ...base, dateRange: { from: '2026-10-31' } },
      { ...base, paths: ['src'] },
      { ...base, text: { q: 'fix', regex: false, matchCase: false } },
      { ...base, noMerges: true },
    ]) {
      expect(hasFilters(f), JSON.stringify(f)).toBe(true);
    }
  });

  it("goes back to HEAD's history, keeping the sort and First Parent", () => {
    const busy: LogFilterDto = {
      sort: 'topo',
      refs: ['main'],
      authors: [BEN],
      noMerges: true,
      firstParent: true,
      paths: ['src'],
    };
    expect(resetFilters(busy)).toEqual({ sort: 'topo', refs: 'HEAD', firstParent: true });
    expect(resetFilters({ sort: 'date', refs: 'ALL' })).toEqual({ sort: 'date', refs: 'HEAD' });
  });
});

describe('missingRefsText (the empty log)', () => {
  it('names what the repository lacks', () => {
    expect(missingRefsText([])).toBeUndefined();
    expect(missingRefsText(['feature/priority'])).toBe('Not in this repository: feature/priority');
    expect(missingRefsText(['a', 'c'.repeat(40)])).toBe('Not in this repository: a, ccccccc');
  });
});
