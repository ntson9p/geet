/**
 * Generate Commit Message (POST-P14cj): a language model writes the message
 * for what the Commit window is about to commit. IntelliJ's AI Assistant has
 * it as *Generate Commit Message with AI Assistant*, in the Commit tool window.
 *
 * The model is one VS Code already has (`vscode.lm`, the Language Model API):
 * Copilot's once the user is signed in, or any that another extension or a key
 * of their own adds under *Chat: Manage Language Models*. GitTree holds no key
 * and talks to no service itself. VS Code asks the user's consent the first
 * time an extension uses Copilot's models, which is why a model is only ever
 * asked for here, on a click or a command, and never when a view opens.
 *
 * What is sent: the diff of the changes being committed (`collectChanges`),
 * the repository's name and branch, and the subjects of its recent commits.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { anyToken } from '../../core/util/cancellation';
import { repoLabels } from '../../core/util/repoLabels';
import { showInfo } from '../../ui/notices';
import { writeSetting } from '../../ui/writeSetting';
import type { ChangelistService } from '../changelists/changelistService';
import { hasCommittableChanges, planCommit, resolveTarget } from '../commitFlow';
import { generationScope } from '../commitScope';
import type { CommitService } from '../commitService';
import { recentCommitMessages } from '../messageHistory';
import type { ParadigmManager } from '../paradigmManager';
import type { InclusionModel } from '../window/inclusion';
import type { ChangeDiff } from './changeDiff';
import { CollectCancelled, collectChanges, type CollectRequest } from './collectChanges';
import { diffBudgetFor, findModel, modelKey, modelWithoutAsking, orderModels, shrunkBudget } from './modelChoice';
import { buildPrompt, cleanMessage, RECENT_SUBJECTS, type BuiltPrompt, type PromptRepo } from './prompt';

export interface MessageGeneratorDeps {
  core: Core;
  paradigm: ParadigmManager;
  changelistsFor(repo: RepoHandle): ChangelistService;
  commitService: CommitService;
  inclusion: InclusionModel;
}

export interface GenerateRequest {
  /** The repository whose message box is on screen: where the message goes, and whose Amend counts first. */
  readonly messageRepo: RepoHandle;
  /** Canonical keys of the repositories the Commit window lists, when its list is narrowed. */
  readonly roots?: ReadonlySet<string>;
}

export type GenerateResult =
  /** The message, and the model that wrote it. */
  | { readonly kind: 'message'; readonly message: string; readonly model: string }
  /** Stopped by the user, or the model picker was closed. */
  | { readonly kind: 'stopped' }
  /** Nothing to write, or nothing to write it with; the user was told which. */
  | { readonly kind: 'nothing' };

/** A repository being committed, and what the model is told of it. */
interface DescribedRepo {
  readonly repo: RepoHandle;
  readonly prompt: PromptRepo;
}

/** Where the models come from: VS Code, or a test's stand-in. */
export type ModelSource = () => Thenable<readonly vscode.LanguageModelChat[]>;

const SECTION = 'gittree.commit.messageGeneration';
/** A commit message is short: an answer running past this is cut off, not waited for. */
const MAX_ANSWER_CHARS = 20_000;
/** How often the request is rebuilt smaller when the model counts more tokens than it takes. */
const FIT_ATTEMPTS = 3;

/** VS Code's own commands, offered only where this VS Code has them. */
const MANAGE_MODELS = 'workbench.action.chat.manage';
const SET_UP_CHAT = 'workbench.action.chat.triggerSetup';
const MANAGE_ACCESS = 'workbench.action.chat.manageLanguageModelAuthentication';

/** `gittree.commit.messageGeneration.enabled`, on unless set off. */
export function generationEnabled(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('enabled', true) !== false;
}

/** VS Code's own switch for every AI feature (`chat.disableAIFeatures`): off there is off here. */
export function aiDisabledInVsCode(): boolean {
  return vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures') === true;
}

/** Whether the Commit window offers the button at all. */
export function generationOffered(): boolean {
  return generationEnabled() && !aiDisabledInVsCode();
}

export class MessageGenerator {
  private source: ModelSource = () => vscode.lm.selectChatModels();

  constructor(private readonly deps: MessageGeneratorDeps) {}

  /** Test seam: models that are not VS Code's. `undefined` puts VS Code's back. */
  setModelSource(source: ModelSource | undefined): void {
    this.source = source ?? (() => vscode.lm.selectChatModels());
  }

  // ---- what is described ------------------------------------------------------

  /**
   * The repositories a Commit pressed now would commit, with each one's
   * changes read from git. Empty when nothing is ticked (or staged).
   */
  private async describe(request: GenerateRequest, token: vscode.CancellationToken): Promise<DescribedRepo[]> {
    const { core } = this.deps;
    const inScope = (r: RepoHandle): boolean => request.roots === undefined || request.roots.has(canonicalKey(r.root));
    const candidates = core.repos.filter(inScope);
    if (candidates.length === 0) return [];
    const participants = candidates.filter((r) => hasCommittableChanges(this.deps, r));
    const isAmend = (r: RepoHandle): boolean => this.deps.commitService.isAmend(r);
    const targets = generationScope(request.messageRepo, participants, candidates, inScope, isAmend);
    const labels = repoLabels(core.repos.map((r) => r.root));

    const out: DescribedRepo[] = [];
    for (const { repo, amend } of targets) {
      if (!inScope(repo)) continue;
      const snapshot = repo.model.snapshot;
      const amending = amend && !snapshot.initial;
      const target = resolveTarget(this.deps, repo);
      // Nothing ticked: with changelists there is no commit to write for, Amend
      // or not (*No checked files to commit*). With the staging area an Amend
      // of the last commit alone is one.
      if (target === undefined && (!amending || this.deps.paradigm.paradigm !== 'staging')) continue;
      let collect: CollectRequest;
      if (target === undefined || target.mode === 'staged') {
        // The index; with nothing staged and Amend ticked, the last commit alone.
        collect = { mode: 'staged', amend: amending, unborn: snapshot.initial, wholePaths: [], untrackedPaths: [], partials: [] };
      } else {
        const plan = await planCommit(this.deps, repo, target);
        const whole = new Set(plan.wholePaths);
        collect = {
          mode: 'changelists',
          amend: amending,
          unborn: snapshot.initial,
          wholePaths: plan.wholePaths,
          untrackedPaths: target.untrackedRelPaths.filter((p) => whole.has(p)),
          partials: plan.partials,
        };
      }
      const changes = await this.read(repo, collect, token);
      if (changes.length === 0 && !amending) continue;
      const amended = amending ? (await recentCommitMessages(repo, 1))[0]?.message : undefined;
      out.push({
        repo,
        prompt: {
          name: labels.get(repo.root) ?? path.basename(repo.root),
          ...(!snapshot.detached && snapshot.headRef !== undefined ? { branch: snapshot.headRef } : {}),
          ...(amended !== undefined ? { amendedMessage: amended } : {}),
          changes,
        },
      });
    }
    return out;
  }

  /** A read on the repository's queue: run again whole if a mutation interrupts it. */
  private read(repo: RepoHandle, collect: CollectRequest, token: vscode.CancellationToken): Promise<ChangeDiff[]> {
    return repo.queue.enqueue({
      label: 'read the changes for a commit message',
      kind: 'read',
      run: async (git, queueToken) => {
        const joined = anyToken(queueToken, token);
        try {
          return await collectChanges(git, repo.root, collect, undefined, joined.token);
        } finally {
          joined.dispose();
        }
      },
    });
  }

  // ---- the model ----------------------------------------------------------------

  private wantedModel(): string | undefined {
    return vscode.workspace.getConfiguration(SECTION).get<string>('model');
  }

  /**
   * The model picker: every model VS Code has, the current one marked. The
   * choice is kept in the setting. Nothing when it is closed, or there is no model.
   */
  async chooseModel(
    known?: readonly vscode.LanguageModelChat[],
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChat | undefined> {
    const models = known ?? (await this.source());
    if (models.length === 0) {
      void this.tellNoModels();
      return undefined;
    }
    const current = findModel(models, this.wantedModel());
    const items = orderModels(models).map((model) => ({
      label: model.name,
      description: model === current ? vscode.l10n.t('{0} · in use', model.vendor) : model.vendor,
      detail: vscode.l10n.t('{0} · takes up to {1} tokens', model.id, model.maxInputTokens.toLocaleString('en-US')),
      model,
    }));
    const picked = await vscode.window.showQuickPick(
      items,
      {
        title: vscode.l10n.t('Model for Commit Messages'),
        placeHolder: vscode.l10n.t('The changes being committed are sent to the model you choose'),
        matchOnDescription: true,
        matchOnDetail: true,
      },
      token,
    );
    if (picked === undefined) return undefined;
    await writeSetting('gittree', 'commit.messageGeneration.model', modelKey(picked.model));
    return picked.model;
  }

  /** No model at all: say what gives VS Code one, with its own commands where it has them. */
  private async tellNoModels(): Promise<void> {
    const known = new Set(await vscode.commands.getCommands(true));
    const setUp = vscode.l10n.t('Set Up Copilot');
    const manage = vscode.l10n.t('Manage Language Models');
    const actions = [...(known.has(SET_UP_CHAT) ? [setUp] : []), ...(known.has(MANAGE_MODELS) ? [manage] : [])];
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'No language model is available to write the commit message. Sign in to GitHub Copilot, or add a model in VS Code.',
      ),
      ...actions,
    );
    if (choice === setUp) await vscode.commands.executeCommand(SET_UP_CHAT);
    else if (choice === manage) await vscode.commands.executeCommand(MANAGE_MODELS);
  }

  /** A request the model, or VS Code, turned down: what it said, and what can be done about it. */
  private async tellFailure(err: unknown, model: vscode.LanguageModelChat): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof vscode.LanguageModelError) {
      if (err.code === vscode.LanguageModelError.NoPermissions.name) {
        const known = new Set(await vscode.commands.getCommands(true));
        const access = vscode.l10n.t('Manage Access');
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t('GitTree was not allowed to use {0}, so no commit message was written.', model.name),
          ...(known.has(MANAGE_ACCESS) ? [access] : []),
        );
        if (choice === access) await vscode.commands.executeCommand(MANAGE_ACCESS);
        return;
      }
      if (err.code === vscode.LanguageModelError.NotFound.name) {
        const choose = vscode.l10n.t('Choose a Model');
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t('{0} is no longer available, so no commit message was written.', model.name),
          choose,
        );
        if (choice === choose) await this.chooseModel();
        return;
      }
      if (err.code === vscode.LanguageModelError.Blocked.name) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('{0} refused the request, so no commit message was written: {1}', model.name, detail),
        );
        return;
      }
    }
    void vscode.window.showErrorMessage(
      vscode.l10n.t('{0} could not write the commit message: {1}', model.name, detail),
    );
  }

  /** The request, made smaller until the model's own count says it fits. */
  private async fit(
    model: vscode.LanguageModelChat,
    repos: readonly PromptRepo[],
    recentSubjects: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<BuiltPrompt> {
    const instructions = vscode.workspace.getConfiguration(SECTION).get<string>('instructions') ?? '';
    let budget = diffBudgetFor(model.maxInputTokens);
    let prompt = buildPrompt({ repos, recentSubjects, instructions, diffBudget: budget });
    for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt++) {
      let counted: number;
      try {
        counted = await model.countTokens(`${prompt.rules}\n${prompt.request}`, token);
      } catch {
        break; // a model that cannot count is sent the estimate
      }
      if (counted <= model.maxInputTokens * 0.9) break;
      budget = shrunkBudget(budget, counted, model.maxInputTokens);
      prompt = buildPrompt({ repos, recentSubjects, instructions, diffBudget: budget });
    }
    return prompt;
  }

  // ---- the whole of it ----------------------------------------------------------

  /**
   * Writes the commit message for what a Commit pressed now would commit.
   * Never throws: what goes wrong is told to the user, and comes back as
   * `nothing`. Must be called from a user's own action: VS Code may ask for
   * consent to use the model.
   */
  async generate(request: GenerateRequest, token: vscode.CancellationToken): Promise<GenerateResult> {
    const stopped: GenerateResult = { kind: 'stopped' };
    const nothing: GenerateResult = { kind: 'nothing' };
    // The button and the palette's entry are gone while either is off; a key
    // bound to the command, or another extension, can still ask.
    // Plain notices, timed as GitTree's others are (`showInfo`).
    if (aiDisabledInVsCode()) {
      showInfo(
        vscode.l10n.t('AI features are turned off in VS Code (chat.disableAIFeatures), so no commit message was written.'),
      );
      return nothing;
    }
    if (!generationEnabled()) {
      showInfo(
        vscode.l10n.t(
          'Generate Commit Message is turned off (gittree.commit.messageGeneration.enabled), so no commit message was written.',
        ),
      );
      return nothing;
    }

    let described: DescribedRepo[];
    try {
      described = await this.describe(request, token);
    } catch (err) {
      if (err instanceof CollectCancelled || token.isCancellationRequested) return stopped;
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not read the changes to write a commit message for: {0}', err instanceof Error ? err.message : String(err)),
      );
      return nothing;
    }
    if (token.isCancellationRequested) return stopped;
    if (described.length === 0) {
      showInfo(
        this.deps.paradigm.paradigm === 'staging'
          ? vscode.l10n.t('Nothing staged to write a commit message for.')
          : vscode.l10n.t('Nothing ticked to write a commit message for.'),
      );
      return nothing;
    }

    let model: vscode.LanguageModelChat | undefined;
    try {
      const models = await this.source();
      if (token.isCancellationRequested) return stopped;
      if (models.length === 0) {
        // Not waited for: the notification stays up as long as the user leaves it.
        void this.tellNoModels();
        return nothing;
      }
      model = modelWithoutAsking(models, this.wantedModel()) ?? (await this.chooseModel(models, token));
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not list the language models: {0}', err instanceof Error ? err.message : String(err)),
      );
      return nothing;
    }
    if (model === undefined || token.isCancellationRequested) return stopped;

    try {
      // Style comes from the first repository's history; an amended commit's own
      // message is given apart, so it is not also an example.
      const first = described[0];
      const recent = first !== undefined ? await recentCommitMessages(first.repo, RECENT_SUBJECTS + 1) : [];
      const subjects = recent.map((c) => c.subject).slice(first?.prompt.amendedMessage !== undefined ? 1 : 0);
      const prompt = await this.fit(
        model,
        described.map((d) => d.prompt),
        subjects,
        token,
      );
      if (token.isCancellationRequested) return stopped;

      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt.rules), vscode.LanguageModelChatMessage.User(prompt.request)],
        {
          justification: vscode.l10n.t(
            'GitTree sends the changes you are about to commit to this model, which writes the commit message.',
          ),
        },
        token,
      );
      let answer = '';
      for await (const part of response.text) {
        answer += part;
        if (answer.length > MAX_ANSWER_CHARS) break;
      }
      if (token.isCancellationRequested) return stopped;
      const message = cleanMessage(answer);
      if (message.length === 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t('{0} answered with no commit message.', model.name));
        return nothing;
      }
      return { kind: 'message', message, model: model.name };
    } catch (err) {
      if (token.isCancellationRequested || err instanceof vscode.CancellationError) return stopped;
      void this.tellFailure(err, model);
      return nothing;
    }
  }
}
