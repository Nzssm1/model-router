import type { RuleDefinition } from '../core/types';
import type { SemanticEngine } from './engine';

interface CachedRuleEmbedding {
  ruleId: string;
  priority: number;
  model: string;
  thinking?: string;
  embedding: Float32Array;
}

export class SemanticCache {
  private entries: CachedRuleEmbedding[] = [];
  private engine: SemanticEngine;

  constructor(engine: SemanticEngine) {
    this.engine = engine;
  }

  /** Precompute embeddings for all rules that have a description. */
  async compute(rules: RuleDefinition[]): Promise<void> {
    const withDescription = rules.filter((r) => (r.description?.trim().length ?? 0) > 0);
    const results: CachedRuleEmbedding[] = [];

    for (const rule of withDescription) {
      const embedding = await this.engine.encode(rule.description!);
      results.push({
        ruleId: rule.id,
        priority: rule.priority,
        model: rule.then.model,
        thinking: rule.then.thinking,
        embedding,
      });
    }

    this.entries = results;
  }

  getAll(): CachedRuleEmbedding[] {
    return this.entries;
  }

  /** Find a specific rule by ID (useful for debugging). */
  find(ruleId: string): CachedRuleEmbedding | undefined {
    return this.entries.find((e) => e.ruleId === ruleId);
  }

  invalidate(): void {
    this.entries = [];
  }
}
