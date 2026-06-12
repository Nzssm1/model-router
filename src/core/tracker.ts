import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CostRecord, CostBreakdown, TokenUsage, ArbitrationResult } from './types';
import { calculateCost } from '../utils/pricing';

const DEFAULT_COST_DIR = join(process.env.HOME || process.env.USERPROFILE || '~', '.model-router', 'costs');
const COST_DIR = process.env.MODEL_ROUTER_COST_DIR || DEFAULT_COST_DIR;

function ensureDir(): void {
  if (!existsSync(COST_DIR)) {
    mkdirSync(COST_DIR, { recursive: true });
  }
}

function sessionFilePath(sessionId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(COST_DIR, `${date}_${safeId}.jsonl`);
}

let turnCounter = 0;

export function resetTurnCounter(): void {
  turnCounter = 0;
}

export function recordCost(params: {
  sessionId: string;
  model: string;
  ruleId: string;
  reason: string;
  tokens: TokenUsage;
  duration: number;
  success: boolean;
  escalated: boolean;
  error?: string;
  semanticMatch?: ArbitrationResult['semanticMatch'];
}): CostRecord {
  turnCounter++;
  const cost = calculateCost(params.model, params.tokens);
  const record: CostRecord = {
    timestamp: new Date().toISOString(),
    turn: turnCounter,
    model: params.model,
    ruleId: params.ruleId,
    reason: params.reason,
    tokens: params.tokens,
    cost,
    duration: params.duration,
    success: params.success,
    escalated: params.escalated,
    error: params.error,
    semanticMatch: params.semanticMatch,
  };

  try {
    ensureDir();
    appendFileSync(sessionFilePath(params.sessionId), JSON.stringify(record) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[ModelRouter] Failed to write cost record:', e);
  }

  return record;
}

export interface CostReport {
  totalCalls: number;
  totalCost: number;
  byModel: Record<string, { calls: number; cost: number; cacheHitTokens: number; totalInputTokens: number }>;
  records: CostRecord[];
}

export function generateReport(sessionId: string, verbose: boolean = false): CostReport | null {
  const fp = sessionFilePath(sessionId);
  if (!existsSync(fp)) return null;

  try {
    const content = readFileSync(fp, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const records: CostRecord[] = lines.map(l => JSON.parse(l));
    const byModel: CostReport['byModel'] = {};
    let totalCost = 0;

    for (const r of records) {
      totalCost += r.cost.total;
      if (!byModel[r.model]) {
        byModel[r.model] = { calls: 0, cost: 0, cacheHitTokens: 0, totalInputTokens: 0 };
      }
      byModel[r.model].calls++;
      byModel[r.model].cost += r.cost.total;
      byModel[r.model].cacheHitTokens += r.tokens.cacheRead;
      byModel[r.model].totalInputTokens += r.tokens.input;
    }

    return { totalCalls: records.length, totalCost, byModel, records: verbose ? records : [] };
  } catch {
    return null;
  }
}

export function generateAggregatedReport(): CostReport {
  if (!existsSync(COST_DIR)) {
    return { totalCalls: 0, totalCost: 0, byModel: {}, records: [] };
  }
  const files = readdirSync(COST_DIR).filter(f => f.endsWith('.jsonl'));
  const allRecords: CostRecord[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(COST_DIR, file), 'utf-8');
      const records: CostRecord[] = content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      allRecords.push(...records);
    } catch { /* skip corrupt files */ }
  }

  const byModel: CostReport['byModel'] = {};
  let totalCost = 0;
  for (const r of allRecords) {
    totalCost += r.cost.total;
    if (!byModel[r.model]) {
      byModel[r.model] = { calls: 0, cost: 0, cacheHitTokens: 0, totalInputTokens: 0 };
    }
    byModel[r.model].calls++;
    byModel[r.model].cost += r.cost.total;
    byModel[r.model].cacheHitTokens += r.tokens.cacheRead;
    byModel[r.model].totalInputTokens += r.tokens.input;
  }
  return { totalCalls: allRecords.length, totalCost, byModel, records: allRecords };
}
