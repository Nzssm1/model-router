import type { RuleDefinition, RouterResult, MatchCondition } from './types';

/**
 * Stateless rule engine. Matches rules by priority against user input + tool context.
 */
function matchKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function matchCondition(condition: MatchCondition, context: { text: string; tools: string[]; consecutive: number }): boolean {
  // not: negate sub-condition
  if (condition.not) {
    return !matchCondition(condition.not, context);
  }

  // or: any sub-condition matches
  if (condition.or) {
    return condition.or.some(c => matchCondition(c, context));
  }

  // and: all sub-conditions match
  if (condition.and) {
    return condition.and.every(c => matchCondition(c, context));
  }

  // Keyword matching
  if (condition.keywords && condition.keywords.length > 0) {
    if (!matchKeywords(context.text, condition.keywords)) return false;
  }

  // Negative keyword matching
  if (condition.notKeywords && condition.notKeywords.length > 0) {
    if (matchKeywords(context.text, condition.notKeywords)) return false;
  }

  // Tool matching
  if (condition.toolsUsed && condition.toolsUsed.length > 0) {
    if (!condition.toolsUsed.some(t => context.tools.includes(t))) return false;
  }

  // Negative tool matching
  if (condition.notToolsUsed && condition.notToolsUsed.length > 0) {
    if (condition.notToolsUsed.some(t => context.tools.includes(t))) return false;
  }

  // Consecutive tool calls
  if (condition.consecutive !== undefined) {
    if (context.consecutive < condition.consecutive) return false;
  }

  // Input length
  if (condition.inputLength) {
    const len = context.text.length;
    if (condition.inputLength.min !== undefined && len < condition.inputLength.min) return false;
    if (condition.inputLength.max !== undefined && len > condition.inputLength.max) return false;
  }

  return true;
}

export interface RouterContext {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
}

/**
 * Sorts rules by priority descending, returns first match.
 * Returns null only if no rule matches (shouldn't happen with catch-all default rule).
 */
export function decide(rules: RuleDefinition[], context: RouterContext): RouterResult | null {
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    if (matchCondition(rule.when, {
      text: context.text,
      tools: context.recentTools,
      consecutive: context.consecutiveToolCalls,
    })) {
      return {
        model: rule.then.model,
        ruleId: rule.id,
        thinking: rule.then.thinking,
      };
    }
  }

  return null;
}
