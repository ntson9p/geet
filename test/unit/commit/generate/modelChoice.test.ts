/**
 * POST-P14cj, Generate Commit Message: which of VS Code's language models
 * writes the message, and how much diff it is sent.
 */
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  diffBudgetFor,
  findModel,
  MAX_DIFF_BUDGET,
  MIN_DIFF_BUDGET,
  modelKey,
  modelWithoutAsking,
  orderModels,
  shrunkBudget,
  type ModelInfo,
} from '../../../../src/commit/generate/modelChoice';

const GPT: ModelInfo = { vendor: 'copilot', id: 'gpt-4.1', family: 'gpt-4.1', name: 'GPT-4.1', maxInputTokens: 111_000 };
const CLAUDE: ModelInfo = {
  vendor: 'copilot',
  id: 'claude-sonnet-4.5',
  family: 'claude-sonnet',
  name: 'Claude Sonnet 4.5',
  maxInputTokens: 128_000,
};
const LLAMA: ModelInfo = { vendor: 'ollama', id: 'llama3', family: 'llama', name: 'Llama 3', maxInputTokens: 8_000 };
const ALL = [GPT, CLAUDE, LLAMA];

describe('the model the setting names', () => {
  it('is written as vendor/id', () => {
    expect(modelKey(GPT)).toBe('copilot/gpt-4.1');
  });

  it('is found by what GitTree writes, whatever its case and the spaces around it', () => {
    expect(findModel(ALL, 'copilot/gpt-4.1')).toBe(GPT);
    expect(findModel(ALL, ' Copilot/GPT-4.1 ')).toBe(GPT);
  });

  it('is found by what someone typing the setting might write: an id, a family, vendor/family', () => {
    expect(findModel(ALL, 'llama3')).toBe(LLAMA);
    expect(findModel(ALL, 'llama')).toBe(LLAMA);
    expect(findModel(ALL, 'copilot/claude-sonnet')).toBe(CLAUDE);
  });

  it('prefers the exact model to another one whose family has the same name', () => {
    const same: ModelInfo = { vendor: 'other', id: 'x', family: 'gpt-4.1', name: 'Other', maxInputTokens: 1 };
    expect(findModel([same, GPT], 'gpt-4.1')).toBe(GPT);
  });

  it('is nothing when the model is gone, or the setting empty', () => {
    expect(findModel(ALL, 'copilot/gpt-3')).toBeUndefined();
    expect(findModel(ALL, '')).toBeUndefined();
    expect(findModel(ALL, '   ')).toBeUndefined();
    expect(findModel(ALL, undefined)).toBeUndefined();
    expect(findModel([], 'copilot/gpt-4.1')).toBeUndefined();
  });
});

describe('whether to ask', () => {
  it('uses the model the setting names', () => {
    expect(modelWithoutAsking(ALL, 'ollama/llama3')).toBe(LLAMA);
  });

  it('uses the only model there is, named or not', () => {
    expect(modelWithoutAsking([LLAMA], undefined)).toBe(LLAMA);
    expect(modelWithoutAsking([LLAMA], 'copilot/gone')).toBe(LLAMA);
  });

  it('asks when there are several and none is named, or the one named is gone', () => {
    expect(modelWithoutAsking(ALL, '')).toBeUndefined();
    expect(modelWithoutAsking(ALL, 'copilot/gone')).toBeUndefined();
    expect(modelWithoutAsking([], 'copilot/gpt-4.1')).toBeUndefined();
  });

  it('lists a vendor’s models together, by name, without changing what it was given', () => {
    const given = [LLAMA, GPT, CLAUDE];
    expect(orderModels(given).map((m) => m.name)).toEqual(['Claude Sonnet 4.5', 'GPT-4.1', 'Llama 3']);
    expect(given).toEqual([LLAMA, GPT, CLAUDE]);
  });
});

describe('how much diff a model is sent', () => {
  it('is about 60% of what it takes, in characters', () => {
    expect(diffBudgetFor(8_000)).toBe(Math.floor(8_000 * 0.6 * CHARS_PER_TOKEN));
    expect(diffBudgetFor(8_000)).toBe(14_400);
  });

  it('never more than a commit message needs, never less than is worth sending', () => {
    expect(diffBudgetFor(128_000)).toBe(MAX_DIFF_BUDGET);
    expect(diffBudgetFor(1_000_000)).toBe(MAX_DIFF_BUDGET);
    expect(diffBudgetFor(500)).toBe(MIN_DIFF_BUDGET);
  });

  it('takes a model that does not say what it takes for a small one', () => {
    expect(diffBudgetFor(Number.NaN)).toBe(7_200);
    expect(diffBudgetFor(0)).toBe(7_200);
    expect(diffBudgetFor(-1)).toBe(7_200);
  });

  it('shrinks by the overshoot and a tenth more when the model counts too many tokens', () => {
    // Twice what it takes: half, less a tenth.
    expect(shrunkBudget(10_000, 20_000, 10_000)).toBe(4_500);
    // Barely over: a tenth off, never less.
    expect(shrunkBudget(10_000, 9_000, 10_000)).toBe(9_000);
    expect(shrunkBudget(10_000, 10_500, 10_000)).toBeLessThan(9_000);
  });

  it('halves when the count says nothing, and stops at nothing', () => {
    expect(shrunkBudget(10_000, 0, 10_000)).toBe(5_000);
    expect(shrunkBudget(10_000, 500, 0)).toBe(5_000);
    expect(shrunkBudget(0, 20_000, 10_000)).toBe(0);
  });
});
