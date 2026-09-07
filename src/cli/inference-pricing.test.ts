import { describe, expect, it } from 'vitest';

import {
  CODEX_MODEL_PRICING,
  MODEL_PRICING,
  normalizeCodexModel,
  normalizeModel,
  priceClaudeTokens,
  priceCodexTokens,
  priceUsageBucket,
} from './inference-pricing.js';

// The container copies are loaded at RUNTIME (dynamic import with a non-literal
// specifier) so `tsc -p .` (rootDir=src) never sees a cross-tree import, while
// vitest still executes the real files. Parity is the whole point of this file.
const CONTAINER = new URL('../../container/agent-runner/src/', import.meta.url).href;
async function loadContainer<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${CONTAINER}${file}`)) as T;
}

describe('rate-table parity with the container copies', () => {
  it('MODEL_PRICING is identical to container/agent-runner/src/pricing.ts', async () => {
    const c = await loadContainer<{ MODEL_PRICING: typeof MODEL_PRICING }>('pricing.ts');
    expect(MODEL_PRICING).toEqual(c.MODEL_PRICING);
  });
  it('CODEX_MODEL_PRICING is identical to container/agent-runner/src/codex-cost.ts', async () => {
    const c = await loadContainer<{ CODEX_MODEL_PRICING: typeof CODEX_MODEL_PRICING }>('codex-cost.ts');
    expect(CODEX_MODEL_PRICING).toEqual(c.CODEX_MODEL_PRICING);
  });
  it('resolves every id the shipped normalizers resolve, identically', async () => {
    const p = await loadContainer<{ normalizeModel: typeof normalizeModel }>('pricing.ts');
    const x = await loadContainer<{ normalizeCodexModel: typeof normalizeCodexModel }>('codex-cost.ts');
    const claudeIds = [
      'aws/anthropic/bedrock-claude-opus-5',
      'aws/anthropic/bedrock-claude-opus-4-8',
      'aws/anthropic/bedrock-claude-sonnet-5',
      'aws/anthropic/claude-haiku-4-5-v1',
      'claude-opus-4-8[1m]',
      'claude-opus-5',
      'claude-sonnet-4-6-20260101',
      'anthropic/claude-haiku-4-5',
      '<synthetic>',
      'gpt-5.6-sol',
      '',
    ];
    for (const id of claudeIds) expect(normalizeModel(id), id).toBe(p.normalizeModel(id));
    const codexIds = [
      'azure/openai/gpt-5.6-sol',
      'openai/openai/gpt-5.5',
      'gpt-5.6-luna-20260101',
      'gpt-5.6-latest',
      'gpt-5.3-codex',
      'nope',
      '',
    ];
    for (const id of codexIds) expect(normalizeCodexModel(id), id).toBe(x.normalizeCodexModel(id));
  });
});

describe('body-reported model ids (what the OneCLI tap records as usage_model)', () => {
  it('maps raw Bedrock ids and Azure -global deployments onto priced keys', () => {
    expect(normalizeModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5');
    expect(normalizeModel('anthropic.claude-opus-4-8-20260301-v1:0')).toBe('claude-opus-4-8');
    expect(normalizeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeCodexModel('gpt-5.6-sol-global')).toBe('gpt-5.6-sol');
    expect(normalizeCodexModel('gpt-5.6-sol-global-20260101')).toBe('gpt-5.6-sol');
  });
  it('never resolves prototype names or unknown models', () => {
    expect(normalizeModel('constructor')).toBe('');
    expect(normalizeCodexModel('toString')).toBe('');
    expect(normalizeModel('claude-ultra-9')).toBe('');
  });
});

describe('pricing math', () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreateFlat: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
  it('prices Anthropic totals incl. the 5m/1h cache-write split (1h = 2× input)', () => {
    const usd = priceClaudeTokens('claude-sonnet-5', {
      ...zero,
      input: 1_000_000,
      output: 100_000,
      cacheRead: 10_000_000,
      cacheCreateFlat: 100_000,
      cacheCreate5m: 200_000,
      cacheCreate1h: 300_000,
    });
    // 2 + 1 + 2 + 0.25 + 0.5 + (300k × 4e-6 = 1.2)
    expect(usd).toBeCloseTo(6.95, 9);
  });
  it('prices OpenAI totals with input INCLUSIVE of cached tokens', () => {
    const usd = priceCodexTokens('azure/openai/gpt-5.6-sol', { input: 1_000_000, cacheRead: 400_000, output: 10_000 });
    // 600k × 5e-6 + 400k × 5e-7 + 10k × 3e-5 = 3 + 0.2 + 0.3
    expect(usd).toBeCloseTo(3.5, 9);
  });
  it('returns null (UNKNOWN), never $0, for unpriced models or APIs', () => {
    expect(priceClaudeTokens('claude-ultra-9', { ...zero, input: 5 })).toBeNull();
    expect(priceCodexTokens('gpt-99', { input: 5, cacheRead: 0, output: 1 })).toBeNull();
    expect(priceUsageBucket('grpc_v9', 'claude-sonnet-5', { ...zero, input: 5 })).toBeNull();
  });
  it('dispatches on the recorded usage_api', () => {
    expect(priceUsageBucket('anthropic_messages_v1', 'claude-haiku-4-5', { ...zero, input: 1_000_000 })).toBeCloseTo(
      1,
      9,
    );
    expect(priceUsageBucket('openai_responses_v1', 'gpt-5.6-sol-global', { ...zero, input: 1_000_000 })).toBeCloseTo(
      5,
      9,
    );
    expect(priceUsageBucket('openai_chat_completions_v1', 'gpt-5.6-luna', { ...zero, output: 1_000_000 })).toBeCloseTo(
      1.2,
      9,
    );
  });
});
