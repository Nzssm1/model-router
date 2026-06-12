// ─── Match condition (framework-agnostic, no circular dep) ───

export interface MatchCondition {
  keywords?: string[];
  notKeywords?: string[];
  toolsUsed?: string[];
  notToolsUsed?: string[];
  consecutive?: number;
  inputLength?: { min?: number; max?: number };
  or?: MatchCondition[];
  and?: MatchCondition[];
  not?: MatchCondition;
}

// ─── Config types ───

export interface RouterConfig {
  routing: {
    rules: RuleDefinition[];
    escalation: EscalationConfig;
  };
}

export interface RuleDefinition {
  id: string;
  priority: number;
  when: MatchCondition;
  then: {
    model: string;
    thinking?: string;
  };
}

export interface EscalationConfig {
  enabled: boolean;
  consecutiveErrorsBeforeUpgrade: number;
}

// ─── Pricing types ───

export interface ModelPricing {
  input: number;      // ¥/M tokens (cache miss)
  output: number;     // ¥/M tokens
  cacheRead: number;  // ¥/M tokens (cache hit input)
  cacheWrite: number; // ¥/M tokens
}

export interface ModelMeta {
  provider: string;
  currency: string;
  pricing: ModelPricing;
  contextWindow: number;
  maxTokens: number;
  updatedAt: string;
}

export interface PricingData {
  models: Record<string, ModelMeta>;
  sources: string[];
}

// ─── Cost tracking types ───

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;      // ¥
  output: number;     // ¥
  cacheWrite: number; // ¥
  total: number;      // ¥
}

export interface CostRecord {
  timestamp: string;
  turn?: number;
  model: string;
  ruleId: string;
  reason: string;
  tokens: TokenUsage;
  cost: CostBreakdown;
  duration: number;
  success: boolean;
  escalated: boolean;
  error?: string;
}

// ─── Classifier types ───

export type Verdict = "upgrade" | "downgrade" | "keep";

export interface ClassifierState {
  sessionId: string;
  currentModel: string;
  currentRuleId: string;
  consecutiveErrors: number;
  consecutiveRetries: number;
  totalErrors: number;
  recentTools: Array<{
    turn: number;
    tools: string[];
    model: string;
  }>;
  lastVerdict: Verdict;
  upgradeLockRemaining: number;
}

// ─── Arbitrator types ───

export interface RouterResult {
  model: string;
  ruleId: string;
  thinking?: string;
}

export interface ArbitrationResult {
  model: string;
  ruleId: string;
  reason: string;
  thinking?: string;
}
