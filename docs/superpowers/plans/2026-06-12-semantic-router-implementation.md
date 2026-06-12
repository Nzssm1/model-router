# Semantic Router Implementation Plan

> **For agentic workers:** Use this plan to implement the Semantic Router feature step-by-step. Each task uses checkbox (`- [ ]`) syntax for tracking. Complete tasks in order — each depends on the preceding ones.

**Goal:** Add semantic routing capability to Model Router — when keyword matching falls through to the default rule, use local embedding to classify the user's intent and route to the appropriate model.

**Architecture:**
- Core logic (semantic engine, cache, matcher) is framework-agnostic, separate from Pi adapter
- Hybrid strategy: fast path (existing keywords/tools) unchanged, semantic path only fires on default rule
- Three new files: `src/semantic/engine.ts`, `src/semantic/cache.ts`, `src/semantic/matcher.ts`
- Modifications to: `types.ts`, `arbitrator.ts`, `commands.ts`, `index.ts`, `report-formatter.ts`, `tracker.ts`

**Tech Stack:** TypeScript, `@xenova/transformers` (ONNX), paraphrase-multilingual-MiniLM-L12-v2 model (~120MB)

---

### Task 1: Add dependency and update types

**Files:**
- Modify: `package.json` — add `@xenova/transformers`
- Modify: `src/core/types.ts` — add new types and fields

- [ ] **Step 1: Add npm dependency**

Run:
```bash
cd model-router && npm install @xenova/transformers
```

- [ ] **Step 2: Update `src/core/types.ts`**

Add/change the following types:

```typescript
// Update RuleDefinition — add description for semantic matching
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

// Update ArbitrateInput — add semanticThreshold
export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
  semanticThreshold?: number;  // NEW: threshold from config, default 0.55
}

// Update ArbitrationResult — add semanticMatch
export interface ArbitrationResult {
  model: string;
  ruleId: string;
  reason: string;
  thinking?: string;
  semanticMatch?: {  // NEW (semantic path only)
    similarity: number;
    threshold: number;
    allScores: Array<{ ruleId: string; similarity: number }>;
  };
}

// Update CostRecord — add semanticMatch
export interface CostRecord {
  // ... existing fields ...
  semanticMatch?: {
    similarity: number;
    threshold: number;
    allScores: Array<{ ruleId: string; similarity: number }>;
  };
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: No type errors.

---

### Task 2: Semantic engine — embedding computation

**Files:**
- Create: `src/semantic/engine.ts`

- [ ] **Step 1: Write `src/semantic/engine.ts`**

```typescript
import { env, pipeline } from '@xenova/transformers';
import { resolve, join } from 'node:path';
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
    try {
      // Ensure cache directory exists
      if (!existsSync(MODEL_CACHE_DIR)) {
        mkdirSync(MODEL_CACHE_DIR, { recursive: true });
      }

      // Set cache directory for transformers
      env.localModelPath = modelPath || MODEL_CACHE_DIR;
      env.allowRemoteModels = true;

      // Load the feature extraction pipeline
      this.pipe = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true,
      });

      this.ready = true;
    } catch (e) {
      this.ready = false;
      throw e;
    }
  }

  async encode(text: string): Promise<Float32Array> {
    if (!this.ready || !this.pipe) {
      throw new Error('SemanticEngine not loaded');
    }
    const output = await this.pipe(text, {
      pooling: 'mean',
      normalize: true,
    });
    return output.data as Float32Array;
  }

  similarity(a: Float32Array, b: Float32Array): number {
    // Cosine similarity (vectors are already normalized by the model)
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    // Clamp to [-1, 1] to avoid floating point drift
    return Math.max(-1, Math.min(1, dot));
  }

  dispose(): void {
    this.pipe = null;
    this.ready = false;
  }
}

// Singleton engine
let engine: SemanticEngine | null = null;
let loadPromise: Promise<void> | null = null;

export function getEngine(): SemanticEngine {
  if (!engine) {
    engine = new DefaultSemanticEngine();
  }
  return engine;
}

export function ensureEngineLoaded(modelPath?: string): Promise<void> {
  if (!loadPromise) {
    const eng = getEngine();
    loadPromise = eng.loadModel(modelPath).catch((e) => {
      loadPromise = null; // Reset so retry is possible
      throw e;
    });
  }
  return loadPromise;
}
```

- [ ] **Step 2: Write the test**

Create `__tests__/semantic/engine.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';

describe('SemanticEngine', () => {
  it('should compute similarity between related texts', async () => {
    const eng = getEngine();
    await ensureEngineLoaded();

    const a = await eng.encode('帮我重构这个模块');
    const b = await eng.encode('对现有代码进行架构调整');
    const c = await eng.encode('你好，今天天气真不错');

    const simRelated = eng.similarity(a, b);
    const simUnrelated = eng.similarity(a, c);

    // Related should score higher than unrelated
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it('should be ready after load', () => {
    const eng = getEngine();
    expect(eng.ready).toBe(true);
  });
});
```

- [ ] **Step 3: Run test**

Run:
```bash
npx vitest run __tests__/semantic/engine.test.ts
```
Expected: PASS (first run downloads ~120MB model, subsequent runs use cache)

---

### Task 3: Semantic cache — rule embedding precomputation

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

  /**
   * Precompute embeddings for all rules that have a description.
   * Rules without description are skipped.
   */
  async compute(rules: RuleDefinition[]): Promise<void> {
    const withDescription = rules.filter((r) => r.description?.trim());
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

  /** Get all cached embeddings. */
  getAll(): CachedRuleEmbedding[] {
    return this.entries;
  }

  /** Clear cache (e.g., on config change). */
  invalidate(): void {
    this.entries = [];
  }
}
```

- [ ] **Step 2: Write test**

Create `__tests__/semantic/cache.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../src/semantic/engine';
import { SemanticCache } from '../src/semantic/cache';
import type { RuleDefinition } from '../src/core/types';

const sampleRules: RuleDefinition[] = [
  {
    id: 'complex',
    priority: 100,
    when: { keywords: ['重构'] },
    then: { model: 'deepseek-v4-pro' },
    description: '涉及跨模块重构或系统架构设计的复杂任务',
  },
  {
    id: 'reading',
    priority: 60,
    when: { toolsUsed: ['read'] },
    then: { model: 'deepseek-v4-flash' },
    // no description — should be skipped
  },
];

describe('SemanticCache', () => {
  it('should only cache rules with description', async () => {
    const eng = getEngine();
    await ensureEngineLoaded();
    const cache = new SemanticCache(eng);
    await cache.compute(sampleRules);
    expect(cache.getAll()).toHaveLength(1);
    expect(cache.getAll()[0].ruleId).toBe('complex');
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
Expected: PASS

---

### Task 4: Semantic matcher — matching logic

**Files:**
- Create: `src/semantic/matcher.ts`

- [ ] **Step 1: Write `src/semantic/matcher.ts`**

```typescript
import type { RuleDefinition, SemanticMatchResult } from '../core/types';
import type { SemanticEngine } from './engine';
import { SemanticCache } from './cache';

export async function matchSemantic(
  input: string,
  rules: RuleDefinition[],
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
    id: 'complex',
    priority: 100,
    when: { keywords: ['重构'] },
    then: { model: 'deepseek-v4-pro' },
    description: '涉及跨模块重构或系统架构设计的复杂任务，需要深度因果推理',
  },
  {
    id: 'simple-qa',
    priority: 50,
    when: { keywords: ['什么是'] },
    then: { model: 'deepseek-v4-flash' },
    description: '回答概念性问题、解释技术术语、总结文档内容',
  },
  {
    id: 'reading',
    priority: 60,
    when: { toolsUsed: ['read'] },
    then: { model: 'deepseek-v4-flash' },
    // no description — skipped
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
    const result = await matchSemantic('帮我重构这个项目的架构', rules, 0.55, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('complex');
    expect(result!.similarity).toBeGreaterThan(0.5);
  });

  it('matches conceptual question to simple-qa', async () => {
    const result = await matchSemantic('什么是闭包？', rules, 0.55, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('simple-qa');
    expect(result!.similarity).toBeGreaterThan(0.5);
  });

  it('returns null for ambiguous input below threshold', async () => {
    const result = await matchSemantic('谢谢，做得不错', rules, 0.7, engine, cache);
    expect(result).toBeNull();
  });

  it('returns allScores containing all matched rules', async () => {
    const result = await matchSemantic('什么是闭包？', rules, 0.3, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.allScores.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run:
```bash
npx vitest run __tests__/semantic/matcher.test.ts
```
Expected: PASS

---

### Task 5: Update arbitrator — integrate semantic path with Classifier safety check

**Files:**
- Modify: `src/core/arbitrator.ts`

- [ ] **Step 1: Update `src/core/arbitrator.ts`**

```typescript
import type { RouterResult, ArbitrationResult, ClassifierState, Verdict, RuleDefinition } from './types';
import { decide, type RouterContext } from './router';
import type { SemanticMatchResult } from './types';

export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
  semanticThreshold?: number;  // NEW
}

// Keep existing helper functions
function getUpgradeTarget(currentModel: string): string | null {
  if (currentModel === 'deepseek-v4-flash') return 'deepseek-v4-pro';
  return null;
}

function isStrongRule(ruleId: string, rules: RuleDefinition[]): boolean {
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return false;
  return rule.priority >= 80;
}

// Updated to accept optional SemanticMatchResult
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

    // Classifier upgrade always overrides semantic result (safety first)
    if (classifierState.lastVerdict === 'upgrade') {
      const upgraded = getUpgradeTarget(finalModel);
      if (upgraded) {
        finalModel = upgraded;
        reason += ` + Classifier upgrade (覆盖语义结果)`;
      }
    }

    if (classifierState.lastVerdict === 'downgrade') {
      const needsStrong = isStrongRule(semanticResult.ruleId, input.rules);
      if (needsStrong) {
        reason += ` (downgrade 被语义规则 ${semanticResult.ruleId} 否决)`;
      } else {
        reason += ` + Classifier downgrade`;
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

  // ─── Original logic for non-default-rule paths ───
  let finalModel = routerResult.model;
  let reason = `规则 ${routerResult.ruleId} 匹配`;

  if (classifierState.lastVerdict === 'upgrade') {
    const upgradeTarget = getUpgradeTarget(routerResult.model);
    if (upgradeTarget) {
      finalModel = upgradeTarget;
      reason += ` + Classifier upgrade`;
    }
  }

  if (classifierState.lastVerdict === 'downgrade') {
    const needsStrong = isStrongRule(routerResult.ruleId, input.rules);
    if (!needsStrong) {
      finalModel = routerResult.model;
      reason += ` + Classifier downgrade`;
    } else {
      reason += ` (downgrade 被规则 ${routerResult.ruleId} 否决)`;
    }
  }

  return { model: finalModel, ruleId: routerResult.ruleId, reason, thinking: routerResult.thinking };
}
```

- [ ] **Step 2: Update existing arbitrator tests**

Modify `__tests__/arbitrator.test.ts` to add tests for semantic path:

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

// New: semantic match results
const semanticSimpleQA: SemanticMatchResult = {
  ruleId: 'complex',
  model: 'deepseek-v4-pro',
  similarity: 0.74,
  allScores: [{ ruleId: 'complex', similarity: 0.74 }, { ruleId: 'reading', similarity: 0.31 }],
};

describe('arbitrate with semantic path', () => {
  it('semantic result overrides default rule when classifier keeps', () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'keep' as const };
    // Fast path returns default (no keywords match)
    const result = arbitrate(
      { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state },
      semanticSimpleQA,
    );
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.semanticMatch).toBeDefined();
  });

  it('Classifier upgrade overrides semantic result', () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'upgrade' as const };
    const result = arbitrate(
      { text: '谢谢', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state },
      // semantic might match simple-qa, but upgrade should override
      { ruleId: 'simple-qa', model: 'deepseek-v4-flash', similarity: 0.45, allScores: [] },
    );
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('upgrade');
  });

  it('without semantic result, falls back to existing logic', () => {
    const state = createInitialState('s1', 'flash', 'default');
    const result = arbitrate({
      text: '读这个文件',
      recentTools: ['read'],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.ruleId).toBe('reading');
  });
});
```

- [ ] **Step 3: Run tests**

Run:
```bash
npx vitest run __tests__/arbitrator.test.ts
```
Expected: PASS

---

### Task 6: Update Pi adapter — integrate semantic routing into extension lifecycle

**Files:**
- Modify: `src/adapters/pi/index.ts`

- [ ] **Step 1: Update `src/adapters/pi/index.ts`**

Add semantic engine initialization, model pre-download, and integrate into `before_agent_start`:

```typescript
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// ... existing imports ...
import { getEngine, ensureEngineLoaded } from '../../semantic/engine';
import { SemanticCache } from '../../semantic/cache';
import { matchSemantic } from '../../semantic/matcher';

// Add module-level state
let semanticEngine = getEngine();
let semanticCache: SemanticCache | null = null;
let sessionSemanticDisabled = false;
const MODEL_CACHE_DIR = join(process.env.HOME || '~', '.model-router', 'models');

// Pre-download and preload semantic model on startup
async function initSemanticEngine(): Promise<void> {
  try {
    if (!existsSync(MODEL_CACHE_DIR)) {
      mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    }
    await ensureEngineLoaded();
    semanticCache = new SemanticCache(semanticEngine);
    await semanticCache.compute(loadConfig().routing.rules);
    console.log('[ModelRouter] 🧠 Semantic engine ready');
  } catch (e) {
    console.warn('[ModelRouter] ⚠️ Semantic engine init failed, will retry on demand:', e);
  }
}

// In the export default function, add to before_agent_start:
export default function (pi: ExtensionAPI) {
  // ... existing setup (provider, pricing, commands) ...

  // Initialize semantic engine
  initSemanticEngine();

  // ... existing event handlers ...

  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // ... existing session detection and classifier init ...

    const cfg = loadConfig();
    const semanticEnabled = cfg.routing.semanticRouting !== false;
    const threshold = cfg.routing.semanticThreshold ?? 0.55;
    const hasManualOverride = (classifierState?.manualOverrideRemaining ?? 0) > 0;

    // Step 1: Fast path (existing logic)
    const routerResult = decide(cfg.routing.rules, {
      text,
      recentTools,
      consecutiveToolCalls,
    });

    let semanticResult = null;

    // Step 2: Semantic path — only when:
    //   - fast path returned default rule
    //   - semantic routing is enabled
    //   - engine is ready
    //   - not disabled for this session
    //   - no manual override active
    if (
      routerResult?.ruleId === 'default'
      && semanticEnabled
      && semanticEngine.ready
      && !sessionSemanticDisabled
      && !hasManualOverride
      && semanticCache
    ) {
      try {
        semanticResult = await matchSemantic(
          text,
          cfg.routing.rules,
          threshold,
          semanticEngine,
          semanticCache,
        );
      } catch (e) {
        console.warn('[ModelRouter] ⚠️ Semantic match failed, disabling for session:', e);
        sessionSemanticDisabled = true;
      }
    }

    // Step 3: Arbitrate (now receives optional semanticResult)
    const result = arbitrate(
      {
        text,
        recentTools,
        consecutiveToolCalls,
        rules: cfg.routing.rules,
        classifierState: classifierState!,
        semanticThreshold: threshold,
      },
      semanticResult,
    );

    // ... existing model switching logic ...

    // Log semantic path info
    if (semanticResult) {
      console.log(
        `[ModelRouter] 🧠 Semantic match: "${semanticResult.ruleId}" (${semanticResult.similarity.toFixed(2)})`,
      );
    }
  });

  // turn_end: update cache if config changed (optional)
  // Reset sessionSemanticDisabled on /router on
  // ...
}
```

- [ ] **Step 2: Verify compilation**

Run:
```bash
npx tsc --noEmit
```
Expected: No errors

---

### Task 7: Update Pi adapter — add /router command

**Files:**
- Modify: `src/adapters/pi/commands.ts`

- [ ] **Step 1: Update `src/adapters/pi/commands.ts`**

Add `/router` command (on/off/status):

```typescript
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
// ... existing imports ...

// Module-level ref to the semantic disabled flag (set from index.ts)
let sessionSemanticDisabledRef = false;
let sessionManualOverrideRef = 0;

export function setSemanticDisabled(v: boolean): void {
  sessionSemanticDisabledRef = v;
}
export function setManualOverrideRemaining(v: number): void {
  sessionManualOverrideRef = v;
}

export function registerCommands(pi: ExtensionAPI): void {
  // ... existing /cost command ...

  pi.registerCommand('router', {
    description: '控制语义路由行为',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed === 'off') {
        // Emit event or directly set via a callback
        _ctx.ui.notify('[ModelRouter] 🔇 语义路由已关闭（本会话）', 'info');
        setSemanticDisabled(true);
        return;
      }

      if (trimmed === 'on') {
        setSemanticDisabled(false);
        setManualOverrideRemaining(0);
        _ctx.ui.notify('[ModelRouter] 🔊 语义路由已开启', 'info');
        return;
      }

      // status (default)
      const statusLines = [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ' 🧠 Model Router - 路由状态',
      ];
      if (sessionManualOverrideRef > 0) {
        statusLines.push(` ⚠ 手动模型覆盖中（剩余 ${sessionManualOverrideRef} 轮）`);
      }
      statusLines.push(
        ` 语义引擎: ${sessionSemanticDisabledRef ? '已关闭' : '已开启'}`,
        ` 阈值: ${config.semanticThreshold ?? 0.55}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      );
      _ctx.ui.notify(statusLines.join('\n'), 'info');
    },
  });
}
```

- [ ] **Step 2: Update `src/adapters/pi/index.ts`** to wire the refs and handle `/model` manual override

Add to index.ts:
```typescript
import { setSemanticDisabled, setManualOverrideRemaining } from './commands';

// In turn_end:
// Detect manual model switch, set manualOverrideRemaining
if (event.manualOverride) {
  classifierState.manualOverrideRemaining = 3;
  setManualOverrideRemaining(3);
}

// Decrement manualOverrideRemaining each turn
if (classifierState.manualOverrideRemaining > 0) {
  classifierState.manualOverrideRemaining--;
  setManualOverrideRemaining(classifierState.manualOverrideRemaining);
}
```

---

### Task 8: Update report formatter — add /cost -vv support

**Files:**
- Modify: `src/utils/report-formatter.ts`

- [ ] **Step 1: Update `src/utils/report-formatter.ts`**

```typescript
// In formatVerboseReport or a new formatVeryVerboseReport:

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

    // Verbosity level 2: show semantic ranking details
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

- [ ] **Step 2: Update commands.ts** to pass verbosity

In the `/cost` handler:
```typescript
const isVVerbose = args.includes('-vv');
const output = formatVerboseReport(report, isVVerbose ? 2 : 1);
```

---

### Task 9: Update config and data — default descriptions and semantic routing config

**Files:**
- Modify: `config/model-config.json`

- [ ] **Step 1: Update `config/model-config.json`**

Add `semanticRouting`, `semanticThreshold`, and `description` fields to all 5 rules:

```json
{
  "routing": {
    "semanticRouting": true,
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
Expected: `Valid JSON`

---

### Task 10: Update tracker — semanticMatch field in CostRecord

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

### Task 11: Integration test — full semantic routing flow

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
  { id: 'complex', priority: 100, when: { keywords: ['重构'] }, then: { model: 'deepseek-v4-pro' }, description: '涉及跨模块重构或架构设计的复杂任务' },
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

  it('keyword match → fast path (no semantic)', async () => {
    const routerResult = decide(rules, { text: '重构这个模块', recentTools: [], consecutiveToolCalls: 0 });
    expect(routerResult?.ruleId).toBe('complex');
    // Semantic not needed since fast path already matched
  });

  it('default rule + semantic match → semantic path', async () => {
    const routerResult = decide(rules, { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0 });
    expect(routerResult?.ruleId).toBe('default');

    const semanticResult = await matchSemantic('帮我排查线上bug', rules, 0.55, engine, cache);
    expect(semanticResult).not.toBeNull();

    const state = createInitialState('s1', 'flash', 'default');
    const final = arbitrate({
      text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.55,
    }, semanticResult!);
    expect(final.model).toBe('deepseek-v4-pro');
    expect(final.semanticMatch).toBeDefined();
  });

  it('default rule + no semantic match → fallback to default', async () => {
    const semanticResult = await matchSemantic('谢谢', rules, 0.85, engine, cache);
    // High threshold should filter out everything
    const state = createInitialState('s1', 'flash', 'default');
    const final = arbitrate({
      text: '谢谢', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.85,
    }, semanticResult);
    expect(final.model).toBe('deepseek-v4-flash');
    expect(final.ruleId).toBe('default');
  });
});
```

- [ ] **Step 2: Run all semantic tests**

Run:
```bash
npx vitest run __tests__/semantic/ __tests__/router-semantic.test.ts
```
Expected: All PASS

---

### Task 12: Final validation

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```
No errors.

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```
All existing tests pass. Semantic tests pass.

- [ ] **Step 3: Verify backward compatibility**

- Configs without `semanticRouting` → defaults to `true`, semantic routing works
- Configs without `description` on rules → those rules skipped in semantic matching, existing keyword behavior unchanged
- Commands `/cost`, `/cost -v`, `/cost -vv`, `/router`, `/router off`, `/router on` all respond correctly

---

## Summary

| Task | Files | Status |
|------|-------|--------|
| 1 | `package.json`, `types.ts` | - [ ] |
| 2 | `src/semantic/engine.ts`, test | - [ ] |
| 3 | `src/semantic/cache.ts`, test | - [ ] |
| 4 | `src/semantic/matcher.ts`, test | - [ ] |
| 5 | `src/core/arbitrator.ts`, test | - [ ] |
| 6 | `src/adapters/pi/index.ts` | - [ ] |
| 7 | `src/adapters/pi/commands.ts`, `index.ts` | - [ ] |
| 8 | `src/utils/report-formatter.ts` | - [ ] |
| 9 | `config/model-config.json` | - [ ] |
| 10 | `src/core/tracker.ts` | - [ ] |
| 11 | `__tests__/router-semantic.test.ts` | - [ ] |
| 12 | Final validation | - [ ] |
