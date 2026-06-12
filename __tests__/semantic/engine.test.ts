import { describe, it, expect, beforeAll } from 'vitest';
import { getEngine, ensureEngineLoaded } from '../../src/semantic/engine';

describe('SemanticEngine', () => {
  beforeAll(async () => {
    await ensureEngineLoaded();
  }, 60000); // 60s timeout for model download

  it('should be ready after load', () => {
    expect(getEngine().ready).toBe(true);
  });

  it('computes higher similarity for related texts than unrelated ones', async () => {
    const eng = getEngine();

    const a = await eng.encode('帮我重构这个模块');
    const b = await eng.encode('对现有代码进行架构调整');
    const c = await eng.encode('你好，今天天气真不错');

    expect(eng.similarity(a, b)).toBeGreaterThan(eng.similarity(a, c));
  });
});
