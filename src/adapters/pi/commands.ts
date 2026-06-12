import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { generateReport, generateAggregatedReport } from '../../core/tracker';
import { formatCostReport, formatVerboseReport } from '../../utils/report-formatter';

let currentSessionId: string = 'default';

export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand('cost', {
    description: '显示当前会话的模型路由成本报告',
    handler: async (args: string, _ctx: ExtensionCommandContext) => {
      const isVerbose = args.includes('--verbose') || args.includes('-v');
      const isAll = args.includes('--all') || args.includes('-a');

      let report;
      if (isAll) {
        report = generateAggregatedReport();
      } else {
        report = generateReport(currentSessionId, isVerbose);
      }

      if (!report || report.totalCalls === 0) {
        _ctx.ui.notify('暂无成本数据', 'info');
        return;
      }

      const modelList = Object.keys(report.byModel).sort();
      let output = formatCostReport(report, modelList);
      if (isVerbose && report.records.length > 0) {
        output += '\n' + formatVerboseReport(report);
      }

      _ctx.ui.notify(output, 'info');
    },
  });
}
