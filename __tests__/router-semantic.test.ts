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
  }, 60000);

  it('keyword match → fast path, no semantic involved', () => {
    const result = decide(rules, { text: '重构这个模块', recentTools: [], consecutiveToolCalls: 0 });
    expect(result?.ruleId).toBe('complex');
  });

  it('default rule + semantic match → semantic path overrides', async () => {
    const routerResult = decide(rules, { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0 });
    expect(routerResult?.ruleId).toBe('default');

    const semanticResult = await matchSemantic('排查线上问题需要分析调用链', 0.28, engine, cache);
    expect(semanticResult).not.toBeNull();

    const state = createInitialState('s1', 'flash', 'default');
    const final = arbitrate(
      { text: '帮我排查线上bug', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.55 },
      semanticResult!,
    );
    expect(final.semanticMatch).toBeDefined();
    expect(final.semanticMatch!.similarity).toBeGreaterThan(0.35);
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

  it('Classifier upgrade overrides semantic result', async () => {
    const state = { ...createInitialState('s1', 'flash', 'default'), lastVerdict: 'upgrade' as const };
    const result = arbitrate(
      { text: '谢谢', recentTools: [], consecutiveToolCalls: 0, rules, classifierState: state, semanticThreshold: 0.55 },
      { ruleId: 'reading', model: 'deepseek-v4-flash', similarity: 0.45, allScores: [] },
    );
    // Upgrade should override: flash→pro
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('upgrade');
  });

  it('Classifier downgrade changes model when semantic rule is weak', async () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate(
      { text: '读这个文件', recentTools: ['read'], consecutiveToolCalls: 3, rules, classifierState: state, semanticThreshold: 0.55 },
      // semantic matches reading (priority 60, not strong), model suggests Pro
      { ruleId: 'reading', model: 'deepseek-v4-pro', similarity: 0.62, allScores: [] },
    );
    // reading rule (priority 60 < 80) is weak → downgrade takes effect, Pro→Flash
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.reason).toContain('downgrade');
  });

  it('Classifier downgrade vetoed when semantic rule is strong', async () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate(
      { text: '重构架构', recentTools: ['read'], consecutiveToolCalls: 3, rules, classifierState: state, semanticThreshold: 0.55 },
      { ruleId: 'complex', model: 'deepseek-v4-pro', similarity: 0.74, allScores: [{ ruleId: 'complex', similarity: 0.74 }] },
    );
    // complex rule (priority 100 ≥ 80) is strong → downgrade vetoed
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.reason).toContain('否决');
  });
});
