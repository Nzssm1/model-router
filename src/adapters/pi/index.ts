import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerDeepSeekProvider } from './provider';
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
  if (config) return config!;
  const configPaths = [
    join(process.cwd(), 'config', 'model-config.json'),
    join(process.env.HOME || '~', '.model-router', 'config.json'),
  ];
  for (const p of configPaths) {
    if (existsSync(p)) {
      try {
        config = JSON.parse(readFileSync(p, 'utf-8'));
        return config!;
      } catch { /* try next */ }
    }
  }
  // Default config
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
  return config!;
}

export default function (pi: ExtensionAPI) {
  // Register DeepSeek provider
  registerDeepSeekProvider(pi);

  // Load pricing data (compatible path resolution for Node <20.11)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pricingPath = join(__dirname, '..', '..', '..', 'pricing', 'pricing.json');
  loadPricing(pricingPath);

  // Load routing config
  const cfg = loadConfig();

  // Register commands
  registerCommands(pi);

  // ─── before_agent_start: analyze input and set model ───
  pi.on('before_agent_start', async (event, ctx) => {
    const text = event.prompt;
    if (!text) return;

    // Initialize classifier state on first run
    if (!classifierState) {
      sessionId = ctx.sessionManager.getSessionFile()?.split('/').pop()?.replace('.jsonl', '') || `session-${Date.now()}`;
      setSessionId(sessionId);
      resetTurnCounter();
      classifierState = createInitialState(sessionId, currentModel, 'default');
    }

    // Build context for router
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

    // Switch model if needed (via /model command queued as followUp)
    if (result.model !== currentModel) {
      const oldModel = currentModel;
      currentModel = result.model;
      const upgradedToStronger = result.model === 'deepseek-v4-pro' && oldModel === 'deepseek-v4-flash';
      classifierState = onModelSwitch(classifierState, result.model, result.ruleId, upgradedToStronger);
      // Queue /model switch command — executes after current turn completes
      pi.sendUserMessage(`/model deepseek/${result.model}`, { deliverAs: 'followUp' });
    }
  });

  // ─── turn_end: update classifier state and record costs ───
  pi.on('turn_end', async (event, ctx) => {
    if (!classifierState) return;

    const message = event.message as any;
    const usage = message?.usage;
    const hadError = message?.stopReason === 'error';
    const hadRetry = false;

    const c = loadConfig();

    if (usage) {
      const escalated = classifierState.lastVerdict === 'upgrade';
      recordCost({
        sessionId,
        model: currentModel,
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

    const turnTools = event.toolResults?.map(r => r.toolName) || [];
    const { newState, verdict } = analyze(classifierState, {
      turnIndex: event.turnIndex,
      toolsCalled: turnTools,
      modelUsed: currentModel,
      hadError,
      hadRetry,
    }, c.routing.escalation);
    classifierState = newState;
  });

  // ─── message_end: capture per-message usage ───
  pi.on('message_end', async (event, _ctx) => {
    if ((event.message as any).usage && (event.message as any).model) {
      // Usage data captured in turn_end already
    }
  });
}
