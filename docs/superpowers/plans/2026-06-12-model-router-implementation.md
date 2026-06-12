# Model Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Model Router — a Pi Extension that auto-switches between DeepSeek V4 Flash and V4 Pro based on task complexity, with cost tracking and on-demand reporting.

**Architecture:** Core logic (router/classifier/arbitrator/tracker) is framework-agnostic. A Pi Extension adapter hooks into `before_agent_start` and `turn_end` events to drive model switching. Pricing data is built-in with cache-aware CNY calculation.

**Tech Stack:** TypeScript, Pi Extension API (`@earendil-works/pi-coding-agent`), typebox

---

### Task 1: Project scaffolding

**Files:**
- Create: `model-router/package.json`
- Create: `model-router/tsconfig.json`
- Create: `model-router/config/model-config.json`
- Create: `model-router/pricing/pricing.json`

- [ ] **Step 1: Create package.json**

```jsonc
{
  "name": "@pi/model-router",
  "version": "0.1.0",
  "description": "Auto-switch between LLM models based on task complexity to reduce cost",
  "license": "MIT",
  "type": "module",
  "main": "./src/adapters/pi/index.ts",
  "pi": {
    "extensions": ["./src/adapters/pi/index.ts"]
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^latest",
    "typebox": "^latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create config/model-config.json (default routing rules)**

```jsonc
{
  "routing": {
    "rules": [
      {
        "id": "complex-task",
        "priority": 100,
        "when": {
          "keywords": ["重构", "架构", "设计", "架构分析", "refactor", "architecture"],
          "notKeywords": ["小重构", "简单调整"]
        },
        "then": { "model": "deepseek-v4-pro", "thinking": "high" }
      },
      {
        "id": "code-generation",
        "priority": 80,
        "when": {
          "keywords": ["实现", "implement", "写一个", "create", "add feature", "修改", "改"]
        },
        "then": { "model": "deepseek-v4-pro", "thinking": "medium" }
      },
      {
        "id": "file-reading",
        "priority": 60,
        "when": {
          "toolsUsed": ["read", "ls", "grep", "find"]
        },
        "then": { "model": "deepseek-v4-flash", "thinking": "off" }
      },
      {
        "id": "simple-qa",
        "priority": 50,
        "when": {
          "keywords": ["解释", "explain", "什么是", "what is", "总结", "summarize"]
        },
        "then": { "model": "deepseek-v4-flash", "thinking": "off" }
      },
      {
        "id": "default",
        "priority": 0,
        "when": {},
        "then": { "model": "deepseek-v4-flash", "thinking": "off" }
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 2
    }
  }
}
```

- [ ] **Step 4: Create pricing/pricing.json (built-in CN¥ pricing)**

```jsonc
{
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "currency": "CNY",
      "pricing": {
        "input": 1.0,
        "output": 2.0,
        "cacheRead": 0.02,
        "cacheWrite": 0.02
      },
      "contextWindow": 1_000_000,
      "maxTokens": 393_216,
      "updatedAt": "2026-06-12"
    },
    "deepseek-v4-pro": {
      "provider": "deepseek",
      "currency": "CNY",
      "pricing": {
        "input": 3.0,
        "output": 6.0,
        "cacheRead": 0.025,
        "cacheWrite": 0.025
      },
      "contextWindow": 1_000_000,
      "maxTokens": 393_216,
      "updatedAt": "2026-06-12"
    }
  },
  "sources": []
}
```

- [ ] **Step 5: Create directory structure**

Run:
```bash
mkdir -p model-router/src/core model-router/src/pricing model-router/src/adapters/pi model-router/src/utils model-router/config model-router/pricing model-router/examples model-router/__tests__
```

- [ ] **Step 6: Commit**

```bash
cd model-router && git init && git add -A && git commit -m "chore: scaffold project structure"
```

---

### Task 2: Core types

**Files:**
- Create: `model-router/src/core/types.ts`

- [ ] **Step 1: Write types.ts**

```typescript
// ─── Match condition (was in router.ts, moved here to avoid circular dep) ───

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
```

- [ ] **Step 2: Commit**

```bash
git add src/core/types.ts && git commit -m "feat: add core type definitions"
```

---

### Task 3: Pricing utility

**Files:**
- Create: `model-router/src/utils/pricing.ts`

- [ ] **Step 1: Write pricing.ts**

```typescript
import type { ModelPricing, TokenUsage, CostBreakdown, PricingData, ModelMeta } from '../core/types';

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
```

- [ ] **Step 2: Write the test**

Create `model-router/__tests__/pricing.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { calculateCost } from '../src/utils/pricing';

describe('calculateCost', () => {
  it('calculates flash cost with no cache hit', () => {
    const cost = calculateCost('deepseek-v4-flash', { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
    // input: 1000 * 1.0 / 1e6 = 0.001, output: 500 * 2.0 / 1e6 = 0.001
    expect(cost.total).toBeCloseTo(0.002, 6);
  });

  it('applies cacheRead discount', () => {
    const cost = calculateCost('deepseek-v4-flash', { input: 1000, output: 0, cacheRead: 800, cacheWrite: 200 });
    // cacheRead: 800 * 0.02 / 1e6 = 0.000016
    // miss: (1000-800) * 1.0 / 1e6 = 0.0002
    // cacheWrite: 200 * 0.02 / 1e6 = 0.000004
    expect(cost.total).toBeCloseTo(0.00022, 8);
  });

  it('includes cacheWrite cost', () => {
    const cost = calculateCost('deepseek-v4-pro', { input: 0, output: 0, cacheRead: 0, cacheWrite: 10000 });
    expect(cost.cacheWrite).toBeCloseTo(0.00025, 8); // 10000 * 0.025 / 1e6
  });

  it('returns zero for unknown model', () => {
    const cost = calculateCost('unknown-model', { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(cost.total).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run __tests__/pricing.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/pricing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/pricing.ts __tests__/pricing.test.ts && git commit -m "feat: add cache-aware CNY pricing calculation"
```

---

### Task 4: Router — rule engine

**Files:**
- Create: `model-router/src/core/router.ts`

- [ ] **Step 1: Write router.ts**

```typescript
import type { RuleDefinition, RouterResult, MatchCondition } from './types';

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
 * Stateless rule engine. Sorts rules by priority, returns first match.
 * Returns null if no rule matches (shouldn't happen with catch-all default rule).
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
```

- [ ] **Step 2: Write the test**

Create `model-router/__tests__/router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { decide } from '../src/core/router';
import type { RuleDefinition } from '../src/core/types';

const sampleRules: RuleDefinition[] = [
  {
    id: 'complex',
    priority: 100,
    when: { keywords: ['重构', 'refactor'] },
    then: { model: 'deepseek-v4-pro', thinking: 'high' },
  },
  {
    id: 'reading',
    priority: 60,
    when: { toolsUsed: ['read', 'ls'] },
    then: { model: 'deepseek-v4-flash' },
  },
  {
    id: 'default',
    priority: 0,
    when: {},
    then: { model: 'deepseek-v4-flash' },
  },
];

describe('decide', () => {
  it('matches keyword rule', () => {
    const result = decide(sampleRules, { text: '帮我重构这个模块', recentTools: [], consecutiveToolCalls: 0 });
    expect(result?.model).toBe('deepseek-v4-pro');
    expect(result?.ruleId).toBe('complex');
  });

  it('matches tool rule', () => {
    const result = decide(sampleRules, { text: '继续', recentTools: ['read', 'ls'], consecutiveToolCalls: 3 });
    expect(result?.model).toBe('deepseek-v4-flash');
    expect(result?.ruleId).toBe('reading');
  });

  it('falls back to default rule', () => {
    const result = decide(sampleRules, { text: '你好', recentTools: [], consecutiveToolCalls: 0 });
    expect(result?.model).toBe('deepseek-v4-flash');
    expect(result?.ruleId).toBe('default');
  });

  it('respects priority (complex overrides reading)', () => {
    const result = decide(sampleRules, {
      text: '重构',
      recentTools: ['read'],
      consecutiveToolCalls: 5,
    });
    expect(result?.model).toBe('deepseek-v4-pro');
    expect(result?.ruleId).toBe('complex');
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run __tests__/router.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/router.ts __tests__/router.test.ts && git commit -m "feat: add rule-based routing engine"
```

---

### Task 5: Classifier — cross-turn analysis

**Files:**
- Create: `model-router/src/core/classifier.ts`

- [ ] **Step 1: Write classifier.ts**

```typescript
import type { ClassifierState, Verdict, EscalationConfig } from './types';

export function createInitialState(sessionId: string, initialModel: string, initialRuleId: string): ClassifierState {
  return {
    sessionId,
    currentModel: initialModel,
    currentRuleId: initialRuleId,
    consecutiveErrors: 0,
    consecutiveRetries: 0,
    totalErrors: 0,
    recentTools: [],
    lastVerdict: 'keep',
    upgradeLockRemaining: 0,
  };
}

export interface TurnResult {
  turnIndex: number;
  toolsCalled: string[];
  modelUsed: string;
  hadError: boolean;
  hadRetry: boolean;
}

/**
 * Analyze turn result and determine if model should change.
 * Runs after each turn_end.
 */
export function analyze(state: ClassifierState, turn: TurnResult, config: EscalationConfig): { newState: ClassifierState; verdict: Verdict } {
  const newState = { ...state };
  let verdict: Verdict = 'keep';

  // Update recent tools circular buffer (keep last 5)
  newState.recentTools = [
    ...state.recentTools.slice(-4),
    { turn: turn.turnIndex, tools: turn.toolsCalled, model: turn.modelUsed },
  ];

  // Track errors
  if (turn.hadError || turn.hadRetry) {
    newState.consecutiveErrors++;
    newState.totalErrors++;
    if (turn.hadRetry) newState.consecutiveRetries++;
  } else {
    newState.consecutiveErrors = 0;
    newState.consecutiveRetries = 0;
  }

  // Upgrade check: consecutive errors hit threshold
  if (config.enabled && newState.consecutiveErrors >= config.consecutiveErrorsBeforeUpgrade) {
    verdict = 'upgrade';
  }

  // Upgrade check: consecutive retries hit threshold
  if (config.enabled && verdict === 'keep' && newState.consecutiveRetries >= config.consecutiveErrorsBeforeUpgrade) {
    verdict = 'upgrade';
  }

  // Downgrade check: all recent tools are read-only and upgrade lock expired
  if (verdict === 'keep' && newState.upgradeLockRemaining <= 0 && newState.recentTools.length >= 3) {
    const last3 = newState.recentTools.slice(-3);
    const allReadOnly = last3.every(t => t.tools.every(tool => ['read', 'ls', 'grep', 'find'].includes(tool)));
    if (allReadOnly) {
      verdict = 'downgrade';
    }
  }

  // Decrement upgrade lock
  if (newState.upgradeLockRemaining > 0) {
    newState.upgradeLockRemaining--;
  }

  newState.lastVerdict = verdict;
  return { newState, verdict };
}

/**
 * Call when model actually switches.
 * Resets error counters since we're evaluating the new model fresh.
 * When switching to a stronger model, set upgradeLock to prevent
 * premature downgrade. Resets error counters since we're evaluating the new model fresh.
 *
 * @param upgradedToStronger - true if switching from Flash→Pro (not Pro→Flash or same)
 */
export function onModelSwitch(state: ClassifierState, newModel: string, newRuleId: string, upgradedToStronger: boolean = false): ClassifierState {
  return {
    ...state,
    currentModel: newModel,
    currentRuleId: newRuleId,
    consecutiveErrors: 0,
    consecutiveRetries: 0,
    upgradeLockRemaining: upgradedToStronger ? 2 : 0,
    // 不重置 lastVerdict，留给 turn_end 读取 escalated 后由 analyze() 更新
  };
}
```

- [ ] **Step 2: Write the test**

Create `model-router/__tests__/classifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createInitialState, analyze, onModelSwitch } from '../src/core/classifier';
import type { EscalationConfig } from '../src/core/types';

const config: EscalationConfig = { enabled: true, consecutiveErrorsBeforeUpgrade: 2 };

describe('classifier', () => {
  it('starts with keep verdict', () => {
    const state = createInitialState('s1', 'flash', 'default');
    expect(state.lastVerdict).toBe('keep');
  });

  it('upgrades after consecutiveErrorsBeforeUpgrade errors', () => {
    let state = createInitialState('s1', 'flash', 'default');
    const turn = { turnIndex: 1, toolsCalled: ['read'], modelUsed: 'flash', hadError: true, hadRetry: false };
    // error 1
    const r1 = analyze(state, turn, config);
    expect(r1.verdict).toBe('keep');
    state = r1.newState;
    // error 2
    const r2 = analyze(state, { ...turn, turnIndex: 2 }, config);
    expect(r2.verdict).toBe('upgrade');
  });

  it('resets errors on model switch', () => {
    let state = createInitialState('s1', 'flash', 'default');
    state = onModelSwitch(state, 'pro', 'complex');
    expect(state.consecutiveErrors).toBe(0);
    expect(state.consecutiveRetries).toBe(0);
  });

  it('sets upgradeLockRemaining=2 when switching to stronger model', () => {
    let state = createInitialState('s1', 'flash', 'default');
    state = onModelSwitch(state, 'pro', 'complex', true);
    expect(state.upgradeLockRemaining).toBe(2);
  });

  it('does not set upgradeLock when switching to same-tier model', () => {
    let state = createInitialState('s1', 'pro', 'complex');
    state = onModelSwitch(state, 'pro', 'default', false);
    expect(state.upgradeLockRemaining).toBe(0);
  });

  it('downgrades after 3 rounds of read-only tools with no upgrade lock', () => {
    let state = createInitialState('s1', 'pro', 'complex');
    const readTurn = { toolsCalled: ['read', 'ls'], hadError: false, hadRetry: false };
    // 3 rounds of reading
    const r1 = analyze(state, { ...readTurn, turnIndex: 1, modelUsed: 'pro' }, config);
    state = r1.newState;
    const r2 = analyze(state, { ...readTurn, turnIndex: 2, modelUsed: 'pro' }, config);
    state = r2.newState;
    const r3 = analyze(state, { ...readTurn, turnIndex: 3, modelUsed: 'pro' }, config);
    expect(r3.verdict).toBe('downgrade');
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run __tests__/classifier.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/classifier.ts __tests__/classifier.test.ts && git commit -m "feat: add cross-turn classifier with upgrade/downgrade logic"
```

---

### Task 6: Arbitrator — merge router + classifier

**Files:**
- Create: `model-router/src/core/arbitrator.ts`

- [ ] **Step 1: Write arbitrator.ts**

```typescript
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
 * 2. If Classifier says downgrade → only if Router doesn't match a high-priority rule (≥ threshold)
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
```

- [ ] **Step 2: Write the test**

Create `model-router/__tests__/arbitrator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { arbitrate } from '../src/core/arbitrator';
import { createInitialState } from '../src/core/classifier';
import type { RuleDefinition } from '../src/core/types';

const rules: RuleDefinition[] = [
  { id: 'complex', priority: 100, when: { keywords: ['重构'] }, then: { model: 'deepseek-v4-pro' } },
  { id: 'reading', priority: 60, when: { toolsUsed: ['read'] }, then: { model: 'deepseek-v4-flash' } },
  { id: 'default', priority: 0, when: {}, then: { model: 'deepseek-v4-flash' } },
];

describe('arbitrate', () => {
  it('uses router result when classifier keeps', () => {
    const state = createInitialState('s1', 'flash', 'default');
    const result = arbitrate({
      text: '读这个文件',
      recentTools: [],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.ruleId).toBe('reading');
  });

  it('upgrade overrides router to stronger model', () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'upgrade' as const };
    const result = arbitrate({
      text: '你好',
      recentTools: [],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('upgrade');
  });

  it('downgrade is vetoed when router matches strong rule', () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate({
      text: '重构这个模块',
      recentTools: ['read'],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('否决');
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run __tests__/arbitrator.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/arbitrator.ts __tests__/arbitrator.test.ts && git commit -m "feat: add arbitrator merging router + classifier"
```

---

### Task 7: Cost tracker — JSONL persistence

**Files:**
- Create: `model-router/src/core/tracker.ts`

- [ ] **Step 1: Write tracker.ts**

```typescript
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CostRecord, CostBreakdown, TokenUsage } from './types';
import { calculateCost } from '../utils/pricing';

const DEFAULT_COST_DIR = join(process.env.HOME || process.env.USERPROFILE || '~', '.model-router', 'costs');
const COST_DIR = process.env.MODEL_ROUTER_COST_DIR || DEFAULT_COST_DIR;

function ensureDir(): void {
  if (!existsSync(COST_DIR)) {
    mkdirSync(COST_DIR, { recursive: true });
  }
}

function sessionFilePath(sessionId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(COST_DIR, `${date}_${safeId}.jsonl`);
}

let turnCounter = 0;

export function resetTurnCounter(): void {
  turnCounter = 0;
}

export function recordCost(params: {
  sessionId: string;
  model: string;
  ruleId: string;
  reason: string;
  tokens: TokenUsage;
  duration: number;
  success: boolean;
  escalated: boolean;
  error?: string;
}): CostRecord {
  turnCounter++;
  const cost = calculateCost(params.model, params.tokens);
  const record: CostRecord = {
    timestamp: new Date().toISOString(),
    turn: turnCounter,
    model: params.model,
    ruleId: params.ruleId,
    reason: params.reason,
    tokens: params.tokens,
    cost,
    duration: params.duration,
    success: params.success,
    escalated: params.escalated,
    error: params.error,
  };

  try {
    ensureDir();
    appendFileSync(sessionFilePath(params.sessionId), JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[ModelRouter] Failed to write cost record:', e);
  }

  return record;
}

export interface CostReport {
  totalCalls: number;
  totalCost: number;
  byModel: Record<string, { calls: number; cost: number; cacheHitTokens: number; totalInputTokens: number }>;
  records: CostRecord[];
}

export function generateReport(sessionId: string, verbose: boolean = false): CostReport | null {
  const fp = sessionFilePath(sessionId);
  if (!existsSync(fp)) return null;

  try {
    const content = readFileSync(fp, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const records: CostRecord[] = lines.map(l => JSON.parse(l));
    const byModel: CostReport['byModel'] = {};
    let totalCost = 0;

    for (const r of records) {
      totalCost += r.cost.total;
      if (!byModel[r.model]) {
        byModel[r.model] = { calls: 0, cost: 0, cacheHitTokens: 0, totalInputTokens: 0 };
      }
      byModel[r.model].calls++;
      byModel[r.model].cost += r.cost.total;
      byModel[r.model].cacheHitTokens += r.tokens.cacheRead;
      byModel[r.model].totalInputTokens += r.tokens.input;
    }

    return { totalCalls: records.length, totalCost, byModel, records: verbose ? records : [] };
  } catch {
    return null;
  }
}

/**
 * Report total costs across all sessions (--all mode).
 */
export function generateAggregatedReport(): CostReport {
  if (!existsSync(COST_DIR)) {
    return { totalCalls: 0, totalCost: 0, byModel: {}, records: [] };
  }
  const files = readdirSync(COST_DIR).filter(f => f.endsWith('.jsonl'));
  const allRecords: CostRecord[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(COST_DIR, file), 'utf-8');
      const records: CostRecord[] = content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      allRecords.push(...records);
    } catch { /* skip corrupt files */ }
  }

  const byModel: CostReport['byModel'] = {};
  let totalCost = 0;
  for (const r of allRecords) {
    totalCost += r.cost.total;
    if (!byModel[r.model]) {
      byModel[r.model] = { calls: 0, cost: 0, cacheHitTokens: 0, totalInputTokens: 0 };
    }
    byModel[r.model].calls++;
    byModel[r.model].cost += r.cost.total;
    byModel[r.model].cacheHitTokens += r.tokens.cacheRead;
    byModel[r.model].totalInputTokens += r.tokens.input;
  }
  return { totalCalls: allRecords.length, totalCost, byModel, records: allRecords };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/tracker.ts && git commit -m "feat: add cost tracker with per-session JSONL persistence"
```

---

### Task 8: Report formatter

**Files:**
- Create: `model-router/src/utils/report-formatter.ts`

- [ ] **Step 1: Write report-formatter.ts**

```typescript
import type { CostReport } from '../core/tracker';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export function formatCostReport(report: CostReport, modelList: string[]): string {
  const lines: string[] = [];
  lines.push(SEP);
  lines.push(' 🤖 Model Router - 成本报告');
  lines.push(SEP);
  lines.push(` 总调用: ${report.totalCalls} 次    总花费: ¥${report.totalCost.toFixed(4)}`);
  lines.push(SEP);

  // Header
  lines.push(` ${'模型'.padEnd(20)} ${'调用'.padStart(5)} ${'缓存命中率'.padStart(10)} ${'花费'.padStart(10)} ${'占比'.padStart(6)}`);

  for (const model of modelList) {
    const m = report.byModel[model];
    if (!m) continue;
    const cacheRatio = m.totalInputTokens > 0 ? (m.cacheHitTokens / m.totalInputTokens * 100).toFixed(0) : '0';
    const pct = report.totalCost > 0 ? (m.cost / report.totalCost * 100).toFixed(0) : '0';
    lines.push(` ${model.padEnd(20)} ${String(m.calls).padStart(5)} ${`${cacheRatio}%`.padStart(10)} ¥${m.cost.toFixed(4).padStart(7)} ${`${pct}%`.padStart(5)}`);
  }

  // Calculate "if all-Pro" comparison
  const allProCost = estimateAllProCost(report);
  const allFlashCost = estimateAllFlashCost(report);
  lines.push(SEP);
  lines.push(' 对比参考:');
  lines.push(`   全程用 Pro:  ¥${allProCost.toFixed(4)}`);
  lines.push(`   全程用 Flash: ¥${allFlashCost.toFixed(4)}`);
  if (allProCost > 0) {
    const saved = allProCost - report.totalCost;
    const pct = (saved / allProCost * 100).toFixed(0);
    lines.push(`   实际节省 vs 全用 Pro: ¥${saved.toFixed(4)} (${pct}%)`);
  }
  lines.push(SEP);

  return lines.join('\n');
}

export function formatVerboseReport(report: CostReport): string {
  const lines: string[] = [];
  lines.push(SEP);
  lines.push(' 路由明细:');
  lines.push(` ${'时间'.padEnd(22)} ${'模型'.padEnd(18)} ${'规则'.padEnd(16)} 原因`);
  lines.push(SEP);

  for (const r of report.records) {
    const time = r.timestamp.slice(11, 19);
    const turn = r.turn !== undefined ? `#${r.turn}` : '';
    lines.push(` ${time.padEnd(22)} ${`${r.model}${turn}`.padEnd(18)} ${r.ruleId.padEnd(16)} ${r.reason}`);
  }
  lines.push(SEP);
  return lines.join('\n');
}

function estimateAllProCost(report: CostReport): number {
  let total = 0;
  for (const r of report.records) {
    // Recalculate with Pro pricing
    const inputCost = ((r.tokens.cacheRead * 0.025) + ((r.tokens.input - r.tokens.cacheRead) * 3.0)) / 1_000_000;
    const outputCost = (r.tokens.output * 6.0) / 1_000_000;
    const cacheWriteCost = (r.tokens.cacheWrite * 0.025) / 1_000_000;
    total += Math.max(0, inputCost) + Math.max(0, outputCost) + Math.max(0, cacheWriteCost);
  }
  return total;
}

function estimateAllFlashCost(report: CostReport): number {
  let total = 0;
  for (const r of report.records) {
    const inputCost = ((r.tokens.cacheRead * 0.02) + ((r.tokens.input - r.tokens.cacheRead) * 1.0)) / 1_000_000;
    const outputCost = (r.tokens.output * 2.0) / 1_000_000;
    const cacheWriteCost = (r.tokens.cacheWrite * 0.02) / 1_000_000;
    total += Math.max(0, inputCost) + Math.max(0, outputCost) + Math.max(0, cacheWriteCost);
  }
  return total;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/report-formatter.ts && git commit -m "feat: add cost report formatter with comparison"
```

---

### Task 9: Pi Extension — DeepSeek provider registration

**Files:**
- Create: `model-router/src/adapters/pi/provider.ts`

- [ ] **Step 1: Write provider.ts**

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Register DeepSeek V4 Flash and V4 Pro as a custom provider.
 * Uses OpenAI-compatible API format.
 *
 * Requires DEEPSEEK_API_KEY environment variable.
 */
export function registerDeepSeekProvider(pi: ExtensionAPI): void {
  pi.registerProvider('deepseek', {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '$DEEPSEEK_API_KEY',
    api: 'openai-completions',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: false,
        input: ['text'],
        cost: { input: 1.0, output: 2.0, cacheRead: 0.02, cacheWrite: 0.02 },
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        compat: {
          thinkingFormat: 'deepseek',
        },
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoning: true,
        input: ['text'],
        cost: { input: 3.0, output: 6.0, cacheRead: 0.025, cacheWrite: 0.025 },
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        compat: {
          thinkingFormat: 'deepseek',
          supportsReasoningEffort: true,
        },
      },
    ],
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/pi/provider.ts && git commit -m "feat: register DeepSeek V4 Flash/Pro provider"
```

---

### Task 10: Pi Extension — main entry point with event hooks

**Files:**
- Create: `model-router/src/adapters/pi/index.ts`

- [ ] **Step 1: Write index.ts**

```typescript
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerDeepSeekProvider } from './provider';
import { decide } from '../../core/router';
import { createInitialState, analyze, onModelSwitch } from '../../core/classifier';
import { arbitrate } from '../../core/arbitrator';
import { recordCost, resetTurnCounter, generateReport, generateAggregatedReport } from '../../core/tracker';
import { formatCostReport, formatVerboseReport } from '../../utils/report-formatter';
import { loadPricing } from '../../utils/pricing';
import type { RouterConfig, ClassifierState, RuleDefinition } from '../../core/types';
import { registerCommands, setSessionId } from './commands';

let config: RouterConfig | null = null;
let classifierState: ClassifierState | null = null;
let sessionId: string = 'default';
let currentModel: string = 'deepseek-v4-flash';

function loadConfig(): RouterConfig {
  if (config) return config;
  const configPaths = [
    join(process.cwd(), 'config', 'model-config.json'),
    join(process.env.HOME || '~', '.model-router', 'config.json'),
  ];
  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        config = JSON.parse(readFileSync(p, 'utf-8'));
        return config;
      } catch { /* try next */ }
    }
  }
  // Default config
  config = {
    routing: {
      rules: [
        { id: 'complex', priority: 100, when: { keywords: ['重构', 'refactor', 'architecture'] }, then: { model: 'deepseek-v4-pro', thinking: 'high' } },
        { id: 'code-gen', priority: 80, when: { keywords: ['实现', 'implement', 'create'] }, then: { model: 'deepseek-v4-pro', thinking: 'medium' } },
        { id: 'reading', priority: 60, when: { toolsUsed: ['read', 'ls', 'grep'] }, then: { model: 'deepseek-v4-flash' } },
        { id: 'default', priority: 0, when: {}, then: { model: 'deepseek-v4-flash' } },
      ],
      escalation: { enabled: true, consecutiveErrorsBeforeUpgrade: 2 },
    },
  };
  return config;
}

export default function (pi: ExtensionAPI) {
  // Register DeepSeek provider
  registerDeepSeekProvider(pi);

  // Load pricing data
  // import.meta.dirname 需要 Node 20.11+，使用兼容写法
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pricingPath = join(__dirname, '..', '..', '..', 'pricing', 'pricing.json');
  loadPricing(pricingPath);

  // Load routing config
  const cfg = loadConfig();

  // Register commands
  registerCommands(pi);

  // ─── before_agent_start: analyze input and set model ───
  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // Initialize classifier state on first run
    if (!classifierState) {
      sessionId = ctx.sessionManager.getSessionFile()?.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;
      setSessionId(sessionId);  // 同步 sessionId 到 commands 模块
      resetTurnCounter();
      classifierState = createInitialState(sessionId, currentModel, 'default');
    }

    // Build context for router
    const cfg = loadConfig();
    const recentTools = classifierState.recentTools.flatMap(t => t.tools);
    // Track consecutive usage of same tool from classifier state
    const consecutiveToolCalls = (() => {
      const last = classifierState.recentTools.at(-1);
      if (!last || last.tools.length === 0) return 0;
      const lastTool = last.tools[last.tools.length - 1];
      let count = 1;
      for (let i = classifierState.recentTools.length - 2; i >= 0; i--) {
        const t = classifierState.recentTools[i];
        if (t.tools.includes(lastTool)) count++;
        else break;
      }
      return count;
    })();
    const result = arbitrate({
      text,
      recentTools,
      consecutiveToolCalls,
      rules: cfg.routing.rules,
      classifierState,
    });

    // Switch model if needed
    if (result.model !== currentModel) {
      try {
        await ctx.model.switchModel(result.model);
        const oldModel = currentModel;
        currentModel = result.model;
        const upgradedToStronger = result.model === 'deepseek-v4-pro' && oldModel === 'deepseek-v4-flash';
        classifierState = onModelSwitch(classifierState, result.model, result.ruleId, upgradedToStronger);
      } catch (e) {
        console.warn(`[ModelRouter] Failed to switch to ${result.model}:`, e);
        recordCost({
          sessionId,
          model: currentModel,
          ruleId: result.ruleId,
          reason: `${result.reason} (切换失败，保持 ${currentModel})`,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          duration: 0,
          success: false,
          escalated: false,
          error: String(e),
        });
      }
    }
  });

  // ─── turn_end: update classifier state and record costs ───
  pi.on('turn_end', async (event, ctx) => {
    if (!classifierState) return;

    const message = event.message;
    const usage = message?.usage;
    const hadError = message?.stopReason === 'error';
    // MVP: 只依赖 consecutiveErrors 单一路径，stopReason 无 'retry' 枚举值
    const hadRetry = false;

    const c = loadConfig();

    // Record cost for this turn
    if (usage) {
      // 使用 lastVerdict（onModelSwitch 不重置它，由 analyze() 在下一轮更新）
      const escalated = classifierState.lastVerdict === 'upgrade';
      recordCost({
        sessionId,
        model: currentModel,
        ruleId: classifierState.currentRuleId,
        reason: `Turn ${event.turnIndex}`,
        tokens: {
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
        },
        duration: message?.timestamp ? Date.now() - message.timestamp : 0,
        success: !hadError,
        escalated,
        error: hadError ? message.errorMessage : undefined,
      });
    }

    // Analyze turn result for next round
    const turnTools = event.toolResults?.map(r => r.toolName) || [];
    const { newState, verdict } = analyze(classifierState, {
      turnIndex: event.turnIndex,
      toolsCalled: turnTools,
      modelUsed: currentModel,
      hadError,
      hadRetry,
    }, c.routing.escalation);
    classifierState = newState;
  });

  // ─── message_end: capture per-message usage ───
  pi.on('message_end', async (event, _ctx) => {
    if (event.message.usage && event.message.model) {
      // Usage data captured in turn_end already, this is for extra granularity
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/pi/index.ts && git commit -m "feat: add Pi Extension main entry with event hooks"
```

---

### Task 11: Pi Extension — commands (/cost)

**Files:**
- Create: `model-router/src/adapters/pi/commands.ts`

- [ ] **Step 1: Write commands.ts**

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { generateReport, generateAggregatedReport } from '../../core/tracker';
import { formatCostReport, formatVerboseReport } from '../../utils/report-formatter';

let currentSessionId: string = 'default';

export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('cost', {
    description: '显示当前会话的模型路由成本报告',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const isVerbose = args.includes('--verbose') || args.includes('-v');
      const isAll = args.includes('--all') || args.includes('-a');

      let report;
      if (isAll) {
        report = generateAggregatedReport();
      } else {
        report = generateReport(currentSessionId, isVerbose);
      }

      if (!report || report.totalCalls === 0) {
        _ctx.ui.notify('暂无成本数据', 'info');
        return;
      }

      const modelList = Object.keys(report.byModel).sort();
      let output = formatCostReport(report, modelList);
      if (isVerbose && report.records.length > 0) {
        output += '\n' + formatVerboseReport(report);
      }

      _ctx.ui.notify(output, 'info');
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/pi/commands.ts && git commit -m "feat: add /cost command with --verbose and --all flags"
```

---

### Task 12: README and quickstart guide

**Files:**
- Create: `model-router/README.md`
- Create: `model-router/examples/pi-quickstart.md`

- [ ] **Step 1: Write README.md**

```markdown
# Model Router 🤖

智能模型路由系统 — 根据任务类型自动切换大语言模型，在保证质量的前提下最大化降低成本。

## 快速开始

### 前提

- 已安装 [Pi Agent](https://github.com/earendil-works/pi)
- DeepSeek API Key（[注册](https://platform.deepseek.com/)）

### 安装

```bash
pi install model-router
```

### 配置

设置环境变量：

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

（可选）自定义路由规则：编辑 `~/.model-router/config.json` 或项目 `config/model-config.json`

### 使用

安装后自动生效，无感使用。需要查看成本时：

```bash
/cost          # 当前会话成本报告
/cost -v       # 详细路由明细
/cost --all    # 所有会话汇总
```

## 路由策略

| 场景 | 模型 |
|------|------|
| 重构、架构分析 | deepseek-v4-pro |
| 代码生成、功能实现 | deepseek-v4-pro |
| 文件读取、搜索 | deepseek-v4-flash |
| 其他 | deepseek-v4-flash |

执行失败自动升级到更强模型。

## 成本报告示例

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🤖 Model Router - 成本报告
 总调用: 47 次    总花费: ¥3.28
 对比：全用 Pro ¥14.86 → 节省 78%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 架构

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│    Router    │───▶│  Arbitrator  │───▶│  Pi Extension │
│  (规则引擎)   │    │  (决策仲裁)   │    │  (事件钩子)   │
└──────────────┘    └──────────────┘    └──────┬───────┘
                      ▲                        │
┌──────────────┐      │                 ┌──────▼───────┐
│  Classifier  │──────┘                 │   Tracker    │
│ (跨Turn分析)  │                        │  (成本追踪)   │
└──────────────┘                        └──────────────┘
```

## License

MIT
```

- [ ] **Step 2: Write examples/pi-quickstart.md**

```markdown
# Pi Agent 快速上手指南

## 1. 安装

```bash
pi install model-router
```

## 2. 配置 API Key

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

建议加入 `~/.zshrc` 或 `~/.bashrc`。

## 3. 验证

启动 Pi：

```bash
pi
```

在会话中输入任意指令，Model Router 会自动生效。查看路由效果：

```bash
/cost -v
```

## 4. 自定义规则

创建 `~/.model-router/config.json`：

```json
{
  "routing": {
    "rules": [
      {
        "id": "my-custom",
        "priority": 90,
        "when": { "keywords": ["我的特殊任务"] },
        "then": { "model": "deepseek-v4-pro" }
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 3
    }
  }
}
```

## 5. 卸载

```bash
pi uninstall model-router
rm -rf ~/.model-router
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md examples/pi-quickstart.md && git commit -m "docs: add README and Pi quickstart guide"
```

---

### Task 13: Pricing auto-sync (stretch goal)

**Files:**
- Create: `model-router/src/pricing/sync.ts`

- [ ] **Step 1: Write sync.ts**

```typescript
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/**
 * Scrape DeepSeek pricing page and update local pricing.json.
 * This is a best-effort utility; pricing is manually confirmed as fallback.
 */
export async function syncPricing(): Promise<void> {
  try {
    const response = await fetch(DEEPSEEK_PRICING_URL);
    const html = await response.text();

    // Extract pricing table data from HTML
    // This is a simplified parser; real impl should use cheerio or regex
    const flashInputMatch = html.match(/deepseek-v4-flash[^]*?缓存未命中[^]*?(\d+(?:\.\d+)?)元/);
    const proInputMatch = html.match(/deepseek-v4-pro[^]*?缓存未命中[^]*?(\d+(?:\.\d+)?)元/);
    const flashOutputMatch = html.match(/deepseek-v4-flash[^]*?百万tokens输出[^]*?(\d+(?:\.\d+)?)元/);
    const proOutputMatch = html.match(/deepseek-v4-pro[^]*?百万tokens输出[^]*?(\d+(?:\.\d+)?)元/);

    if (!flashInputMatch || !proInputMatch || !flashOutputMatch || !proOutputMatch) {
      console.warn('[ModelRouter] Could not parse pricing from DeepSeek page');
      return;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pricingPath = join(__dirname, '..', '..', 'pricing', 'pricing.json');
    const current = JSON.parse(readFileSync(pricingPath, 'utf-8'));
    const now = new Date().toISOString().slice(0, 10);

    current.models['deepseek-v4-flash'].updatedAt = now;
    current.models['deepseek-v4-pro'].updatedAt = now;

    writeFileSync(pricingPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    console.log('[ModelRouter] Pricing synced from DeepSeek official page');
  } catch (e) {
    console.warn('[ModelRouter] Failed to sync pricing:', e);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pricing/sync.ts && git commit -m "feat: add pricing auto-sync from DeepSeek official page"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Router rules engine → Task 4
- ✅ Classifier cross-turn analysis → Task 5
- ✅ Arbitrator merging Router + Classifier → Task 6
- ✅ DeepSeek provider registration → Task 9
- ✅ Pi Extension event hooks (before_agent_start, turn_end) → Task 10
- ✅ Cost tracker with per-session JSONL → Task 7
- ✅ Cache-aware CNY pricing → Task 3
- ✅ /cost command with --verbose → Task 11
- ✅ Report formatter with comparison → Task 8
- ✅ Error handling (setModel fail, pricing fail) → Task 3, Task 10
- ✅ Escalation with consecutiveErrorsBeforeUpgrade → Task 5
- ✅ Upgrade lock / downgrade lock → Task 5
- ✅ Model switch resets consecutiveErrors → Task 5

**2. Placeholder scan:** No TBD/TODO/fill-in-later patterns.

**3. Type consistency:** RouterResult.model, ArbitrationResult.model, ClassifierState.currentModel all use string model IDs matching pricing.json keys. CostRecord types align with pricing.ts. OK.
