import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Register 'model-router' as a single virtual provider.
 * Pi always calls this one 'model', the local proxy at 11451
 * forwards to Flash or Pro based on Router's decision.
 */
export function registerModelRouterProvider(pi: ExtensionAPI): void {
  pi.registerProvider('model-router', {
    name: 'Model Router',
    baseUrl: 'http://localhost:11451/v1',
    apiKey: 'noop',
    api: 'openai-completions',
    models: [
      {
        id: 'model-router',
        name: 'Model Router (Auto)',
        reasoning: true,             // supports both thinking/non-thinking
        input: ['text'],
        cost: {
          input: 0,                  // cost tracked by our own pricing
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        compat: {
          thinkingFormat: 'deepseek',
          supportsReasoningEffort: true,
        },
      },
    ],
  });
}
