import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { generateReport, generateAggregatedReport } from '../../core/tracker';
import { formatCostReport, formatVerboseReport } from '../../utils/report-formatter';
import {
  getSessionState,
  setSessionDisabled,
  isSessionDisabled,
} from '../../semantic/state';
import { getEngine } from '../../semantic/engine';

let currentSessionId: string = 'default';
let retryInitFn: (() => Promise<void>) | null = null;

export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function setRetryInit(fn: () => Promise<void>): void {
  retryInitFn = fn;
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('cost', {
    description: '显示当前会话的模型路由成本报告',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const isVerbose = args.includes('--verbose') || args.includes('-v');
      const isAll = args.includes('--all') || args.includes('-a');
      const isVVerbose = args.includes('-vv');

      let report;
      if (isAll) {
        report = generateAggregatedReport();
      } else {
        report = generateReport(currentSessionId, isVerbose || isVVerbose);
      }

      if (!report || report.totalCalls === 0) {
        _ctx.ui.notify('暂无成本数据', 'info');
        return;
      }

      const modelList = Object.keys(report.byModel).sort();
      let output = formatCostReport(report, modelList);
      if ((isVerbose || isVVerbose) && report.records.length > 0) {
        output += '\n' + formatVerboseReport(report, isVVerbose ? 2 : 1);
      }

      _ctx.ui.notify(output, 'info');
    },
  });

  pi.registerCommand('router', {
    description: '控制语义路由行为。使用: /router off 关闭, /router on 开启, /router status 查看状态',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (trimmed === 'off') {
        setSessionDisabled(currentSessionId, true);
        _ctx.ui.notify('[ModelRouter] 🔇 语义路由已关闭（本会话）', 'info');
        return;
      }

      if (trimmed === 'on') {
        setSessionDisabled(currentSessionId, false);

        // Trigger engine retry if it failed before
        const eng = getEngine();
        if (!eng.ready && retryInitFn) {
          _ctx.ui.notify('[ModelRouter] 🔄 正在重新初始化语义引擎...', 'info');
          try {
            await retryInitFn();
            _ctx.ui.notify('[ModelRouter] 🔊 语义路由已开启', 'info');
          } catch {
            _ctx.ui.notify('[ModelRouter] ❌ 语义引擎初始化失败，请检查模型文件', 'error');
          }
        } else {
          _ctx.ui.notify('[ModelRouter] 🔊 语义路由已开启', 'info');
        }
        return;
      }

      // status (default)
      const ss = getSessionState(currentSessionId);
      const eng = getEngine();

      // Trigger lazy init if engine not ready yet
      if (!eng.ready && !isSessionDisabled(currentSessionId) && retryInitFn) {
        retryInitFn().catch(() => {}); // non-blocking
      }
      // Load config for threshold display
      const configPaths = [
        join(process.cwd(), 'config', 'model-config.json'),
        join(process.env.HOME || '~', '.model-router', 'config.json'),
      ];
      let threshold = 0.55;
      for (const p of configPaths) {
        if (existsSync(p)) {
          try {
            const cfg = JSON.parse(readFileSync(p, 'utf-8'));
            if (cfg?.routing?.semanticThreshold != null) {
              threshold = cfg.routing.semanticThreshold;
            }
          } catch { /* skip */ }
        }
      }

      const lines = ['━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ' 🧠 Model Router - 路由状态'];
      if (ss.manualOverrideRemaining > 0) {
        lines.push(` ⚠ 手动模型覆盖中（剩余 ${ss.manualOverrideRemaining} 轮）`);
      }
      lines.push(
        ` 语义引擎: ${eng.ready ? '已就绪' : (isSessionDisabled(currentSessionId) ? '已关闭' : '未就绪')}`,
        ` 会话状态: ${isSessionDisabled(currentSessionId) ? '已禁用' : '已启用'}`,
        ` 相似度阈值: ${threshold}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      );
      _ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
