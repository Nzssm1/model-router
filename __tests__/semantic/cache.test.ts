import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../../src/semantic/engine';
import { SemanticCache } from '../../src/semantic/cache';
import type { RuleDefinition } from '../../src/core/types';

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
    // no description — should be skipped
  },
];

describe('SemanticCache', () => {
  beforeAll(async () => {
    await ensureEngineLoaded();
  }, 60000);

  it('only caches rules with non-empty description', async () => {
    const eng = getEngine();
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
