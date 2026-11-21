/**
 * Which language model writes the commit message (POST-P14cj). VS Code lists
 * the models (`vscode.lm.selectChatModels`): Copilot's once signed in, and any
 * another extension or a key of the user's own adds. Geet asks once which
 * to use and keeps the answer in `geet.commit.messageGeneration.model`.
 *
 * Pure, on the few fields Geet reads of a model, so it is unit-tested.
 */

export interface ModelInfo {
  readonly vendor: string;
  readonly id: string;
  readonly family: string;
  readonly name: string;
  readonly maxInputTokens: number;
}

/** What the setting holds for a model: `copilot/gpt-4.1`. */
export function modelKey(model: Pick<ModelInfo, 'vendor' | 'id'>): string {
  return `${model.vendor}/${model.id}`;
}

/**
 * The model `wanted` names: by `vendor/id` as Geet writes it, else by id or
 * family alone, or `vendor/family`, as someone typing the setting might.
 * Nothing when it is gone: models are retired, and plans change.
 */
export function findModel<M extends ModelInfo>(models: readonly M[], wanted: string | undefined): M | undefined {
  const key = (wanted ?? '').trim().toLowerCase();
  if (key.length === 0) return undefined;
  const lower = (s: string): string => s.toLowerCase();
  return (
    models.find((m) => lower(modelKey(m)) === key) ??
    models.find((m) => lower(m.id) === key) ??
    models.find((m) => lower(`${m.vendor}/${m.family}`) === key) ??
    models.find((m) => lower(m.family) === key)
  );
}

/**
 * The model to use without asking, if there is one: the one the setting
 * names, else the only one there is. With several and none named, the user
 * chooses.
 */
export function modelWithoutAsking<M extends ModelInfo>(models: readonly M[], wanted: string | undefined): M | undefined {
  return findModel(models, wanted) ?? (models.length === 1 ? models[0] : undefined);
}

/** The models as a picker lists them: a vendor's together, by name. */
export function orderModels<M extends ModelInfo>(models: readonly M[]): M[] {
  return [...models].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The most diff text ever sent: a commit message needs no more, whatever the model takes. */
export const MAX_DIFF_BUDGET = 120_000;
/** The least worth sending: under it, the list of files alone says more. */
export const MIN_DIFF_BUDGET = 2_000;
/** Characters to a token, on the safe side for code. */
export const CHARS_PER_TOKEN = 3;

/**
 * How many characters of diff a model with this input limit is sent: about
 * 60% of what it takes, the rest left for the rules, the list of files and
 * the difference between this estimate and the model's own count.
 */
export function diffBudgetFor(maxInputTokens: number): number {
  const tokens = Number.isFinite(maxInputTokens) && maxInputTokens > 0 ? maxInputTokens : 4_000;
  return Math.max(MIN_DIFF_BUDGET, Math.min(MAX_DIFF_BUDGET, Math.floor(tokens * 0.6 * CHARS_PER_TOKEN)));
}

/**
 * The budget for another try, when the model counted `counted` tokens for a
 * request it takes `maxInputTokens` of: shrunk by the overshoot and a tenth more.
 */
export function shrunkBudget(budget: number, counted: number, maxInputTokens: number): number {
  if (counted <= 0 || maxInputTokens <= 0) return Math.floor(budget / 2);
  return Math.max(0, Math.floor(budget * Math.min(0.9, (maxInputTokens / counted) * 0.9)));
}
