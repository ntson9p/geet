/**
 * POST-P14bu: the borders in GitTree's side bar that a drag resizes are drawn as
 * a line, in the theme colour `gittree.sectionBorder`. These pin the colour's
 * contribution and the name the webviews read it under; what the lines look
 * like, and where, is the Playwright suites' (commit.spec.ts, branches.spec.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { themeColor } from '../../../webview-ui/src/lib/status';

const root = path.resolve(__dirname, '../../..');
const read = (...p: string[]): string => readFileSync(path.join(root, ...p), 'utf8');

interface ColorContribution {
  readonly id: string;
  readonly description: string;
  readonly defaults: Record<'light' | 'dark' | 'highContrast' | 'highContrastLight', string>;
}

const ID = 'gittree.sectionBorder';
const manifest = JSON.parse(read('package.json')) as { contributes: { colors: ColorContribution[] } };
const contribution = manifest.contributes.colors.find((c) => c.id === ID);
/** The CSS that draws the lines: the Commit window's, and the Repositories panel's. */
const STYLESHEETS = [
  ['webview-ui', 'src', 'commit', 'commit.css'],
  ['webview-ui', 'src', 'branches', 'branches.css'],
] as const;

/** `#rrggbbaa` → its alpha, 0..255; undefined for anything else. */
function alphaOf(hex: string): number | undefined {
  const m = /^#[0-9a-f]{6}([0-9a-f]{2})$/iu.exec(hex);
  return m ? parseInt(m[1]!, 16) : undefined;
}

describe('the section border colour (POST-P14bu)', () => {
  it('is contributed, with a default for every kind of theme', () => {
    expect(contribution).toBeDefined();
    expect(Object.keys(contribution!.defaults).sort()).toEqual(
      ['dark', 'highContrast', 'highContrastLight', 'light'].sort(),
    );
  });

  it('is see-through in the plain themes, so it lies on any side bar: lighter in a dark one, darker in a light one', () => {
    const { dark, light } = contribution!.defaults;
    expect(dark.slice(0, 7).toLowerCase()).toBe('#ffffff');
    expect(light.slice(0, 7).toLowerCase()).toBe('#000000');
    for (const value of [dark, light]) {
      const alpha = alphaOf(value);
      // Clearer than VS Code's own faint borders (about 5% in its Modern themes),
      // never as loud as text.
      expect(alpha).toBeGreaterThanOrEqual(0x26);
      expect(alpha).toBeLessThanOrEqual(0x4d);
    }
  });

  it("takes a high-contrast theme's own border colour", () => {
    expect(contribution!.defaults.highContrast).toBe('contrastBorder');
    expect(contribution!.defaults.highContrastLight).toBe('contrastBorder');
  });

  it('says where the lines are, and how to hide them', () => {
    const key = /^%(.+)%$/u.exec(contribution!.description)?.[1];
    expect(key).toBeDefined();
    const text = (JSON.parse(read('package.nls.json')) as Record<string, string>)[key!];
    expect(text).toContain('Commit view');
    expect(text).toContain('BRANCHES');
    expect(text).toContain('diff preview');
    expect(text).toContain('Transparent hides');
  });

  it('is read in the webviews under the name VS Code gives it: the first dot, the only one, a dash', () => {
    // VS Code replaces only the first dot of an id (see `themeColor`); one dot leaves a plain name.
    const name = '--vscode-gittree-sectionBorder';
    expect(themeColor(ID, 'x')).toBe(`var(${name}, var(${name}, x))`);
    for (const sheet of STYLESHEETS) {
      const css = read(...sheet);
      const uses = css.match(/--vscode-gittree-section[\w.\\-]*/gu) ?? [];
      expect(uses.length, sheet.join('/')).toBeGreaterThan(0);
      expect(new Set(uses), sheet.join('/')).toEqual(new Set([name]));
    }
  });

  it('draws each line as a border, which forced colours keep, with a fallback where VS Code sets no colour', () => {
    for (const sheet of STYLESHEETS) {
      const css = read(...sheet);
      const declarations = [...css.matchAll(/^[ \t]*([\w-]+):([^;\n]*--vscode-gittree-sectionBorder[^;\n]*);/gmu)];
      expect(declarations.length, sheet.join('/')).toBeGreaterThan(0);
      for (const [, property, value] of declarations) {
        expect(['border-top', 'border-top-color'], `${sheet.join('/')}: ${property}`).toContain(property);
        expect(value, `${sheet.join('/')}: ${property}`).toContain('var(--vscode-gittree-sectionBorder, ');
      }
    }
  });
});
