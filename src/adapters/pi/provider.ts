import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Register DeepSeek V4 Flash and V4 Pro as a custom provider.
 * Uses OpenAI-compatible API format.
 *
 * Requires DEEPSEEK_API_KEY environment variable.
 */
export function registerDeepSeekProvider(pi: ExtensionAPI): void {
  pi.registerProvider('deepseek', {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
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
        compat: {
          thinkingFormat: 'deepseek',
        },
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
