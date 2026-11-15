/**
 * POST-P14cl: three labels of the log's pickers read `Custom rangeâ€¦`,
 * `Browseâ€¦` and `Enter path or globâ€¦` — a UTF-8 `…` read as Windows-1252
 * and saved back. What ships is scanned for that kind of double encoding:
 * the source, the webviews' source, the manifest and its strings, and the
 * top-level documents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

/**
 * UTF-8 read as Windows-1252: `…` `–` `—` `’` `“` become `â€` and one more
 * character; `é` `ü` become `Ã` and one in U+0080–U+00BF; a no-break space or
 * `·` becomes `Â` and one in U+00A0–U+00BF.
 */
const DOUBLE_ENCODED = /â€|Ã[\u0080-¿]|Â[ -¿]/u;

function files(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') files(p, keep, out);
    } else if (keep(e.name)) out.push(p);
  }
  return out;
}

describe('shipped text is not double-encoded (POST-P14cl)', () => {
  const code = (name: string): boolean => /\.(ts|tsx|css|html)$/u.test(name);
  const shipped = [
    ...files(path.join(root, 'src'), code),
    ...files(path.join(root, 'webview-ui', 'src'), code),
    ...['package.json', 'README.md', 'CHANGELOG.md', 'FEATURES.md'].map((f) => path.join(root, f)),
    ...fs
      .readdirSync(root)
      .filter((f) => /^package\.nls(\.[\w-]+)?\.json$/u.test(f))
      .map((f) => path.join(root, f)),
  ];

  it('finds the files at all', () => {
    expect(shipped.length).toBeGreaterThan(200);
  });

  it('holds no UTF-8 read as Windows-1252 and saved back', () => {
    const found: string[] = [];
    for (const file of shipped) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = DOUBLE_ENCODED.exec(line);
        if (m) found.push(`${path.relative(root, file).replace(/\\/gu, '/')}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('would have caught the three labels', () => {
    expect(DOUBLE_ENCODED.test("vscode.l10n.t('Custom rangeâ€¦')")).toBe(true);
    expect(DOUBLE_ENCODED.test('cafÃ©')).toBe(true);
    // Real text in those letters is no match: São Paulo, Âge, a plain ellipsis.
    expect(DOUBLE_ENCODED.test('São Paulo — Âge … “quoted”')).toBe(false);
  });
});
