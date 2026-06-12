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

  it('does not downgrade when upgrade lock is active', () => {
    let state = createInitialState('s1', 'pro', 'complex');
    state.upgradeLockRemaining = 2;
    const readTurn = { toolsCalled: ['read', 'ls'], hadError: false, hadRetry: false };
    const r1 = analyze(state, { ...readTurn, turnIndex: 1, modelUsed: 'pro' }, config);
    // Even though read-only, upgrade lock prevents downgrade
    expect(r1.verdict).toBe('keep');
    expect(r1.newState.upgradeLockRemaining).toBe(1);
  });
});
