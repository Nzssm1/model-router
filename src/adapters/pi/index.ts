import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createInitialState, analyze, onModelSwitch } from '../../core/classifier';
import { arbitrate } from '../../core/arbitrator';
import { recordCost, resetTurnCounter } from '../../core/tracker';
import { loadPricing } from '../../utils/pricing';
import type { RouterConfig, ClassifierState, ArbitrationResult } from '../../core/types';
import { registerCommands, setSessionId, setRetryInit } from './commands';
import { getEngine, ensureEngineLoaded } from '../../semantic/engine';
import { SemanticCache } from '../../semantic/cache';
import { matchSemantic } from '../../semantic/matcher';
import {
  getSessionState,
  setSessionDisabled,
  isSessionDisabled,
  setManualOverrideRemaining,
  clearSession,
} from '../../semantic/state';

let config: RouterConfig | null = null;
let classifierState: ClassifierState | null = null;
let sessionId: string = 'default';
let currentModel: string = 'deepseek-v4-flash';

// Semantic engine singletons
const semanticEngine = getEngine();
let semanticCache: SemanticCache | null = null;
let engineInitAttempted = false;
let lastArbitrationResult: ArbitrationResult | null = null;

function loadConfig(): RouterConfig {
  if (config) return config;
  const configPaths = [
    join(process.cwd(), 'config', 'model-config.json'),
    join(process.env.HOME || '~', '.model-router', 'config.json'),
  ];
  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        config = JSON.parse(readFileSync(p, 'utf-8')) as RouterConfig;
        return config;
      } catch { /* try next */ }
    }
  }
  config = {
    routing: {
      rules: [
        { id: 'complex', priority: 100, when: { keywords: ['重构', 'refactor', 'architecture'] }, then: { model: 'deepseek-v4-pro', thinking: 'high' } },
        { id: 'code-gen', priority: 80, when: { keywords: ['实现', 'implement', 'create'] }, then: { model: 'deepseek-v4-pro', thinking: 'medium' } },
        { id: 'reading', priority: 60, when: { toolsUsed: ['read', 'ls', 'grep'] }, then: { model: 'deepseek-v4-flash' } },
        { id: 'default', priority: 0, when: {}, then: { model: 'deepseek-v4-flash' } },
      ],
      escalation: { enabled: true, consecutiveErrorsBeforeUpgrade: 2 },
      semanticRouting: false,
      semanticThreshold: 0.55,
    },
  };
  return config;
}

function resolveSessionId(ctx: any): string {
  const raw = ctx?.sessionManager?.getSessionFile?.();
  return raw?.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;
}

// ─── Semantic engine init (lazy, retryable) ───

async function initSemanticEngine(): Promise<void> {
  if (semanticEngine.ready) return;
  engineInitAttempted = true;
  try {
    await ensureEngineLoaded();
    semanticCache = new SemanticCache(semanticEngine);
    const cfg = loadConfig();
    await semanticCache.compute(cfg.routing.rules);
    console.log('[ModelRouter] 🧠 Semantic engine ready');
  } catch (e) {
    console.warn('[ModelRouter] ⚠️ Semantic engine init failed:', e);
  }
}

async function retryInit(): Promise<void> {
  engineInitAttempted = false;
  await initSemanticEngine();
}

export default function (pi: ExtensionAPI) {
  // Load pricing data
  loadPricing();

  // Register commands
  registerCommands(pi);

  // Wire retryInit so /router on can trigger engine re-initialization
  setRetryInit(retryInit);

  // ─── before_agent_start: analyze input and switch model ───
  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // Detect session change — Pi may reuse the module across sessions
    const newSessionId = resolveSessionId(ctx);
    if (newSessionId !== sessionId || !classifierState) {
      clearSession(sessionId);
      console.log(`[ModelRouter] 🆕 session: ${sessionId} → ${newSessionId}${!classifierState ? ' (cold start)' : ''}`);
      sessionId = newSessionId;
      setSessionId(sessionId);
      resetTurnCounter();
      currentModel = 'deepseek-v4-flash';
      classifierState = createInitialState(sessionId, currentModel, 'default');
    }

    const cfg = loadConfig();
    const recentTools = classifierState.recentTools.flatMap(t => t.tools);
    const consecutiveToolCalls = (() => {
      const last = classifierState.recentTools.at(-1);
      if (!last || last.tools.length === 0) return 0;
      const lastTool = last.tools[last.tools.length - 1];
      let count = 1;
      for (let i = classifierState.recentTools.length - 2; i >= 0; i--) {
        const t = classifierState.recentTools[i];
        if (t.tools.includes(lastTool)) count++;
        else break;
      }
      return count;
    })();

    // Determine semantic eligibility
    const semanticEnabled = cfg.routing.semanticRouting === true; // opt-in!
    const threshold = cfg.routing.semanticThreshold ?? 0.55;
    const sessionState = getSessionState(sessionId);
    const hasManualOverride = sessionState.manualOverrideRemaining > 0;

    // Fast path
    const routerResult = (await import('../../core/router')).decide(
      cfg.routing.rules,
      { text, recentTools, consecutiveToolCalls },
    );

    let semanticResult = null;

    // Semantic path: only when fast path falls through to default rule
    if (
      routerResult?.ruleId === 'default'
      && semanticEnabled
      && !isSessionDisabled(sessionId)
      && !hasManualOverride
    ) {
      // Lazy-init engine
      if (!engineInitAttempted) {
        await initSemanticEngine();
      }

      if (semanticEngine.ready && semanticCache) {
        try {
          semanticResult = await matchSemantic(text, threshold, semanticEngine, semanticCache);
        } catch (e) {
          console.warn('[ModelRouter] ⚠️ Semantic match failed, disabling for session:', e);
          setSessionDisabled(sessionId, true);
        }
      }
    }

    const result = arbitrate(
      {
        text,
        recentTools,
        consecutiveToolCalls,
        rules: cfg.routing.rules,
        classifierState: classifierState!,
        semanticThreshold: threshold,
      },
      semanticResult ?? undefined,
    );

    console.log(
      `[ModelRouter] 📋 Router: rule="${result.ruleId}" model="${result.model}" verdict="${classifierState.lastVerdict}" current="${currentModel}"`,
    );
    if (semanticResult) {
      console.log(`[ModelRouter] 🧠 Semantic: "${semanticResult.ruleId}" (${semanticResult.similarity.toFixed(2)})`);
    }

    // Store for turn_end to access semanticMatch
    lastArbitrationResult = result;

    // Switch model using the official pi.setModel() API
    if (result.model !== currentModel) {
      const targetModel = ctx.modelRegistry.find('deepseek', result.model);
      if (targetModel) {
        console.log(`[ModelRouter] 🔄 Switching: ${currentModel} → ${result.model} (rule: ${result.ruleId})`);
        const ok = await pi.setModel(targetModel);
        if (ok) {
          const oldModel = currentModel;
          currentModel = result.model;
          const upgradedToStronger = result.model === 'deepseek-v4-pro' && oldModel === 'deepseek-v4-flash';
          classifierState = onModelSwitch(classifierState, result.model, result.ruleId, upgradedToStronger);
          console.log(`[ModelRouter] ✅ Model switched to ${result.model}`);
        } else {
          console.warn(`[ModelRouter] ⚠️ setModel(${result.model}) returned false — no API key?`);
        }
      } else {
        console.warn(`[ModelRouter] ⚠️ Model "${result.model}" not found in registry`);
      }
    }
  });

  // ─── turn_end: update classifier state, record costs, decrement manual override ───
  pi.on('turn_end', async (event, ctx) => {
    if (!classifierState) return;

    const message = event.message as any;
    const usage = message?.usage;
    const hadError = message?.stopReason === 'error';

    const c = loadConfig();

    if (usage) {
      const actualModel = message?.model || currentModel;
      const escalated = classifierState.lastVerdict === 'upgrade';
      recordCost({
        sessionId,
        model: actualModel,
        ruleId: classifierState.currentRuleId,
        reason: `Turn ${event.turnIndex}`,
        tokens: {
          input: usage.input || 0,
          output: usage.output || 0,
          cacheRead: usage.cacheRead || 0,
          cacheWrite: usage.cacheWrite || 0,
        },
        duration: message?.timestamp ? Date.now() - message.timestamp : 0,
        success: !hadError,
        escalated,
        error: hadError ? message.errorMessage : undefined,
        semanticMatch: lastArbitrationResult?.semanticMatch,
      });
    }

    // Decrement manual override counter
    const ss = getSessionState(sessionId);
    if (ss.manualOverrideRemaining > 0) {
      ss.manualOverrideRemaining--;
    }

    const turnTools = event.toolResults?.map((r: any) => r.toolName) || [];
    const { newState, verdict } = analyze(classifierState, {
      turnIndex: event.turnIndex,
      toolsCalled: turnTools,
      modelUsed: currentModel,
      hadError,
      hadRetry: false,
    }, c.routing.escalation);
    classifierState = newState;

    // Note: If model-config.json is modified during a session (e.g., rule descriptions changed),
    // the semantic cache won't auto-refresh. Run /router off then /router on to recompute
    // embeddings (initSemanticEngine → semanticCache.compute). This is acceptable for v1.
  });
}
