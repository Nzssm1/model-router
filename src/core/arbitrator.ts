import type {
  RouterResult,
  ArbitrationResult,
  ClassifierState,
  Verdict,
  RuleDefinition,
  SemanticMatchResult,
} from './types';
import { decide, type RouterContext } from './router';

export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
  semanticThreshold?: number;
}

// ─── Helpers ───

function getUpgradeTarget(currentModel: string): string | null {
  if (currentModel === 'deepseek-v4-flash') return 'deepseek-v4-pro';
  return null; // Already at max
}

function getDowngradeTarget(currentModel: string): string | null {
  if (currentModel === 'deepseek-v4-pro') return 'deepseek-v4-flash';
  return null; // Already at min
}

function isStrongRule(ruleId: string, rules: RuleDefinition[]): boolean {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) return false;
  // Rules with priority ≥ 80 are considered "strong" (explicitly need capability)
  return rule.priority >= 80;
}

// ─── Main function ───

/**
 * Merge Router output and Classifier verdict into final decision.
 *
 * Accepts an optional SemanticMatchResult for the semantic routing path.
 *
 * Priority rules:
 * 1. If Classifier says upgrade → always upgrade (safety first)
 * 2. If Classifier says downgrade → only if the matched rule (Router or semantic)
 *    is not a strong rule (priority < 80), otherwise vetoed
 * 3. If both agree (keep) → use the initial result
 */
export function arbitrate(
  input: ArbitrateInput,
  semanticResult?: SemanticMatchResult,
): ArbitrationResult {
  const routerResult = decide(input.rules, {
    text: input.text,
    recentTools: input.recentTools,
    consecutiveToolCalls: input.consecutiveToolCalls,
  });

  if (!routerResult) {
    return {
      model: input.classifierState.currentModel,
      ruleId: 'fallback',
      reason: 'No rule matched, keeping current model',
    };
  }

  const { classifierState } = input;

  // ─── Semantic path: only when fast path hits default rule ───
  if (semanticResult && routerResult.ruleId === 'default') {
    let finalModel = semanticResult.model;
    let reason = `语义匹配 ${semanticResult.ruleId} (相似度 ${semanticResult.similarity.toFixed(2)})`;

    // Classifier upgrade always overrides (safety first)
    if (classifierState.lastVerdict === 'upgrade') {
      const upgraded = getUpgradeTarget(finalModel);
      if (upgraded) {
        finalModel = upgraded;
        reason += ' + Classifier upgrade (覆盖语义结果)';
      }
    }

    // Classifier downgrade: actually change model if rule is not strong
    if (classifierState.lastVerdict === 'downgrade') {
      const needsStrong = isStrongRule(semanticResult.ruleId, input.rules);
      if (needsStrong) {
        reason += ` (downgrade 被语义规则 ${semanticResult.ruleId} 否决)`;
      } else {
        const downgraded = getDowngradeTarget(finalModel);
        if (downgraded) {
          finalModel = downgraded;
        }
        reason += ' + Classifier downgrade';
      }
    }

    return {
      model: finalModel,
      ruleId: semanticResult.ruleId,
      reason,
      thinking: semanticResult.thinking,
      semanticMatch: {
        similarity: semanticResult.similarity,
        threshold: input.semanticThreshold ?? 0.55,
        allScores: semanticResult.allScores,
      },
    };
  }

  // ─── Original logic for non-default-rule Router results ───
  let finalModel = routerResult.model;
  let reason = `规则 ${routerResult.ruleId} 匹配`;

  // Classifier upgrade always overrides
  if (classifierState.lastVerdict === 'upgrade') {
    const upgradeTarget = getUpgradeTarget(routerResult.model);
    if (upgradeTarget) {
      finalModel = upgradeTarget;
      reason += ' + Classifier upgrade';
    }
  }

  // Classifier downgrade: only if Router doesn't explicitly need a stronger model
  if (classifierState.lastVerdict === 'downgrade') {
    const needsStrong = isStrongRule(routerResult.ruleId, input.rules);
    if (!needsStrong) {
      const downgraded = getDowngradeTarget(finalModel);
      if (downgraded) {
        finalModel = downgraded;
      }
      reason += ' + Classifier downgrade';
    } else {
      reason += ` (downgrade 被规则 ${routerResult.ruleId} 否决)`;
    }
  }

  return { model: finalModel, ruleId: routerResult.ruleId, reason, thinking: routerResult.thinking };
}
