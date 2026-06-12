# Semantic Router Implementation Plan

> **For agentic workers:** Use this plan to implement the Semantic Router feature step-by-step. Each task uses checkbox (`- [ ]`) syntax for tracking. Complete tasks in order — each depends on the preceding ones.

**Goal:** Add semantic routing capability to Model Router — when keyword matching falls through to the default rule, use local embedding to classify the user's intent and route to the appropriate model.

**Architecture:**
- Core logic (semantic engine, cache, matcher) is framework-agnostic, separate from Pi adapter
- Hybrid strategy: fast path (existing keywords/tools) unchanged, semantic path only fires on default rule
- Three new files: `src/semantic/engine.ts`, `src/semantic/cache.ts`, `src/semantic/matcher.ts`
- One new shared-state file: `src/semantic/state.ts` — session-scoped flags shared between adapter and commands
- Modifications to: `types.ts`, `arbitrator.ts`, `commands.ts`, `index.ts`, `report-formatter.ts`, `tracker.ts`

**Tech Stack:** TypeScript, `@huggingface/transformers` (formerly `@xenova/transformers`, v3), `Xenova/paraphrase-multilingual-MiniLM-L12-v2` model (~120MB)

**Design Change Note:** `semanticRouting` defaults to `false` (opt-in). Users must explicitly enable it in config or via `/router on`. This avoids surprise 120MB downloads on upgrade.

---

### Task 1: Add dependency and update types

**Files:**
- Modify: `package.json` — add `@huggingface/transformers` (v3, pinned)
- Modify: `src/core/types.ts` — add new types and fields

- [ ] **Step 1: Add npm dependency**

Run:
```bash
cd model-router && npm install @huggingface/transformers@^3.0.0
```

> **Version lock:** v3 replaces the deprecated `@xenova/transformers`. If compatibility issues arise, fall back to `"@xenova/transformers": "~2.17.0"`. The API differences are minor: env config keys change from `localModelPath` to `cacheDir`.

- [ ] **Step 2: Update `src/core/types.ts`**

Add/change the following types:

```typescript
// ─── NEW: SemanticMatchResult (standalone type shared across matcher, arbitrator, tracker) ───

export interface SemanticMatchResult {
  ruleId: string;
  model: string;
  thinking?: string;
  similarity: number;
  allScores: Array<{ ruleId: string; similarity: number }>;
}

// ─── Update RuleDefinition — add description for semantic matching ───

export interface RuleDefinition {
  id: string;
  priority: number;
  when: MatchCondition;
  then: {
    model: string;
    thinking?: string;
  };
  description?: string;  // NEW: natural language description for semantic routing
}

// ─── Update ArbitrateInput — add semanticThreshold ───

export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
  semanticThreshold?: number;  // NEW: threshold from config, default 0.55
}

// ─── Update ArbitrationResult — add semanticMatch (reuses SemanticMatchResult shape) ───

export interface ArbitrationResult {
  model: string;
  ruleId: string;
  reason: string;
  thinking?: string;
  semanticMatch?: {               // NEW (semantic path only)
    similarity: number;
    threshold: number;
    allScores: Array<{ ruleId: string; similarity: number }>;
  };
}

// ─── Update CostRecord — add semanticMatch (reuses same shape) ───

export interface CostRecord {
  // ... existing fields ...
  semanticMatch?: {
    similarity: number;
    threshold: number;
    allScores: Array<{ ruleId: string; similarity: number }>;
  };
}
```

> **Type consistency note:** `SemanticMatchResult` is the standalone type used in matcher.ts return values and arbitrator.ts parameters. `ArbitrationResult.semanticMatch` and `CostRecord.semanticMatch` use an inline object type with identical shape (but are not the same type — one includes `ruleId`/`model`, the other is just scores). This is intentional: `SemanticMatchResult` is the "match output", while `semanticMatch` on the record is "match metadata for logging".

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 2: Shared state module — session-scoped flags

**Files:**
- Create: `src/semantic/state.ts`

- [ ] **Step 1: Write `src/semantic/state.ts`**

Addresses issues: `/router off` variable wiring断裂, multi-session concurrency, manual override tracking.

```typescript
/**
 * Session-scoped mutable state shared between the Pi adapter (index.ts)
 * and the command handlers (commands.ts).
 *
 * Uses Map<sessionId, ...> for multi-session safety.
 * When Pi reuses the module across sessions, each session gets independent state.
 */

export interface SessionSemanticState {
  /**
   * true = semantic routing disabled for this session (by /router off or engine failure).
   * /router on resets this to false.
   */
  disabled: boolean;

  /**
   * Number of remaining turns the user's manual /model selection blocks auto-routing.
   * Decremented each turn_end. 0 = no manual override.
   */
  manualOverrideRemaining: number;
}

const sessionStates = new Map<string, SessionSemanticState>();

function getOrCreate(sessionId: string): SessionSemanticState {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, { disabled: false, manualOverrideRemaining: 0 });
  }
  return sessionStates.get(sessionId)!;
}

export function getSessionState(sessionId: string): SessionSemanticState {
  return getOrCreate(sessionId);
}

export function setSessionDisabled(sessionId: string, v: boolean): void {
  getOrCreate(sessionId).disabled = v;
}

export function isSessionDisabled(sessionId: string): boolean {
  return getOrCreate(sessionId).disabled;
}

export function setManualOverrideRemaining(sessionId: string, v: number): void {
  getOrCreate(sessionId).manualOverrideRemaining = v;
}

export function getManualOverrideRemaining(sessionId: string): number {
  return getOrCreate(sessionId).manualOverrideRemaining;
}

/** Clean up session state (call when session ends). */
export function clearSession(sessionId: string): void {
  sessionStates.delete(sessionId);
}
```

---

### Task 3: Semantic engine — embedding computation

**Files:**
- Create: `src/semantic/engine.ts`

- [ ] **Step 1: Write `src/semantic/engine.ts`**

Addresses issues: `@huggingface/transformers` v3 API, `env.cacheDir` instead of `env.localModelPath`, race condition in `ensureEngineLoaded`.

```typescript
import { env, pipeline } from '@huggingface/transformers';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const MODEL_CACHE_DIR = join(process.env.HOME || '~', '.model-router', 'models');

export interface SemanticEngine {
  ready: boolean;
  loadModel(modelPath?: string): Promise<void>;
  encode(text: string): Promise<Float32Array>;
  similarity(a: Float32Array, b: Float32Array): number;
  dispose(): void;
}

export class DefaultSemanticEngine implements SemanticEngine {
  private pipe: any = null;
  ready = false;

  async loadModel(modelPath?: string): Promise<void> {
    // Ensure cache directory exists
    if (!existsSync(MODEL_CACHE_DIR)) {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    }

    // v3 API: env.cacheDir (not env.localModelPath)
    env.cacheDir = modelPath || MODEL_CACHE_DIR;
    env.allowRemoteModels = true;

    // Load the feature extraction pipeline (quantized ONNX)
    this.pipe = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    this.ready = true;
  }

  async encode(text: string): Promise<Float32Array> {
    if (!this.ready || !this.pipe) {
      throw new Error('SemanticEngine not loaded');
    }
    const output = await this.pipe(text, { pooling: 'mean', normalize: true });
    return output.data as Float32Array;
  }

  similarity(a: Float32Array, b: Float32Array): number {
    // Cosine similarity (vectors are L2-normalized by the model)
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(-1, Math.min(1, dot));
  }

  dispose(): void {
    this.pipe = null;
    this.ready = false;
  }
}

// ─── Singleton + thread-safe lazy init ───

let engine: SemanticEngine | null = null;
let loadPromise: Promise<void> | null = null;

export function getEngine(): SemanticEngine {
  if (!engine) {
    engine = new DefaultSemanticEngine();
  }
  return engine;
}

/**
 * Ensure the engine is loaded. Safe for concurrent callers:
 * - First caller kicks off load, subsequent callers await the same promise.
 * - On failure, loadPromise is reset so retry is possible on next call.
 *   Already-awaiting callers receive the rejection and should retry.
 */
export function ensureEngineLoaded(modelPath?: string): Promise<void> {
  if (loadPromise) {
    return loadPromise;
  }

  const eng = getEngine();
  loadPromise = eng.loadModel(modelPath).catch((e) => {
    loadPromise = null; // reset so next call retries
    throw e;
  });

  return loadPromise;
}
```

- [ ] **Step 2: Write the test**

Create `__tests__/semantic/engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';

describe('SemanticEngine', () => {
  it('computes higher similarity for related texts than unrelated ones', async () => {
    const eng = getEngine();
    await ensureEngineLoaded();

    const a = await eng.encode('帮我重构这个模块');
    const b = await eng.encode('对现有代码进行架构调整');
    const c = await eng.encode('你好，今天天气真不错');

    expect(eng.similarity(a, b)).toBeGreaterThan(eng.similarity(a, c));
  });

  it('sets ready=true after load', () => {
    expect(getEngine().ready).toBe(true);
  });
});
```

- [ ] **Step 3: Run test**

Run:
```bash
npx vitest run __tests__/semantic/engine.test.ts
```
Expected: PASS (first run downloads ~120MB model, subsequent runs use cache).

---

### Task 4: Semantic cache — rule embedding precomputation

**Files:**
- Create: `src/semantic/cache.ts`

- [ ] **Step 1: Write `src/semantic/cache.ts`**

```typescript
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
```

- [ ] **Step 2: Write test**

Create `__tests__/semantic/cache.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';
import { SemanticCache } from '../src/semantic/cache';
import type { RuleDefinition } from '../src/core/types';

const sampleRules: RuleDefinition[] = [
  {
    id: 'complex', priority: 100,
    when: { keywords: ['重构'] },
    then: { model: 'deepseek-v4-pro' },
    description: '涉及跨模块重构或系统架构设计的复杂任务',
  },
  {
    id: 'reading', priority: 60,
    when: { toolsUsed: ['read'] },
    then: { model: 'deepseek-v4-flash' },
    // no description — skipped
  },
];

describe('SemanticCache', () => {
  it('only caches rules with non-empty description', async () => {
    const eng = getEngine();
    await ensureEngineLoaded();
    const cache = new SemanticCache(eng);
    await cache.compute(sampleRules);
    expect(cache.getAll()).toHaveLength(1);
    expect(cache.getAll()[0].ruleId).toBe('complex');
  });

  it('find returns cached rule by ID', async () => {
    const eng = getEngine();
    const cache = new SemanticCache(eng);
    await cache.compute(sampleRules);
    expect(cache.find('complex')).toBeDefined();
    expect(cache.find('reading')).toBeUndefined();
  });

  it('invalidate clears all entries', async () => {
    const eng = getEngine();
    const cache = new SemanticCache(eng);
    await cache.compute(sampleRules);
    cache.invalidate();
    expect(cache.getAll()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests**

Run:
```bash
npx vitest run __tests__/semantic/cache.test.ts
```
Expected: PASS.

---

### Task 5: Semantic matcher — matching logic

**Files:**
- Create: `src/semantic/matcher.ts`

- [ ] **Step 1: Write `src/semantic/matcher.ts`**

Addresses issue: removed dead `rules` parameter (all logic uses cache).

```typescript
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
```

- [ ] **Step 2: Write test**

Create `__tests__/semantic/matcher.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';
import { SemanticCache } from '../src/semantic/cache';
import { matchSemantic } from '../src/semantic/matcher';
import type { RuleDefinition } from '../src/core/types';

const rules: RuleDefinition[] = [
  {
    id: 'complex', priority: 100,
    when: { keywords: ['重构'] }, then: { model: 'deepseek-v4-pro' },
    description: '涉及跨模块重构或系统架构设计的复杂任务，需要深度因果推理',
  },
  {
    id: 'simple-qa', priority: 50,
    when: { keywords: ['什么是'] }, then: { model: 'deepseek-v4-flash' },
    description: '回答概念性问题、解释技术术语、总结文档内容',
  },
  {
    id: 'reading', priority: 60,
    when: { toolsUsed: ['read'] }, then: { model: 'deepseek-v4-flash' },
  },
];

describe('matchSemantic', () => {
  let engine: any;
  let cache: SemanticCache;

  beforeAll(async () => {
    engine = getEngine();
    await ensureEngineLoaded();
    cache = new SemanticCache(engine);
    await cache.compute(rules);
  });

  it('matches complex refactoring request to complex rule', async () => {
    const result = await matchSemantic('帮我重构这个项目的架构', 0.55, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('complex');
    expect(result!.similarity).toBeGreaterThan(0.5);
  });

  it('matches conceptual question to simple-qa', async () => {
    const result = await matchSemantic('什么是闭包？', 0.55, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('simple-qa');
  });

  it('returns null for ambiguous input below threshold', async () => {
    const result = await matchSemantic('谢谢，做得不错', 0.7, engine, cache);
    expect(result).toBeNull();
  });

  it('returns allScores for all matched rules', async () => {
    const result = await matchSemantic('什么是闭包？', 0.3, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.allScores.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run __tests__/semantic/matcher.test.ts`
Expected: PASS.

---

### Task 6: Update arbitrator — integrate semantic path with Classifier safety check

**Files:**
- Modify: `src/core/arbitrator.ts`

- [ ] **Step 1: Update `src/core/arbitrator.ts`**

Addresses issue: downgrade in semantic path now actually **changes the model** (not just the reason string).

```typescript
import type { RouterResult, ArbitrationResult, ClassifierState, RuleDefinition, SemanticMatchResult } from './types';
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
  return rule ? rule.priority >= 80 : false;
}

// ─── Main export ───

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

  if (classifierState.lastVerdict === 'upgrade') {
    const upgraded = getUpgradeTarget(routerResult.model);
    if (upgraded) {
      finalModel = upgraded;
      reason += ' + Classifier upgrade';
    }
  }

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
```

- [ ] **Step 2: Update existing arbitrator tests**

Modify `__tests__/arbitrator.test.ts` to add semantic path tests:

```typescript
import { describe, it, expect } from 'vitest';
import { arbitrate } from '../src/core/arbitrator';
import { createInitialState } from '../src/core/classifier';
import type { RuleDefinition, SemanticMatchResult } from '../src/core/types';

const rules: RuleDefinition[] = [
  { id: 'complex', priority: 100, when: { keywords: ['重构'] }, then: { model: 'deepseek-v4-pro' } },
  { id: 'reading', priority: 60, when: { toolsUsed: ['read'] }, then: { model: 'deepseek-v4-flash' } },
  { id: 'default', priority: 0, when: {}, then: { model: 'deepseek-v4-flash' } },
];

const mockSemantic: SemanticMatchResult = {
  ruleId: 'complex', model: 'deepseek-v4-pro', similarity: 0.74,
  allScores: [{ ruleId: 'complex', similarity: 0.74 }, { ruleId: 'reading', similarity: 0.31 }],
};

describe('arbitrate with semantic path', () => {
  it('semantic overrides default rule when classifier keeps', () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'keep' as const };
    const result = arbitrate(
      { text: '排查线上bug', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state },
      mockSemantic,
    );
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.semanticMatch).toBeDefined();
  });

  it('Classifier upgrade overrides semantic result', () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'upgrade' as const };
    const result = arbitrate(
      { text: '谢谢', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state },
      { ruleId: 'reading', model: 'deepseek-v4-flash', similarity: 0.45, allScores: [] },
    );
    expect(result.model).toBe('deepseek-v4-pro'); // upgraded from flash to pro
    expect(result.reason).toContain('upgrade');
  });

  it('Classifier downgrade actually changes model from Pro to Flash when semantic rule is weak', () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate(
      { text: '读这个文件', recentTools: ['read'], consecutiveToolCalls: 3, rules, classifierState: state },
      // semantic matches reading (priority 60, not strong), model suggests Pro
      { ruleId: 'reading', model: 'deepseek-v4-pro', similarity: 0.62, allScores: [] },
    );
    // reading rule (priority 60 < 80) is NOT strong → downgrade takes effect
    expect(result.model).toBe('deepseek-v4-flash'); // actually downgraded!
    expect(result.reason).toContain('downgrade');
  });

  it('Classifier downgrade vetoed when semantic rule is strong', () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate(
      { text: '重构架构', recentTools: ['read'], consecutiveToolCalls: 3, rules, classifierState: state },
      mockSemantic,
    );
    // complex rule (priority 100) is strong, downgrade should be vetoed
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('否决');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run __tests__/arbitrator.test.ts`
Expected: All PASS.

---

### Task 7: Update Pi adapter — integrate semantic routing into extension lifecycle

**Files:**
- Modify: `src/adapters/pi/index.ts`

- [ ] **Step 1: Update `src/adapters/pi/index.ts`**

Addresses issues: shared state module, multi-session Map, `/router on` triggers retry, `semanticRouting` defaults to `false`.

```typescript
// ... existing imports ...
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getEngine, ensureEngineLoaded } from '../../semantic/engine';
import { SemanticCache } from '../../semantic/cache';
import { matchSemantic } from '../../semantic/matcher';
import { setSessionId, setRetryInit } from './commands';  // ← required for /router wiring
import {
  getSessionState,
  setSessionDisabled,
  isSessionDisabled,
  setManualOverrideRemaining,
  getManualOverrideRemaining,
  clearSession,
} from '../../semantic/state';

// Semantic engine singletons
const semanticEngine = getEngine();
let semanticCache: SemanticCache | null = null;
let engineInitAttempted = false;
let engineInitFailed = false;

// ─── Init (with retry on /router on) ───

async function initSemanticEngine(): Promise<void> {
  if (semanticEngine.ready) return;
  engineInitAttempted = true;
  try {
    await ensureEngineLoaded();
    semanticCache = new SemanticCache(semanticEngine);
    // Load config and compute rule embeddings
    const cfg = loadConfig();
    await semanticCache.compute(cfg.routing.rules);
    engineInitFailed = false;
    console.log('[ModelRouter] 🧠 Semantic engine ready');
  } catch (e) {
    engineInitFailed = true;
    console.warn('[ModelRouter] ⚠️ Semantic engine init failed:', e);
  }
}

async function retryInit(): Promise<void> {
  engineInitFailed = false;
  engineInitAttempted = false;
  await initSemanticEngine();
}

export default function (pi: ExtensionAPI) {
  // ... existing setup (provider, pricing, commands) ...

  // Register /router command (see Task 8 for full implementation)
  // The command handler needs access to initSemanticEngine and retryInit

  // ─── before_agent_start ───
  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // Session detection
    const newSessionId = resolveSessionId(ctx);
    if (newSessionId !== sessionId || !classifierState) {
      // Clean up old session's semantic state
      clearSession(sessionId);
      sessionId = newSessionId;
      setSessionId(sessionId);
      resetTurnCounter();
      currentModel = 'deepseek-v4-flash';
      classifierState = createInitialState(sessionId, currentModel, 'default');
    }

    const cfg = loadConfig();
    const recentTools = classifierState.recentTools.flatMap((t) => t.tools);
    const consecutiveToolCalls = /* ... existing logic ... */ 0;

    // Determine semantic eligibility
    const semanticEnabled = cfg.routing.semanticRouting === true; // opt-in!
    const threshold = cfg.routing.semanticThreshold ?? 0.55;
    const sessionState = getSessionState(sessionId);
    const hasManualOverride = sessionState.manualOverrideRemaining > 0;

    // Fast path
    const routerResult = decide(cfg.routing.rules, { text, recentTools, consecutiveToolCalls });

    let semanticResult = null;

    // Touch semantic path only when:
    // 1. Fast path returned default rule
    // 2. semanticRouting is explicitly true in config
    // 3. Engine is ready (or can be lazy-init)
    // 4. Not disabled for this session
    // 5. No manual override in effect
    if (
      routerResult?.ruleId === 'default'
      && semanticEnabled
      && !isSessionDisabled(sessionId)
      && !hasManualOverride
    ) {
      // Lazy-init engine if not yet attempted
      if (!engineInitAttempted) {
        await initSemanticEngine();
      }

      if (semanticEngine.ready && semanticCache) {
        try {
          semanticResult = await matchSemantic(text, threshold, semanticEngine, semanticCache);
        } catch (e) {
          console.warn('[ModelRouter] ⚠️ Semantic match failed, disabling for session');
          setSessionDisabled(sessionId, true);
        }
      }
    }

    // Arbitrate
    const result = arbitrate(
      { text, recentTools, consecutiveToolCalls, rules: cfg.routing.rules, classifierState: classifierState!, semanticThreshold: threshold },
      semanticResult ?? undefined,
    );

    // ... existing model switching logic ...

    if (semanticResult) {
      console.log(`[ModelRouter] 🧠 Semantic: "${semanticResult.ruleId}" (${semanticResult.similarity.toFixed(2)})`);
    }
  });

  // ─── turn_end ───
  pi.on('turn_end', async (event, ctx) => {
    // ... existing cost recording logic ...

    // Pass semanticMatch to recordCost
    // (semanticMatch comes from the ArbitrationResult stored on the turn)

    // Decrement manualOverrideRemaining
    const ss = getSessionState(sessionId);
    if (ss.manualOverrideRemaining > 0) {
      ss.manualOverrideRemaining--;
    }

    // ... existing classifier analysis ...

    // Note: If model-config.json is modified during a session (e.g., rule descriptions changed),
    // the semantic cache won't auto-refresh. Run `/router off` then `/router on` to recompute
    // embeddings (initSemanticEngine → semanticCache.compute). This is acceptable for v1.
  });

  // Wire retryInit for /router on
  setRetryInit(retryInit);
}
```

---

### Task 8: Update Pi adapter — add /router command

**Files:**
- Modify: `src/adapters/pi/commands.ts`

- [ ] **Step 1: Update `src/adapters/pi/commands.ts`**

Addresses issue: `/router off` now directly manipulates session state via the shared state module. `/router on` triggers engine retry.

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { generateReport, generateAggregatedReport } from '../../core/tracker';
import { formatCostReport, formatVerboseReport } from '../../utils/report-formatter';
import {
  getSessionState,
  setSessionDisabled,
  isSessionDisabled,
  getManualOverrideRemaining,
} from '../../semantic/state';
import { getEngine } from '../../semantic/engine';

let currentSessionId = 'default';
let retryInitFn: (() => Promise<void>) | null = null;

export function setSessionId(id: string): void { currentSessionId = id; }
export function setRetryInit(fn: () => Promise<void>): void { retryInitFn = fn; }

export function registerCommands(pi: ExtensionAPI): void {
  // ... existing /cost handler ...

  pi.registerCommand('router', {
    description: '控制语义路由行为',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed === 'off') {
        setSessionDisabled(currentSessionId, true);
        _ctx.ui.notify('[ModelRouter] 🔇 语义路由已关闭（本会话）', 'info');
        return;
      }

      if (trimmed === 'on') {
        setSessionDisabled(currentSessionId, false);

        // Trigger engine retry if it failed before
        const eng = getEngine();
        if (!eng.ready && retryInitFn) {
          _ctx.ui.notify('[ModelRouter] 🔄 正在重新初始化语义引擎...', 'info');
          try {
            await retryInitFn();
            _ctx.ui.notify('[ModelRouter] 🔊 语义路由已开启', 'info');
          } catch {
            _ctx.ui.notify('[ModelRouter] ❌ 语义引擎初始化失败，请检查模型文件', 'error');
          }
        } else {
          _ctx.ui.notify('[ModelRouter] 🔊 语义路由已开启', 'info');
        }
        return;
      }

      // status
      const ss = getSessionState(currentSessionId);
      const eng = getEngine();
      // Load config for threshold display
      const cfg = loadConfig();
      const lines = ['━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ' 🧠 Model Router - 路由状态'];
      if (ss.manualOverrideRemaining > 0) {
        lines.push(` ⚠ 手动模型覆盖中（剩余 ${ss.manualOverrideRemaining} 轮）`);
      }
      lines.push(
        ` 语义引擎: ${eng.ready ? '已就绪' : (isSessionDisabled(currentSessionId) ? '已关闭' : '未就绪')}`,
        ` 会话状态: ${isSessionDisabled(currentSessionId) ? '已禁用' : '已启用'}`,
        ` 相似度阈值: ${cfg.routing.semanticThreshold ?? 0.55}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      );
      _ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
```

- [ ] **Step 2: Wire retryInit in index.ts**

Add in `src/adapters/pi/index.ts` (in the `export default` function body):

```typescript
import { setRetryInit } from './commands';

// After registering commands:
setRetryInit(retryInit);
```

---

### Task 9: Update report formatter — add /cost -vv support

**Files:**
- Modify: `src/utils/report-formatter.ts`

- [ ] **Step 1: Update `src/utils/report-formatter.ts`**

> **Note:** `verbosity` parameter changes the function signature. All callers in `commands.ts` must be updated to pass `verbosity` (default 1 for `-v`, 2 for `-vv`).

```typescript
export function formatVerboseReport(report: CostReport, verbosity: number = 1): string {
  const lines: string[] = [];
  lines.push(SEP);
  lines.push(verbosity >= 2 ? ' 路由明细（含语义候选排名）:' : ' 路由明细:');
  lines.push(` ${'时间'.padEnd(22)} ${'模型'.padEnd(18)} ${'规则'.padEnd(16)} 原因`);
  lines.push(SEP);

  for (const r of report.records) {
    const time = r.timestamp.slice(11, 19);
    const turn = r.turn !== undefined ? `#${r.turn}` : '';
    lines.push(` ${time.padEnd(22)} ${`${r.model}${turn}`.padEnd(18)} ${r.ruleId.padEnd(16)} ${r.reason}`);

    // Verbosity level 2: show semantic similarity ranking
    if (verbosity >= 2 && r.semanticMatch) {
      const scores = r.semanticMatch.allScores
        .map((s) => `${s.ruleId} ${s.similarity.toFixed(2)}`)
        .join(', ');
      lines.push(`   └ 候选: ${scores}`);
    }
  }
  lines.push(SEP);
  return lines.join('\n');
}
```

- [ ] **Step 2: Update commands.ts /cost handler**

```typescript
const isVVerbose = args.includes('-vv');
const output = isVerbose
  ? formatVerboseReport(report, isVVerbose ? 2 : 1)
  : formatCostReport(report, modelList);
```

---

### Task 10: Update config — default descriptions and semantic routing config

**Files:**
- Modify: `config/model-config.json`

- [ ] **Step 1: Update `config/model-config.json`**

Add `semanticRouting` (default `false`, opt-in), `semanticThreshold`, and `description` fields to all 5 rules:

```json
{
  "routing": {
    "semanticRouting": false,
    "semanticThreshold": 0.55,
    "rules": [
      {
        "id": "complex-task",
        "priority": 100,
        "when": {
          "keywords": ["重构", "架构", "设计", "架构分析", "refactor", "architecture"],
          "notKeywords": ["小重构", "简单调整"]
        },
        "then": { "model": "deepseek-v4-pro", "thinking": "high" },
        "description": "涉及跨模块或全系统范围的代码重构、软件架构设计与评估、技术方案选型与权衡分析、需要深度因果关系推理的复杂问题排查，或对现有系统做结构性改造的设计讨论。"
      },
      {
        "id": "code-generation",
        "priority": 80,
        "when": {
          "keywords": ["实现", "implement", "写一个", "create", "add feature", "修改", "改"]
        },
        "then": { "model": "deepseek-v4-pro", "thinking": "medium" },
        "description": "编写新功能、实现业务逻辑、创建组件或模块、修改现有代码行为、修复缺陷、添加功能特性、优化代码性能，需要生成大量代码的任务。"
      },
      {
        "id": "file-reading",
        "priority": 60,
        "when": {
          "toolsUsed": ["read", "ls", "grep", "find"]
        },
        "then": { "model": "deepseek-v4-flash", "thinking": "off" },
        "description": "浏览项目文件、阅读源代码、搜索特定代码片段、查找定义或引用、了解项目结构、阅读文档或注释，以信息收集和阅读理解为主的任务。"
      },
      {
        "id": "simple-qa",
        "priority": 50,
        "when": {
          "keywords": ["解释", "explain", "什么是", "what is", "总结", "summarize"]
        },
        "then": { "model": "deepseek-v4-flash", "thinking": "off" },
        "description": "回答概念性问题、解释技术术语或原理、总结文档内容、对比两个事物的异同、提供事实性信息，不需要生成或修改代码的问答。"
      },
      {
        "id": "default",
        "priority": 0,
        "when": {},
        "then": { "model": "deepseek-v4-flash", "thinking": "off" },
        "description": "其他未被上述规则覆盖的通用任务，包括闲聊、工具使用确认、简单文件操作反馈、会话管理、或意图不明确的简短指令。"
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 2
    }
  }
}
```

- [ ] **Step 2: Verify config is valid JSON**

Run:
```bash
python3 -m json.tool config/model-config.json > /dev/null && echo 'Valid JSON'
```
Expected: `Valid JSON`.

---

### Task 11: Update tracker — semanticMatch field in CostRecord

**Files:**
- Modify: `src/core/tracker.ts`

- [ ] **Step 1: Update `recordCost` to accept optional `semanticMatch`**

```typescript
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
  semanticMatch?: ArbitrationResult['semanticMatch'];  // NEW
}): CostRecord {
  // ... existing logic ...
  if (params.semanticMatch) {
    record.semanticMatch = params.semanticMatch;
  }
  return record;
}
```

---

### Task 12: Integration test — full semantic routing flow

**Files:**
- Create: `__tests__/router-semantic.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';
import { SemanticCache } from '../src/semantic/cache';
import { matchSemantic } from '../src/semantic/matcher';
import { decide } from '../src/core/router';
import { arbitrate } from '../src/core/arbitrator';
import { createInitialState } from '../src/core/classifier';
import type { RuleDefinition } from '../src/core/types';

const rules: RuleDefinition[] = [
  {
    id: 'complex', priority: 100,
    when: { keywords: ['重构'] }, then: { model: 'deepseek-v4-pro' },
    description: '涉及跨模块重构或架构设计的复杂任务',
  },
  { id: 'reading', priority: 60, when: { toolsUsed: ['read'] }, then: { model: 'deepseek-v4-flash' } },
  { id: 'default', priority: 0, when: {}, then: { model: 'deepseek-v4-flash' } },
];

describe('full semantic routing flow', () => {
  let engine: any;
  let cache: SemanticCache;

  beforeAll(async () => {
    engine = getEngine();
    await ensureEngineLoaded();
    cache = new SemanticCache(engine);
    await cache.compute(rules);
  });

  it('keyword match → fast path, no semantic involved', async () => {
    const routerResult = decide(rules, { text: '重构这个模块', recentTools: [], consecutiveToolCalls: 0 });
    expect(routerResult?.ruleId).toBe('complex');
    // Fast path matched non-default rule — semantic not needed
  });

  it('default rule + semantic match → semantic path takes over', async () => {
    const routerResult = decide(rules, { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0 });
    expect(routerResult?.ruleId).toBe('default');

    const semanticResult = await matchSemantic('帮我排查线上bug', 0.55, engine, cache);
    expect(semanticResult).not.toBeNull();

    const state = createInitialState('s1', 'flash', 'default');
    const final = arbitrate(
      { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.55 },
      semanticResult!,
    );
    expect(final.model).toBe('deepseek-v4-pro');
    expect(final.semanticMatch).toBeDefined();
  });

  it('default rule + no semantic match → falls back to default', async () => {
    const semanticResult = await matchSemantic('谢谢', 0.85, engine, cache);
    // High threshold filters everything
    const state = createInitialState('s1', 'flash', 'default');
    const final = arbitrate(
      { text: '谢谢', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.85 },
      semanticResult,
    );
    expect(final.model).toBe('deepseek-v4-flash');
    expect(final.ruleId).toBe('default');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run __tests__/semantic/ __tests__/router-semantic.test.ts`
Expected: All PASS.

---

### Task 13: Final validation

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```
No errors.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```
All existing tests pass. All new semantic tests pass.

- [ ] **Step 3: Verify backward compatibility**

- Config without `semanticRouting` → defaults to `false`, no model download, semantic path never fires
- Config with `"semanticRouting": true` but rules without `description` → semantic cache empty, `matchSemantic` returns null, falls back to default rule
- `/cost`, `/cost -v`, `/cost -vv`, `/router`, `/router off`, `/router on` all respond correctly
- Delete `semanticRouting` field from config → service starts normally without attempting model download (opt-in safety)

- [ ] **Step 4: Verify multi-session isolation**

- Session A: `/router off` → only session A disabled
- Session B: semantic routing still works
- Verify `sessionStates` Map has independent entries

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | `package.json`, `types.ts` | Dependency + types (incl. `SemanticMatchResult`) |
| 2 | `src/semantic/state.ts` | Shared session state (solves wiring断裂 + multi-session) |
| 3 | `src/semantic/engine.ts`, test | ONNX engine (`@huggingface/transformers` v3, `env.cacheDir`, race-condition-safe) |
| 4 | `src/semantic/cache.ts`, test | Rule embedding cache (incl. `find()` for debugging) |
| 5 | `src/semantic/matcher.ts`, test | Semantic matching (removed dead `rules` param) |
| 6 | `src/core/arbitrator.ts`, test | Arbitrator with `SemanticMatchResult`, `getDowngradeTarget` actually changes model |
| 7 | `src/adapters/pi/index.ts` | Adapter integration (state module, retry on `/router on`, opt-in default) |
| 8 | `src/adapters/pi/commands.ts` | `/router` command (session-scoped, retryInit wired) |
| 9 | `src/utils/report-formatter.ts` | `/cost -vv` with verbosity parameter |
| 10 | `config/model-config.json` | Default descriptions + `semanticRouting: false` (opt-in) |
| 11 | `src/core/tracker.ts` | `semanticMatch` in `CostRecord` |
| 12 | `__tests__/router-semantic.test.ts` | Integration test |
| 13 | — | Final validation (type check, full test suite, backward compat, multi-session) |
