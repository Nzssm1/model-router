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
