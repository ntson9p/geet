/**
 * POST-QA: a count is singular or plural — `1 file`, `3 files` — never
 * `1 file(s)`. The counted nouns live in src/ui/counts.ts (vscode-bound, so
 * this scans the sources instead): no message the user reads may say `(s)`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The string argument of every `l10n.t(…)` in `text`, single- or multi-line. */
function l10nStrings(text: string): string[] {
  const out: string[] = [];
  const re = /l10n\.t\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gsu;
  for (const m of text.matchAll(re)) out.push(m[2] ?? '');
  return out;
}

describe('counted nouns', () => {
  it('finds the strings it checks — a bare sanity check of the scan', () => {
    expect(l10nStrings("vscode.l10n.t('Stage {0} file(s)', n); vscode.l10n.t(\n  'two',\n)")).toEqual([
      'Stage {0} file(s)',
      'two',
    ]);
  });

  it('no l10n string says file(s), commit(s) or the like', () => {
    const root = path.resolve(__dirname, '../../../src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          for (const s of l10nStrings(readFileSync(p, 'utf8'))) {
            if (/\w\(s\)/u.test(s)) hits.push(`${path.relative(root, p)}: ${s}`);
          }
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
