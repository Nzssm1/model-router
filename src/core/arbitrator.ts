import type { RouterResult, ArbitrationResult, ClassifierState, Verdict, RuleDefinition } from './types';
import { decide, type RouterContext } from './router';

export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
}

/**
 * Merge Router output and Classifier verdict into final decision.
 *
 * Priority rules:
 * 1. If Classifier says upgrade → always upgrade (safety first)
 * 2. If Classifier says downgrade → only if Router doesn't match a high-priority rule (≥ 80)
 * 3. If both agree (keep) → use Router result
 */
export function arbitrate(input: ArbitrateInput): ArbitrationResult {
  const routerResult = decide(input.rules, {
    text: input.text,
    recentTools: input.recentTools,
    consecutiveToolCalls: input.consecutiveToolCalls,
  });

  if (!routerResult) {
    // Shouldn't happen with catch-all rule, but handle gracefully
    return {
      model: input.classifierState.currentModel,
      ruleId: 'fallback',
      reason: 'No rule matched, keeping current model',
    };
  }

  const { classifierState } = input;
  let finalModel = routerResult.model;
  let reason = `规则 ${routerResult.ruleId} 匹配`;

  // Classifier upgrade always overrides
  if (classifierState.lastVerdict === 'upgrade') {
    const upgradeTarget = getUpgradeTarget(routerResult.model);
    if (upgradeTarget) {
      finalModel = upgradeTarget;
      reason += ` + Classifier upgrade`;
    }
    // If already at max level, keep router result
  }

  // Classifier downgrade: only if Router doesn't explicitly need a stronger model
  if (classifierState.lastVerdict === 'downgrade') {
    const needsStrong = isStrongRule(routerResult.ruleId, input.rules);
    if (!needsStrong) {
      finalModel = routerResult.model;
      reason += ` + Classifier downgrade`;
    } else {
      reason += ` (downgrade 被规则 ${routerResult.ruleId} 否决)`;
    }
  }

  return {
    model: finalModel,
    ruleId: routerResult.ruleId,
    reason,
    thinking: routerResult.thinking,
  };
}

function getUpgradeTarget(currentModel: string): string | null {
  if (currentModel === 'deepseek-v4-flash') return 'deepseek-v4-pro';
  return null; // Already at max
}

function isStrongRule(ruleId: string, rules: RuleDefinition[]): boolean {
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return false;
  // Rules with priority ≥ 80 are considered "strong" (explicitly need capability)
  return rule.priority >= 80;
}
