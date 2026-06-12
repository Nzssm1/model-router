import { readFileSync } from 'node:fs';
import type { TokenUsage, CostBreakdown, PricingData, ModelMeta } from '../core/types';

const DEFAULT_PRICING: PricingData = {
  models: {
    "deepseek-v4-flash": {
      provider: "deepseek",
      currency: "CNY",
      pricing: { input: 1.0, output: 2.0, cacheRead: 0.02, cacheWrite: 0.02 },
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      updatedAt: "2026-06-12",
    },
    "deepseek-v4-pro": {
      provider: "deepseek",
      currency: "CNY",
      pricing: { input: 3.0, output: 6.0, cacheRead: 0.025, cacheWrite: 0.025 },
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      updatedAt: "2026-06-12",
    },
  },
  sources: [],
};

let loadedPricing: PricingData | null = null;

export function loadPricing(path?: string): PricingData {
  if (loadedPricing) return loadedPricing;
  if (path) {
    try {
      const raw = readFileSync(path, 'utf-8');
      loadedPricing = JSON.parse(raw) as PricingData;
    } catch {
      console.warn("[ModelRouter] pricing.json failed to load, using built-in defaults");
    }
  }
  if (!loadedPricing) {
    loadedPricing = structuredClone(DEFAULT_PRICING);
  }
  return loadedPricing;
}

export function getModelMeta(modelId: string): ModelMeta | undefined {
  const pricing = loadPricing();
  return pricing.models[modelId];
}

/**
 * Calculate cost in CNY with cache-aware pricing.
 *
 * inputCost = (cacheRead × cacheReadPrice + (input - cacheRead) × inputPrice) / 1,000,000
 * outputCost = output × outputPrice / 1,000,000
 * cacheWriteCost = cacheWrite × cacheWritePrice / 1,000,000
 * total = inputCost + outputCost + cacheWriteCost
 */
export function calculateCost(modelId: string, tokens: TokenUsage): CostBreakdown {
  const meta = getModelMeta(modelId);
  if (!meta) {
    return { input: 0, output: 0, cacheWrite: 0, total: 0 };
  }
  const p = meta.pricing;
  const inputCost = ((tokens.cacheRead * p.cacheRead) + ((tokens.input - tokens.cacheRead) * p.input)) / 1_000_000;
  const outputCost = (tokens.output * p.output) / 1_000_000;
  const cacheWriteCost = (tokens.cacheWrite * p.cacheWrite) / 1_000_000;
  const total = Math.max(0, inputCost) + Math.max(0, outputCost) + Math.max(0, cacheWriteCost);
  return {
    input: Math.max(0, inputCost),
    output: Math.max(0, outputCost),
    cacheWrite: Math.max(0, cacheWriteCost),
    total,
  };
}
