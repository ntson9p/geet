/**
 * Changelog extractor (P10-T5): prints the `## [x.y.z]` section of
 * CHANGELOG.md for the given version — the GitHub Release notes body.
 * Usage: node scripts/extractChangelog.mjs 0.2.0 [file]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function extractChangelog(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const isHeader = (l) => /^## /.test(l);
  const start = lines.findIndex((l) => isHeader(l) && l.includes(`[${version}]`));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeader(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(self).href) {
  const version = process.argv[2];
  const file = process.argv[3] ?? path.resolve(path.dirname(self), '..', 'CHANGELOG.md');
  if (!version) {
    console.error('usage: extractChangelog.mjs <version> [changelog-path]');
    process.exit(1);
  }
  const section = extractChangelog(fs.readFileSync(file, 'utf8'), version);
  if (section === undefined) {
    console.error(`no CHANGELOG section found for [${version}]`);
    process.exit(1);
  }
  console.log(section);
}
