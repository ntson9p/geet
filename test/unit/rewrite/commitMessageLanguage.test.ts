/**
 * POST-QA: the reword editor's language is Geet's own, so built-in Git's
 * Commit and Discard (`editorLangId == git-commit`) stay out of it, while its
 * highlighting is built-in Git's grammar, included.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMIT_MESSAGE_LANGUAGE } from '../../../src/rewrite/commitMessageLanguage';

const root = path.resolve(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    languages: { id: string; configuration?: string }[];
    grammars: { language: string; scopeName: string; path: string }[];
  };
};

describe('the commit-message language', () => {
  it('is not git-commit, whose editors built-in Git decorates with its own buttons', () => {
    expect(COMMIT_MESSAGE_LANGUAGE).not.toBe('git-commit');
  });

  it('is contributed, with a grammar that includes built-in Git’s', () => {
    expect(manifest.contributes.languages.map((l) => l.id)).toContain(COMMIT_MESSAGE_LANGUAGE);
    const grammar = manifest.contributes.grammars.find((g) => g.language === COMMIT_MESSAGE_LANGUAGE);
    expect(grammar).toBeDefined();
    const body = JSON.parse(readFileSync(path.join(root, grammar!.path), 'utf8')) as {
      scopeName: string;
      patterns: { include: string }[];
    };
    expect(body.scopeName).toBe(grammar!.scopeName);
    expect(body.patterns).toEqual([{ include: 'text.git-commit' }]);
  });

  it('ships its files: nothing under media/ is left out of the package', () => {
    const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8');
    expect(ignore).not.toMatch(/^media/mu);
    const lang = manifest.contributes.languages.find((l) => l.id === COMMIT_MESSAGE_LANGUAGE);
    expect(lang?.configuration).toMatch(/^\.\/media\//u);
  });
});
