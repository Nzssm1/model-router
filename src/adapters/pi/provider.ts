import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Override DeepSeek provider's baseUrl to point to our local proxy.
 * Pi thinks it's calling DeepSeek directly, but requests go through
 * localhost:11451 where we route to Flash or Pro based on Router decision.
 */
export function registerModelRouterProvider(pi: ExtensionAPI): void {
  pi.registerProvider('deepseek', {
    baseUrl: 'http://localhost:11451/v1',
  });
}
