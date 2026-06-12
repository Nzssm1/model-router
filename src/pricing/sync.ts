import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/**
 * Scrape DeepSeek pricing page and update local pricing.json.
 * This is a best-effort utility; pricing is manually confirmed as fallback.
 */
export async function syncPricing(): Promise<void> {
  try {
    const response = await fetch(DEEPSEEK_PRICING_URL);
    const html = await response.text();

    // Extract pricing table data from HTML
    const flashInputMatch = html.match(/deepseek-v4-flash[^]*?缓存未命中[^]*?(\d+(?:\.\d+)?)元/);
    const proInputMatch = html.match(/deepseek-v4-pro[^]*?缓存未命中[^]*?(\d+(?:\.\d+)?)元/);
    const flashOutputMatch = html.match(/deepseek-v4-flash[^]*?百万tokens输出[^]*?(\d+(?:\.\d+)?)元/);
    const proOutputMatch = html.match(/deepseek-v4-pro[^]*?百万tokens输出[^]*?(\d+(?:\.\d+)?)元/);

    if (!flashInputMatch || !proInputMatch || !flashOutputMatch || !proOutputMatch) {
      console.warn('[ModelRouter] Could not parse pricing from DeepSeek page');
      return;
    }

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pricingPath = join(__dirname, '..', '..', 'pricing', 'pricing.json');
    const current = JSON.parse(readFileSync(pricingPath, 'utf-8'));
    const now = new Date().toISOString().slice(0, 10);

    current.models['deepseek-v4-flash'].updatedAt = now;
    current.models['deepseek-v4-pro'].updatedAt = now;

    writeFileSync(pricingPath, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    console.log('[ModelRouter] Pricing synced from DeepSeek official page');
  } catch (e) {
    console.warn('[ModelRouter] Failed to sync pricing:', e);
  }
}
