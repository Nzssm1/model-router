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
  it('uses router result when classifier keeps (tool rule)', () => {
    const state = createInitialState('s1', 'flash', 'default');
    const result = arbitrate({
      text: '继续',
      recentTools: ['read'],
      consecutiveToolCalls: 3,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.ruleId).toBe('reading');
  });

  it('uses router result when classifier keeps (default rule)', () => {
    const state = createInitialState('s1', 'flash', 'default');
    const result = arbitrate({
      text: '你好',
      recentTools: [],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.ruleId).toBe('default');
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

  it('downgrade proceeds when router matches weak rule', () => {
    const state = { ...createInitialState('s1', 'pro', 'complex'), lastVerdict: 'downgrade' as const };
    const result = arbitrate({
      text: '读这个文件',
      recentTools: ['read'],
      consecutiveToolCalls: 0,
      rules,
      classifierState: state,
    });
    expect(result.model).toBe('deepseek-v4-flash');
    expect(result.reason).toContain('downgrade');
  });
});
