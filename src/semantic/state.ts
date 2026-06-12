/**
 * Session-scoped mutable state shared between the Pi adapter (index.ts)
 * and the command handlers (commands.ts).
 *
 * Uses Map<sessionId, ...> for multi-session safety.
 * When Pi reuses the module across sessions, each session gets independent state.
 */

export interface SessionSemanticState {
  /**
   * true = semantic routing disabled for this session (by /router off or engine failure).
   * /router on resets this to false.
   */
  disabled: boolean;

  /**
   * Number of remaining turns the user's manual /model selection blocks auto-routing.
   * Decremented each turn_end. 0 = no manual override.
   */
  manualOverrideRemaining: number;
}

const sessionStates = new Map<string, SessionSemanticState>();

function getOrCreate(sessionId: string): SessionSemanticState {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, { disabled: false, manualOverrideRemaining: 0 });
  }
  return sessionStates.get(sessionId)!;
}

export function getSessionState(sessionId: string): SessionSemanticState {
  return getOrCreate(sessionId);
}

export function setSessionDisabled(sessionId: string, v: boolean): void {
  getOrCreate(sessionId).disabled = v;
}

export function isSessionDisabled(sessionId: string): boolean {
  return getOrCreate(sessionId).disabled;
}

export function setManualOverrideRemaining(sessionId: string, v: number): void {
  getOrCreate(sessionId).manualOverrideRemaining = v;
}

export function getManualOverrideRemaining(sessionId: string): number {
  return getOrCreate(sessionId).manualOverrideRemaining;
}

/** Clean up session state (call when session ends). */
export function clearSession(sessionId: string): void {
  sessionStates.delete(sessionId);
}
