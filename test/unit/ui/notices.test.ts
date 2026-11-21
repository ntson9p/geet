/**
 * new-way-6: Geet's information messages with nothing to click go through
 * `showInfo` (src/ui/notices.ts), which shows them for
 * `geet.notifications.durationSeconds` while VS Code is in front. That
 * module is vscode-bound, so this reads the sources and the manifest.
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTICE_SECONDS, MAX_NOTICE_SECONDS } from '../../../src/ui/noticeTiming';

const root = path.resolve(__dirname, '../../..');
const src = path.join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

/**
 * Every `showInformationMessage` with nothing to click: the message alone, or
 * with options that are not a modal dialog's. `file:line`, from src.
 */
function plainInformationMessages(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('showInformationMessage')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'showInformationMessage'
      ) {
        const rest = node.arguments.slice(1);
        const buttons = rest.filter((a) => !ts.isObjectLiteralExpression(a));
        const modal = rest.some(
          (a) =>
            ts.isObjectLiteralExpression(a) &&
            a.properties.some(
              (p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'modal' && p.initializer.getText(sf) === 'true',
            ),
        );
        if (buttons.length === 0 && !modal) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          found.push(`${path.relative(src, file).replace(/\\/g, '/')}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** The ordinary notifications kept on purpose, and why. */
const ORDINARY: Record<string, string> = {
  'ui/notices.ts': 'the setting at 0: ordinary notifications, as VS Code shows them',
  'core/core.ts': 'a one-time notice at startup, not about something just done: kept in the Notifications list',
  'merge/resolutionActions.ts': "the merge editor's Show Details: text asked for, kept as long as VS Code keeps it",
};

describe('Geet’s information messages with nothing to click', () => {
  it('all go through showInfo, but for the few kept ordinary on purpose', () => {
    const files = [...new Set(plainInformationMessages().map((w) => w.slice(0, w.lastIndexOf(':'))))].sort();
    expect(files).toEqual(Object.keys(ORDINARY).sort());
  });

  it('include the completion notices without buttons; those with buttons stay ordinary', () => {
    const notify = readFileSync(path.join(src, 'ui', 'notify.ts'), 'utf8');
    expect(notify).toMatch(/if \(kind === 'info' && actions\.length === 0\) \{\s*showInfo\(message\);\s*return;/u);
    expect(notify).toMatch(/vscode\.window\.showInformationMessage\(message, \.\.\.titles\)/u);
    expect(notify).toMatch(/vscode\.window\.showWarningMessage\(message, \.\.\.titles\)/u);
  });

  it('are written to the Geet output, since they leave no entry in the Notifications list', () => {
    const register = readFileSync(path.join(src, 'scm', 'register.ts'), 'utf8');
    expect(register).toMatch(/setNoticeLog\(\(line\) => core\.output\.appendLine\(line\)\)/u);
  });
});

describe('geet.notifications.durationSeconds', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    contributes: { configuration: Array<{ title: string; properties: Record<string, Record<string, unknown>> }> };
  };
  const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const section = manifest.contributes.configuration.find((s) => 'geet.notifications.durationSeconds' in s.properties);
  const setting = section?.properties['geet.notifications.durationSeconds'];

  it('is a number of seconds, five by default, from 0 to a minute, among the general settings', () => {
    expect(nls[section!.title.slice(1, -1)]).toBe('Geet');
    expect(setting).toMatchObject({
      type: 'number',
      default: DEFAULT_NOTICE_SECONDS,
      minimum: 0,
      maximum: MAX_NOTICE_SECONDS,
    });
  });

  it('says what 0 does, and where a notice that left can still be read', () => {
    const description = nls[String(setting!['description']).slice(1, -1)] ?? '';
    expect(description).toMatch(/\b0 shows them as ordinary notifications\b/u);
    expect(description).toMatch(/the "Geet" output keeps a copy/u);
    expect(description).toMatch(/Notifications list/u);
    expect(description).toMatch(/Messages with buttons, warnings and errors are always ordinary notifications/u);
  });
});
