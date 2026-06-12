import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../../src/semantic/engine';
import { SemanticCache } from '../../src/semantic/cache';
import { matchSemantic } from '../../src/semantic/matcher';
import type { RuleDefinition } from '../../src/core/types';

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
    // no description — skipped in semantic matching
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
  }, 60000);

  it('matches complex refactoring request to complex rule', async () => {
    const result = await matchSemantic('帮我重构这个项目的架构', 0.55, engine, cache);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe('complex');
    expect(result!.similarity).toBeGreaterThan(0.5);
  });

  it('matches conceptual question to simple-qa', async () => {
    // Note: short Chinese queries score ~0.30-0.45 with multilingual model
    const result = await matchSemantic('什么是闭包概念', 0.28, engine, cache);
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
