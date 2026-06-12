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
