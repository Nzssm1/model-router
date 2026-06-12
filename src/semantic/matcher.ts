import type { SemanticMatchResult } from '../core/types';
import type { SemanticEngine } from './engine';
import { SemanticCache } from './cache';

export async function matchSemantic(
  input: string,
  threshold: number,
  engine: SemanticEngine,
  cache: SemanticCache,
): Promise<SemanticMatchResult | null> {
  // Step 1: Encode user input
  const inputVec = await engine.encode(input);

  // Step 2: Get precomputed rule embeddings
  const candidates = cache.getAll();
  if (candidates.length === 0) return null;

  // Step 3: Compute similarity scores
  const scores = candidates.map((c) => ({
    ruleId: c.ruleId,
    model: c.model,
    thinking: c.thinking,
    similarity: engine.similarity(inputVec, c.embedding),
    priority: c.priority,
  }));

  // Step 4: Filter by threshold
  const passing = scores.filter((s) => s.similarity >= threshold);
  if (passing.length === 0) return null;

  // Step 5: Sort by priority desc, then similarity desc
  passing.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.similarity - a.similarity;
  });

  const best = passing[0];

  return {
    ruleId: best.ruleId,
    model: best.model,
    thinking: best.thinking,
    similarity: best.similarity,
    allScores: scores.map((s) => ({ ruleId: s.ruleId, similarity: s.similarity })),
  };
}
