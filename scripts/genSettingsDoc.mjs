/**
 * docs/settings.md generator (P10-T3): the doc is derived from package.json's
 * `contributes.configuration` + package.nls.json so it cannot drift from the
 * shipped settings. Regenerate with `npm run docs:settings`; the unit test
 * `test/unit/docs/settingsDoc.test.ts` fails whenever the committed file is
 * stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolves a `%key%` reference against package.nls.json. */
function nls(strings, value) {
  if (typeof value !== 'string') return value;
  const m = /^%(.+)%$/.exec(value);
  return m ? (strings[m[1]] ?? value) : value;
}

function fmtDefault(def) {
  if (def === undefined) return '—';
  return '`' + JSON.stringify(def) + '`';
}

/** @returns {string} the complete markdown document. */
export function generateSettingsDoc(pkg, strings) {
  const lines = [
    '# Geet settings',
    '',
    '<!-- GENERATED FILE — do not edit by hand. Derived from package.json',
    '     `contributes.configuration`; regenerate with `npm run docs:settings`.',
    '     test/unit/docs/settingsDoc.test.ts fails when this file is stale. -->',
    '',
    'All settings live under the `geet.` namespace: Geet was called GitTree',
    'before 0.1.0, and its settings kept the name. Geet owns its own views,',
    'change bars and commit window, so nothing here depends on — or changes —',
    'the built-in Git extension.',
    '',
  ];
  for (const section of pkg.contributes.configuration) {
    lines.push(`## ${nls(strings, section.title)}`, '');
    for (const [id, def] of Object.entries(section.properties)) {
      const type = Array.isArray(def.type) ? def.type.join(' \\| ') : def.type;
      lines.push(`### \`${id}\``, '');
      lines.push(`${nls(strings, def.description)}`, '');
      // POST-QA: a deprecated setting says so here as the Settings editor does.
      const deprecated = def.markdownDeprecationMessage ?? def.deprecationMessage;
      if (deprecated !== undefined) lines.push(`**Deprecated:** ${nls(strings, deprecated)}`, '');
      lines.push(`- Type: \`${type}\` · Default: ${fmtDefault(def.default)}`);
      if (def.minimum !== undefined) lines.push(`- Minimum: \`${def.minimum}\``);
      if (def.scope !== undefined) lines.push(`- Scope: \`${def.scope}\``);
      if (Array.isArray(def.enum)) {
        lines.push('- Values:');
        def.enum.forEach((v, i) => {
          const desc = def.enumDescriptions?.[i];
          lines.push(`  - \`${v}\`${desc !== undefined ? ` — ${nls(strings, desc)}` : ''}`);
        });
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function loadInputs(rootDir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(rootDir, f), 'utf8'));
  return { pkg: read('package.json'), strings: read('package.nls.json') };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(self).href) {
  const root = path.resolve(path.dirname(self), '..');
  const { pkg, strings } = loadInputs(root);
  const out = path.join(root, 'docs', 'settings.md');
  fs.writeFileSync(out, generateSettingsDoc(pkg, strings));
  console.log(`wrote ${out}`);
}
