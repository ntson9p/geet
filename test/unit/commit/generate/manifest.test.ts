/**
 * POST-P14cj, Generate Commit Message, as package.json declares it: the two
 * commands, where the palette offers them, and the three settings; and that
 * the code registers and reads the same names.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMIT_METHODS } from '../../../../src/shared/protocol';

const root = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

interface Setting {
  type?: string;
  default?: unknown;
  description?: string;
  editPresentation?: string;
}
const manifest = JSON.parse(read('package.json')) as {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
    keybindings: Array<{ command: string }>;
    configuration: Array<{ properties?: Record<string, Setting> }>;
  };
};
const nls = JSON.parse(read('package.nls.json')) as Record<string, string>;
const text = (raw: string | undefined): string => {
  const key = /^%(.+)%$/u.exec(raw ?? '')?.[1];
  return key !== undefined ? (nls[key] ?? '') : (raw ?? '');
};
const settings = Object.assign({}, ...manifest.contributes.configuration.map((s) => s.properties ?? {})) as Record<
  string,
  Setting
>;

const GENERATE = 'gittree.commit.generateMessage';
const CHOOSE = 'gittree.commit.chooseMessageModel';
/** Offered while Geet's setting is on and VS Code's AI features are not off. */
const WHEN = 'config.gittree.commit.messageGeneration.enabled && !config.chat.disableAIFeatures';

describe('Generate Commit Message, in the manifest', () => {
  it('has its command, named as VS Code names Copilot’s own, with the sparkle', () => {
    const command = manifest.contributes.commands.find((c) => c.command === GENERATE);
    expect(text(command?.title)).toBe('Generate Commit Message');
    expect(command?.category).toBe('Geet');
    expect(command?.icon).toBe('$(sparkle)');
  });

  it('has a command to choose the model again', () => {
    const command = manifest.contributes.commands.find((c) => c.command === CHOOSE);
    expect(text(command?.title)).toBe('Choose the Model for Commit Messages…');
    expect(command?.category).toBe('Geet');
  });

  it('offers both in the palette only while the setting is on and VS Code’s AI features are not off', () => {
    const palette = manifest.contributes.menus['commandPalette'] ?? [];
    for (const id of [GENERATE, CHOOSE]) {
      expect(palette.filter((m) => m.command === id).map((m) => m.when), id).toEqual([WHEN]);
    }
  });

  it('binds no key of its own: IntelliJ’s has none, and VS Code’s are taken', () => {
    expect(manifest.contributes.keybindings.filter((k) => k.command === GENERATE || k.command === CHOOSE)).toEqual([]);
  });

  it('is on by default, with no model named and no instructions', () => {
    expect(settings['gittree.commit.messageGeneration.enabled']).toMatchObject({ type: 'boolean', default: true });
    expect(settings['gittree.commit.messageGeneration.model']).toMatchObject({ type: 'string', default: '' });
    expect(settings['gittree.commit.messageGeneration.instructions']).toMatchObject({
      type: 'string',
      default: '',
      editPresentation: 'multilineText',
    });
  });

  it('says in the setting itself that the changes are sent to the model, and what else hides the button', () => {
    const enabled = text(settings['gittree.commit.messageGeneration.enabled']?.description);
    expect(enabled).toContain('those changes are sent to it');
    expect(enabled).toContain('chat.disableAIFeatures');
    expect(text(settings['gittree.commit.messageGeneration.model']?.description)).toContain('vendor/id');
    expect(text(settings['gittree.commit.messageGeneration.instructions']?.description)).toContain('$GIT_BRANCH_NAME');
  });
});

describe('Generate Commit Message, in the code', () => {
  it('registers the commands the manifest declares', () => {
    const register = read('src/commit/register.ts');
    expect(register).toContain(`register('${GENERATE}'`);
    expect(register).toContain(`register('${CHOOSE}'`);
  });

  it('reads the settings by the names the manifest gives them', () => {
    const generator = read('src/commit/generate/messageGenerator.ts');
    expect(generator).toContain("const SECTION = 'gittree.commit.messageGeneration';");
    for (const key of ['enabled', 'model', 'instructions']) {
      expect(generator, key).toContain(`'${key}'`);
      expect(settings[`gittree.commit.messageGeneration.${key}`], key).toBeDefined();
    }
    // The picker writes the choice where the setting is read from.
    expect(generator).toContain("writeSetting('gittree', 'commit.messageGeneration.model'");
    expect(generator).toContain("getConfiguration('chat').get<boolean>('disableAIFeatures')");
  });

  it('asks for a model only inside generate() and the picker, never when the window opens', () => {
    // VS Code may ask the user's consent when Copilot's models are first used,
    // so they are only ever asked for on a click or a command.
    const view = read('src/commit/window/commitWindowView.ts');
    expect(view).not.toContain('vscode.lm');
    expect(view).not.toContain('selectChatModels');
    const generator = read('src/commit/generate/messageGenerator.ts');
    expect(generator.match(/vscode\.lm\.selectChatModels\(\)/gu)).toHaveLength(2);
    // Both inside the one default source, which only generate() and chooseModel() call.
    expect(generator.match(/this\.source\(\)/gu)).toHaveLength(2);
  });

  it('names its two messages as the webview posts them', () => {
    expect(COMMIT_METHODS.generateMessage).toBe('commit/generateMessage');
    expect(COMMIT_METHODS.stopGenerating).toBe('commit/stopGenerating');
    const app = read('webview-ui/src/commit/App.tsx');
    expect(app).toContain('COMMIT_METHODS.generateMessage');
    expect(app).toContain('COMMIT_METHODS.stopGenerating');
  });
});
