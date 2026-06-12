import type { CostReport } from '../core/tracker';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export function formatCostReport(report: CostReport, modelList: string[]): string {
  const lines: string[] = [];
  lines.push(SEP);
  lines.push(' 🤖 Model Router - 成本报告');
  lines.push(SEP);
  lines.push(` 总调用: ${report.totalCalls} 次    总花费: ¥${report.totalCost.toFixed(4)}`);
  lines.push(SEP);

  // Header
  lines.push(` ${'模型'.padEnd(20)} ${'调用'.padStart(5)} ${'缓存命中率'.padStart(10)} ${'花费'.padStart(10)} ${'占比'.padStart(6)}`);

  for (const model of modelList) {
    const m = report.byModel[model];
    if (!m) continue;
    const cacheRatio = m.totalInputTokens > 0 ? (m.cacheHitTokens / m.totalInputTokens * 100).toFixed(0) : '0';
    const pct = report.totalCost > 0 ? (m.cost / report.totalCost * 100).toFixed(0) : '0';
    lines.push(` ${model.padEnd(20)} ${String(m.calls).padStart(5)} ${`${cacheRatio}%`.padStart(10)} ¥${m.cost.toFixed(4).padStart(7)} ${`${pct}%`.padStart(5)}`);
  }

  // Calculate "if all-Pro" comparison
  const allProCost = estimateAllProCost(report);
  const allFlashCost = estimateAllFlashCost(report);
  lines.push(SEP);
  lines.push(' 对比参考:');
  lines.push(`   全程用 Pro:  ¥${allProCost.toFixed(4)}`);
  lines.push(`   全程用 Flash: ¥${allFlashCost.toFixed(4)}`);
  if (allProCost > 0) {
    const saved = allProCost - report.totalCost;
    const pct = (saved / allProCost * 100).toFixed(0);
    lines.push(`   实际节省 vs 全用 Pro: ¥${saved.toFixed(4)} (${pct}%)`);
  }
  lines.push(SEP);

  return lines.join('\n');
}

export function formatVerboseReport(report: CostReport): string {
  const lines: string[] = [];
  lines.push(SEP);
  lines.push(' 路由明细:');
  lines.push(` ${'时间'.padEnd(22)} ${'模型'.padEnd(18)} ${'规则'.padEnd(16)} 原因`);
  lines.push(SEP);

  for (const r of report.records) {
    const time = r.timestamp.slice(11, 19);
    const turn = r.turn !== undefined ? `#${r.turn}` : '';
    lines.push(` ${time.padEnd(22)} ${`${r.model}${turn}`.padEnd(18)} ${r.ruleId.padEnd(16)} ${r.reason}`);
  }
  lines.push(SEP);
  return lines.join('\n');
}

function estimateAllProCost(report: CostReport): number {
  let total = 0;
  for (const r of report.records) {
    const inputCost = ((r.tokens.cacheRead * 0.025) + ((r.tokens.input - r.tokens.cacheRead) * 3.0)) / 1_000_000;
    const outputCost = (r.tokens.output * 6.0) / 1_000_000;
    const cacheWriteCost = (r.tokens.cacheWrite * 0.025) / 1_000_000;
    total += Math.max(0, inputCost) + Math.max(0, outputCost) + Math.max(0, cacheWriteCost);
  }
  return total;
}

function estimateAllFlashCost(report: CostReport): number {
  let total = 0;
  for (const r of report.records) {
    const inputCost = ((r.tokens.cacheRead * 0.02) + ((r.tokens.input - r.tokens.cacheRead) * 1.0)) / 1_000_000;
    const outputCost = (r.tokens.output * 2.0) / 1_000_000;
    const cacheWriteCost = (r.tokens.cacheWrite * 0.02) / 1_000_000;
    total += Math.max(0, inputCost) + Math.max(0, outputCost) + Math.max(0, cacheWriteCost);
  }
  return total;
}
