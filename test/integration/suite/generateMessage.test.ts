import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Phase03Registry } from '../../../src/commit/register';
import type { RepoHandle } from '../../../src/core/core';
import { activateGeet, waitFor, workspaceRepoC } from '../setup';

/**
 * POST-P14cj: Generate Commit Message, in a real extension host. The model is
 * a stand-in handed to the generator through its seam (`setModelSource`): the
 * Language Model API's own models must not be used in tests (they are rate
 * limited, and need an account), and a provider of our own cannot be
 * registered from here. What is real: the commands, the settings, the changes
 * read from git, the message box, and the cancellation.
 *
 * The suite ticks one new file in repoC and never commits: nothing is left
 * behind for the suites after it.
 */
suite('POST-P14cj Generate Commit Message', () => {
  let repoRoot: string;
  let repo: RepoHandle;
  let reg: Phase03Registry;
  const REL = 'p14cj/discount.ts';
  const SECTION = 'geet.commit.messageGeneration';

  /** What each stand-in was sent: the texts of the request's messages. */
  const sent: Array<{ model: string; messages: string[] }> = [];

  const textOf = (message: vscode.LanguageModelChatMessage): string =>
    message.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');

  /** A model that answers with `reply`, in two pieces, as a stream would. */
  function answering(id: string, reply: string): vscode.LanguageModelChat {
    return {
      name: `Stand-in ${id}`,
      id,
      vendor: 'test',
      family: 'stand-in',
      version: '1',
      maxInputTokens: 100_000,
      countTokens: (text: string | vscode.LanguageModelChatMessage) =>
        Promise.resolve(Math.ceil((typeof text === 'string' ? text : textOf(text)).length / 4)),
      sendRequest: (messages: vscode.LanguageModelChatMessage[]) => {
        sent.push({ model: id, messages: messages.map(textOf) });
        const half = Math.ceil(reply.length / 2);
        async function* text(): AsyncGenerator<string> {
          await Promise.resolve();
          yield reply.slice(0, half);
          yield reply.slice(half);
        }
        return Promise.resolve({ text: text(), stream: text() });
      },
    };
  }

  /** A model that never answers: it ends when the request is cancelled. */
  function waiting(id: string): vscode.LanguageModelChat {
    return {
      ...answering(id, ''),
      sendRequest: (messages: vscode.LanguageModelChatMessage[], _options: unknown, token: vscode.CancellationToken) => {
        sent.push({ model: id, messages: messages.map(textOf) });
        return new Promise((_resolve, reject) => {
          token.onCancellationRequested(() => reject(new vscode.CancellationError()));
        });
      },
    } as unknown as vscode.LanguageModelChat;
  }

  /** A model that turns the request down, as one out of quota does. */
  function refusing(id: string): vscode.LanguageModelChat {
    return {
      ...answering(id, ''),
      sendRequest: (messages: vscode.LanguageModelChatMessage[]) => {
        sent.push({ model: id, messages: messages.map(textOf) });
        return Promise.reject(vscode.LanguageModelError.Blocked('out of quota'));
      },
    };
  }

  const use = (...models: vscode.LanguageModelChat[]): void => reg.messageGenerator.setModelSource(() => Promise.resolve(models));
  const box = (): string => reg.messageBoxFor(repo).value;
  const setting = (key: string, value: unknown): Thenable<void> =>
    vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
  const tick = (checked: boolean): void => reg.changelistsFor(repo).setChecked([REL], checked);
  /** For repoC alone, into repoC's box: other suites' ticks in other repositories stay out of it. */
  const generate = (): Promise<string> => reg.commitWindow.generateMessage([repo.root], repo);

  suiteSetup(async function () {
    this.timeout(60_000);
    repoRoot = workspaceRepoC();
    const core = await activateGeet();
    repo = core.repoForPath(repoRoot)!;
    assert.ok(repo, 'repoC not discovered');
    reg = core.debugRegistry.get('phase03') as Phase03Registry;
    assert.ok(reg?.messageGenerator, 'phase03 registry has no message generator');
    if (reg.paradigm.paradigm !== 'changelists') {
      await reg.paradigm.switch();
      await waitFor(() => reg.paradigm.paradigm === 'changelists', 10_000);
    }
    fs.mkdirSync(path.join(repoRoot, path.dirname(REL)), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, REL),
      'export function discount(sum: number, code: string): number {\n  return code === "TEN" ? sum * 0.9 : sum;\n}\n',
    );
    await repo.refresher.refreshNow();
    await waitFor(() => reg.changelistsFor(repo).unversioned().includes(REL), 15_000);
  });

  setup(() => {
    sent.length = 0;
    reg.messageBoxFor(repo).value = 'typed before';
    tick(true);
  });

  suiteTeardown(async function () {
    this.timeout(60_000);
    reg.messageGenerator.setModelSource(undefined);
    await setting('enabled', undefined);
    await setting('model', undefined);
    await setting('instructions', undefined);
    tick(false);
    reg.messageBoxFor(repo).value = '';
    fs.rmSync(path.join(repoRoot, path.dirname(REL)), { recursive: true, force: true });
    await repo.refresher.refreshNow();
  });

  test('the window offers it while the setting is on, and not while it is off', async function () {
    this.timeout(30_000);
    assert.strictEqual(reg.commitWindow.buildState().messageGeneration, 'idle');
    await setting('enabled', false);
    try {
      await waitFor(() => reg.commitWindow.buildState().messageGeneration === undefined, 10_000);
    } finally {
      await setting('enabled', undefined);
    }
    await waitFor(() => reg.commitWindow.buildState().messageGeneration === 'idle', 10_000);
  });

  test('both commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('geet.commit.generateMessage'));
    assert.ok(commands.includes('geet.commit.chooseMessageModel'));
  });

  test('writes the message for what is ticked into the box, out of the fence the model wrapped it in', async function () {
    this.timeout(60_000);
    use(answering('one', '```text\nfeat: add the discount\n\nTEN takes a tenth off.\n```'));
    assert.strictEqual(await generate(), 'message');
    assert.strictEqual(box(), 'feat: add the discount\n\nTEN takes a tenth off.');
    assert.strictEqual(sent.length, 1);
    const [rules, request] = sent[0]!.messages;
    assert.ok(rules?.startsWith('You write git commit messages.'), rules);
    assert.ok(request?.includes(`A ${REL} (+3)`), request);
    assert.ok(request?.includes('+export function discount(sum: number, code: string): number {'), request);
    assert.ok(request?.startsWith('Repository: '), request);
    // Idle again, and the trail says which model wrote it.
    assert.strictEqual(reg.commitWindow.isGenerating, false);
    assert.ok(reg.commitWindow.debugTrail.some((l) => l === 'generated a message with Stand-in one'));
  });

  test('adds the author’s own instructions, with the branch in place of $GIT_BRANCH_NAME', async function () {
    this.timeout(60_000);
    use(answering('one', 'feat: x'));
    await setting('instructions', 'Start with [$GIT_BRANCH_NAME].');
    try {
      assert.strictEqual(await generate(), 'message');
    } finally {
      await setting('instructions', undefined);
    }
    const rules = sent[0]!.messages[0] ?? '';
    const branch = repo.model.snapshot.detached ? 'HEAD' : (repo.model.snapshot.headRef ?? 'HEAD');
    assert.ok(rules.endsWith(`Start with [${branch}].`), rules.slice(-200));
  });

  test('with nothing ticked, says so and asks no model', async function () {
    this.timeout(60_000);
    use(answering('one', 'feat: x'));
    tick(false);
    assert.strictEqual(await generate(), 'nothing');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(box(), 'typed before');
  });

  test('with no model at all, writes nothing', async function () {
    this.timeout(60_000);
    use();
    assert.strictEqual(await generate(), 'nothing');
    assert.strictEqual(box(), 'typed before');
  });

  test('uses the model the setting names, without asking', async function () {
    this.timeout(60_000);
    use(answering('first', 'feat: from the first'), answering('second', 'feat: from the second'));
    await setting('model', 'test/second');
    try {
      assert.strictEqual(await generate(), 'message');
    } finally {
      await setting('model', undefined);
    }
    assert.deepStrictEqual(
      sent.map((s) => s.model),
      ['second'],
    );
    assert.strictEqual(box(), 'feat: from the second');
  });

  test('Stop ends it with nothing written, and a second ask meanwhile starts nothing', async function () {
    this.timeout(60_000);
    use(waiting('slow'));
    const running = generate();
    await waitFor(() => sent.length === 1, 20_000);
    assert.strictEqual(reg.commitWindow.isGenerating, true);
    assert.strictEqual(reg.commitWindow.buildState().messageGeneration, 'running');
    // The webview posts a request again after a rehydrate: it must not start another.
    assert.strictEqual(await generate(), 'stopped');
    assert.strictEqual(sent.length, 1);

    reg.commitWindow.stopGenerating();
    assert.strictEqual(await running, 'stopped');
    assert.strictEqual(box(), 'typed before');
    assert.strictEqual(reg.commitWindow.buildState().messageGeneration, 'idle');
  });

  test('a model that turns the request down leaves the box alone', async function () {
    this.timeout(60_000);
    use(refusing('broke'));
    assert.strictEqual(await generate(), 'nothing');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(box(), 'typed before');
    assert.strictEqual(reg.commitWindow.isGenerating, false);
  });

  test('the bare command writes into the box on screen', async function () {
    this.timeout(60_000);
    use(answering('one', 'feat: by the command'));
    // The box on screen is the editor's repository's, else the first one's:
    // which repositories it describes depends on what other suites left ticked,
    // so only that it asked once and wrote the answer there is checked.
    const boxRepo = reg.commitWindow.messageRepo();
    assert.ok(boxRepo, 'no repository for the message box');
    const before = reg.messageBoxFor(boxRepo).value;
    try {
      await vscode.commands.executeCommand('geet.commit.generateMessage');
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(reg.messageBoxFor(boxRepo).value, 'feat: by the command');
    } finally {
      reg.messageBoxFor(boxRepo).value = before;
    }
  });
});
