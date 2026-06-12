import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createInitialState, analyze, onModelSwitch } from '../../core/classifier';
import { arbitrate } from '../../core/arbitrator';
import { recordCost, resetTurnCounter } from '../../core/tracker';
import { loadPricing } from '../../utils/pricing';
import type { RouterConfig, ClassifierState } from '../../core/types';
import { registerCommands, setSessionId } from './commands';

let config: RouterConfig | null = null;
let classifierState: ClassifierState | null = null;
let sessionId: string = 'default';
let currentModel: string = 'deepseek-v4-flash';

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
    },
  };
  return config;
}

function resolveSessionId(ctx: any): string {
  const raw = ctx?.sessionManager?.getSessionFile?.();
  return raw?.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;
}

export default function (pi: ExtensionAPI) {
  // Load pricing data
  loadPricing();

  // Register commands
  registerCommands(pi);

  // ─── before_agent_start: analyze input and switch model ───
  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // Detect session change — Pi may reuse the module across sessions
    const newSessionId = resolveSessionId(ctx);
    if (newSessionId !== sessionId || !classifierState) {
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

    const result = arbitrate({
      text,
      recentTools,
      consecutiveToolCalls,
      rules: cfg.routing.rules,
      classifierState,
    });

    console.log(`[ModelRouter] 📋 Router: rule="${result.ruleId}" model="${result.model}" verdict="${classifierState.lastVerdict}" current="${currentModel}"`);

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

  // ─── turn_end: update classifier state and record costs ───
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
      });
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
  });
}
