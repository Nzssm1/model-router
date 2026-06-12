import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Register DeepSeek provider whose baseUrl points to our local proxy (port 11451).
 * Pi thinks it's calling DeepSeek directly, but requests go through our proxy
 * where we route to Flash or Pro based on Router decision.
 *
 * We register a COMPLETE provider definition (not just baseUrl override)
 * because Pi's Extension API treats registerProvider as "register if not exists"
 * for built-in providers. By including the full model list, we ensure our
 * proxy-backed configuration takes effect.
 */
export function registerModelRouterProvider(pi: ExtensionAPI): void {
  pi.registerProvider('deepseek', {
    name: 'DeepSeek (Model Router)',
    baseUrl: 'http://localhost:11451/v1',
    apiKey: '$DEEPSEEK_API_KEY',
    api: 'openai-completions',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: false,
        input: ['text'],
        cost: { input: 1.0, output: 2.0, cacheRead: 0.02, cacheWrite: 0.02 },
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        compat: { thinkingFormat: 'deepseek' },
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        reasoning: true,
        input: ['text'],
        cost: { input: 3.0, output: 6.0, cacheRead: 0.025, cacheWrite: 0.025 },
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
