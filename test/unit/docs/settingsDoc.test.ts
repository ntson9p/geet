/**
 * P10-T3: docs/settings.md is generated from package.json — this test keeps
 * the committed file honest. If it fails, run `npm run docs:settings`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSettingsDoc, loadInputs } from '../../../scripts/genSettingsDoc.mjs';

const root = path.resolve(__dirname, '../../..');

describe('docs/settings.md generation', () => {
  it('says a deprecated setting is deprecated, and why (POST-QA)', () => {
    const { pkg, strings } = loadInputs(root);
    const doc = generateSettingsDoc(pkg, strings);
    const section = doc.slice(doc.indexOf('### `geet.log.sort`'));
    expect(section.slice(0, section.indexOf('\n### ', 4))).toMatch(/\*\*Deprecated:\*\* Has no effect/u);
  });

  it('committed settings.md matches the generator output (run npm run docs:settings)', () => {
    const { pkg, strings } = loadInputs(root);
    const expected = generateSettingsDoc(pkg, strings);
    const committed = readFileSync(path.join(root, 'docs', 'settings.md'), 'utf8').replaceAll('\r\n', '\n');
    expect(committed).toBe(expected);
  });

  it('every setting id and every %nls% key resolves', () => {
    const { pkg, strings } = loadInputs(root);
    for (const section of pkg.contributes.configuration) {
      expect(section.title).toMatch(/^%.+%$/);
      expect(strings[section.title.slice(1, -1)]).toBeTypeOf('string');
      for (const [id, def] of Object.entries(section.properties)) {
        expect(id).toMatch(/^geet\./);
        expect(def.description).toMatch(/^%.+%$/);
        expect(strings[(def.description as string).slice(1, -1)]).toBeTypeOf('string');
        const deprecated = (def as { markdownDeprecationMessage?: string }).markdownDeprecationMessage;
        if (deprecated !== undefined) expect(strings[deprecated.slice(1, -1)]).toBeTypeOf('string');
      }
    }
  });
});
