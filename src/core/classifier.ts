import type { ClassifierState, Verdict, EscalationConfig } from './types';

export function createInitialState(sessionId: string, initialModel: string, initialRuleId: string): ClassifierState {
  return {
    sessionId,
    currentModel: initialModel,
    currentRuleId: initialRuleId,
    consecutiveErrors: 0,
    consecutiveRetries: 0,
    totalErrors: 0,
    recentTools: [],
    lastVerdict: 'keep',
    upgradeLockRemaining: 0,
    manualOverrideRemaining: 0,
  };
}

export interface TurnResult {
  turnIndex: number;
  toolsCalled: string[];
  modelUsed: string;
  hadError: boolean;
  hadRetry: boolean;
}

/**
 * Analyze turn result and determine if model should change.
 * Runs after each turn_end.
 */
export function analyze(
  state: ClassifierState,
  turn: TurnResult,
  config: EscalationConfig,
): { newState: ClassifierState; verdict: Verdict } {
  const newState = { ...state };
  let verdict: Verdict = 'keep';

  // Update recent tools circular buffer (keep last 5)
  newState.recentTools = [
    ...state.recentTools.slice(-4),
    { turn: turn.turnIndex, tools: turn.toolsCalled, model: turn.modelUsed },
  ];

  // Track errors
  if (turn.hadError || turn.hadRetry) {
    newState.consecutiveErrors++;
    newState.totalErrors++;
    if (turn.hadRetry) newState.consecutiveRetries++;
  } else {
    newState.consecutiveErrors = 0;
    newState.consecutiveRetries = 0;
  }

  // Upgrade check: consecutive errors hit threshold
  if (config.enabled && newState.consecutiveErrors >= config.consecutiveErrorsBeforeUpgrade) {
    verdict = 'upgrade';
  }

  // Upgrade check: consecutive retries hit threshold
  if (config.enabled && verdict === 'keep' && newState.consecutiveRetries >= config.consecutiveErrorsBeforeUpgrade) {
    verdict = 'upgrade';
  }

  // Downgrade check: all recent tools are read-only and upgrade lock expired
  if (verdict === 'keep' && newState.upgradeLockRemaining <= 0 && newState.recentTools.length >= 3) {
    const last3 = newState.recentTools.slice(-3);
    const allReadOnly = last3.every(t => t.tools.every(tool => ['read', 'ls', 'grep', 'find'].includes(tool)));
    if (allReadOnly) {
      verdict = 'downgrade';
    }
  }

  // Decrement upgrade lock
  if (newState.upgradeLockRemaining > 0) {
    newState.upgradeLockRemaining--;
  }

  newState.lastVerdict = verdict;
  return { newState, verdict };
}

/**
 * Call when model actually switches.
 * Resets error counters since we're evaluating the new model fresh.
 *
 * @param upgradedToStronger - true if switching to a stronger model (sets upgrade lock)
 */
export function onModelSwitch(
  state: ClassifierState,
  newModel: string,
  newRuleId: string,
  upgradedToStronger: boolean = false,
): ClassifierState {
  return {
    ...state,
    currentModel: newModel,
    currentRuleId: newRuleId,
    consecutiveErrors: 0,
    consecutiveRetries: 0,
    upgradeLockRemaining: upgradedToStronger ? 2 : 0,
    // Don't reset lastVerdict — turn_end reads it for escalated flag, then analyze() updates it
  };
}
