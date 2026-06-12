# Semantic Router 设计文档

> 在 Model Router v0.1 基础上新增语义路由能力。

## 概述

当前 Model Router 使用关键词匹配 + 工具名匹配进行路由决策。这种方式的盲区在于：大量表述变体的任务（"排查线上 bug"、"帮我分析调用链"、"优化这段代码性能"）无法被现有规则捕获，从而落入默认兜底规则 → 使用 Flash 模型，但实际可能需要 Pro 的深度推理能力。

**语义路由（Semantic Router）** 引入 embedding 向量匹配，用自然语言描述替代关键词枚举，理解任务意图而非字面匹配。

## 核心理念

**混合策略**：快速路径（关键词/工具匹配）完全保留，语义路径仅兜底。

```
快速路径命中 → 直接输出（60-70% 调用，<1ms）
语义路径     → embedding 匹配（30-40% 调用，5-10ms）
```

快速路径不做任何改动，已验证的行为不受影响。语义路径让"沉默的默认规则"变得智能。

## 架构

```
before_agent_start
  │
  ▼
┌─────────────────────────────────────────┐
│          路由决策系统（修改后）             │
│                                          │
│  ┌────────────────────────────────┐     │
│  │  快速路径（现有逻辑）             │     │
│  │  • 关键词匹配                   │     │
│  │  • 工具名匹配                   │     │
│  │  • 否定条件                     │     │
│  └───────────┬────────────────────┘     │
│              │ 命中高优先级规则？          │
│              │ YES → 直接输出            │
│              │ NO / 默认规则              │
│              ▼                           │
│  ┌────────────────────────────────┐     │
│  │  语义路径（新增）                 │     │
│  │                                │     │
│  │  用户输入 → embedding           │     │
│  │     ↓                          │     │
│  │  cos_sim(输入, 各规则description)│     │
│  │     ↓                          │     │
│  │  过滤: score >= threshold       │     │
│  │     ↓                          │     │
│  │  按 priority 降序 → Top-1      │     │
│  └───────────┬────────────────────┘     │
│              │ 有候选？                  │
│              │ YES ──────────────────┐   │
│              │ NO ─────────────────┐ │   │
│              ▼                     ▼ ▼   │
│        语义匹配结果          快速路径结果  │
│              │              (默认规则)    │
│              └──────────┬────────┘        │
│                         ▼                 │
│                   最终路由结果             │
└─────────────────────────────────────────┘
```

**快速路径与语义路径的边界（精确定义）**：

语义路径仅在以下条件**同时满足**时触发：
1. 快速路径输出的 `ruleId === 'default'`（即只有兜底规则命中）
2. 语义引擎已就绪（`SemanticEngine.ready === true`，即模型文件已下载且 ONNX 加载成功）且 `sessionSemanticDisabled !== true`
3. 规则列表中至少有一条规则配置了 `description` 字段

除此之外的所有情况——包括快速路径命中了任何非默认规则——都不触发语义路径，直接输出快速路径结果。

> 设计理由：非默认规则命中意味着用户输入中包含了规则作者认为足够明确的信号（关键词/工具名），无需语义路径介入。语义路径只解决"快速路径什么也没识别出来"的场景。

## 规则描述设计

规则新增 `description` 字段，用自然语言描述该规则真正要捕获的任务语义区间。

### 新增类型

```typescript
// MatchCondition 不变，不新增字段
// description 放在 RuleDefinition 层级（MatchCondition 通过 or/and/not 嵌套，子条件不应有 description）

export interface RuleDefinition {
  id: string;
  priority: number;
  when: MatchCondition;
  then: { model: string; thinking?: string };
  description?: string;  // 新增：自然语言描述，用于语义匹配（规则级别属性）
}
```

### 5 条规则的默认描述

| 规则 ID | Priority | 描述 |
|---------|----------|------|
| `complex-task` | 100 | 涉及跨模块或全系统范围的代码重构、软件架构设计与评估、技术方案选型与权衡分析、需要深度因果关系推理的复杂问题排查，或对现有系统做结构性改造的设计讨论。 |
| `code-generation` | 80 | 编写新功能、实现业务逻辑、创建组件或模块、修改现有代码行为、修复缺陷、添加功能特性、优化代码性能，需要生成大量代码的任务。 |
| `file-reading` | 60 | 浏览项目文件、阅读源代码、搜索特定代码片段、查找定义或引用、了解项目结构、阅读文档或注释，以信息收集和阅读理解为主的任务。 |
| `simple-qa` | 50 | 回答概念性问题、解释技术术语或原理、总结文档内容、对比两个事物的异同、提供事实性信息，不需要生成或修改代码的问答。 |
| `default` | 0 | 其他未被上述规则覆盖的通用任务，包括闲聊、工具使用确认、简单文件操作反馈、会话管理、或意图不明确的简短指令。 |

**向后兼容**：未写 `description` 的规则不参与语义匹配（匹配流程中直接跳过），仅通过快速路径（关键词/工具）路由。用户自定义规则可选填 `description` 来启用语义匹配。

## 语义引擎

### 模型选择

使用 **paraphrase-multilingual-MiniLM-L12-v2**（ONNX 格式，~120MB），通过 `@xenova/transformers` 库加载。选择理由：

- 384 维向量，编码速度快（5-12ms/句）
- 多语言原生支持（50+ 语言），覆盖中文为主、英文为辅的混合输入
- ONNX 格式无需 Python 或系统依赖
- 社区维护活跃，MIT 许可
- 对比纯英文模型（all-MiniLM-L6-v2）：12 层 Transformer 对语义区分度更好，尤其对中文短句的意图理解更准确

### 加载策略

预下载为主 + 懒加载兜底：

```
pi install model-router
  ↓
提示: "正在准备语义路由模型 (~120MB)..."
  ↓
下载成功 → 模型存入 ~/.model-router/models/{version}/
  → Extension 启动时后台异步加载（不阻塞主流程）
  → 首次语义匹配时模型已在内存，5-10ms 延迟

下载失败 → console.warn 记录 → 不中断安装
  → 首次语义匹配时检测缺失 → 当时下载 → 提示 "正在初始化语义引擎..."
  → 后续调用正常
```

模型缓存有版本标记，升级模型时自动重下载。用户设置 `"semanticRouting": false` 则模型永不下载。

### 模块设计

**新增文件：**

```
src/semantic/
├── engine.ts     ← embedding 引擎封装
│   • loadModel()    — 加载 ONNX 模型
│   • encode(text)   — 文本 → 384 维向量
│   • similarity(a, b) — 余弦相似度
│   • dispose()      — 释放模型内存
│
├── cache.ts      ← 规则 embedding 缓存
│   • computeRuleEmbeddings(rules)  — 预计算所有 description embedding
│   • getCachedEmbeddings()         — 获取缓存向量
│   • invalidate()                  — 重置缓存
│
└── matcher.ts    ← 语义匹配逻辑
    • matchSemantic(input, rules, threshold)  — 用户输入 vs 规则集
```

### API 设计

```typescript
// engine.ts
export interface SemanticEngine {
  ready: boolean;
  loadModel(modelPath?: string): Promise<void>;
  encode(text: string): Promise<Float32Array>;
  similarity(a: Float32Array, b: Float32Array): number;
  dispose(): void;
}

// matcher.ts
export interface SemanticMatchResult {
  ruleId: string;
  model: string;
  thinking?: string;
  similarity: number;
  allScores: Array<{ ruleId: string; similarity: number }>;
}

export async function matchSemantic(
  input: string,
  rules: RuleDefinition[],
  threshold: number,
  engine: SemanticEngine
): Promise<SemanticMatchResult | null>;
```

### 匹配流程

```
matchSemantic(input, rules, threshold)
  ↓
1. 过滤：只取 `RuleDefinition.description` 非空的规则（无 description 则跳过，不参与语义匹配）
  ↓
2. 编码用户输入 → inputVec
  ↓
3. 从缓存取各规则的预计算 embedding → ruleVecs
  ↓
4. 计算余弦相似度：cos_sim(inputVec, each ruleVec)
  ↓
5. 过滤：cos_sim >= threshold
  ↓ 无候选 → 返回 null
  ↓
6. 有候选 → 按 priority 降序，同 priority 按相似度降序
  ↓
7. 返回 Top-1 + 全量分数列表（用于 -vv 展示）
```

# 决策仲裁修改

语义路径仅在快速路径输出默认规则时介入。触发条件精确定义为：

```typescript
const shouldUseSemantic = semanticResult != null
  && routerResult?.ruleId === 'default'
  && !sessionSemanticDisabled;
```

**重要：语义结果仍需经过 Classifier 的安全升级检查。** 如果 Classifier 判定 upgrade，即使语义匹配认为当前是简单任务，也应当升级到更强模型。

`ArbitrateInput` 新增 `semanticThreshold` 字段：

```typescript
export interface ArbitrateInput {
  text: string;
  recentTools: string[];
  consecutiveToolCalls: number;
  rules: RuleDefinition[];
  classifierState: ClassifierState;
  semanticThreshold?: number;  // 语义匹配阈值（由调用方从 config 传入）
}
```

`ArbitrationResult` 新增 `semanticMatch` 字段：

```typescript
export interface ArbitrationResult {
  model: string;
  ruleId: string;
  reason: string;
  thinking?: string;
  semanticMatch?: {              // 新增（仅在语义路径触发时填充）
    similarity: number;          // 匹配规则的余弦相似度
    threshold: number;           // 当前阈值
    allScores: Array<{           // 全量候选规则的相似度排名
      ruleId: string;
      similarity: number;
    }>;
  };
}
```

更新后的 `arbitrate()` 函数：

```typescript
export function arbitrate(
  input: ArbitrateInput,
  semanticResult?: SemanticMatchResult
): ArbitrationResult {
  const routerResult = decide(input.rules, { ... });

  // 语义路径：仅在快速路径命中默认规则时尝试覆盖
  if (semanticResult && routerResult?.ruleId === 'default') {
    let finalModel = semanticResult.model;
    let reason = `语义匹配 ${semanticResult.ruleId} (相似度 ${semanticResult.similarity.toFixed(2)})`;

    // ⚠ Classifier upgrade 始终覆盖语义结果（安全优先）
    if (input.classifierState.lastVerdict === 'upgrade') {
      const upgraded = getUpgradeTarget(finalModel);
      if (upgraded) {
        finalModel = upgraded;
        reason += ` + Classifier upgrade (覆盖语义结果)`;
      }
    }

    // ⚠ Classifier downgrade 仅在语义匹配到弱规则时允许
    if (input.classifierState.lastVerdict === 'downgrade') {
      const needsStrong = isStrongRule(semanticResult.ruleId, input.rules);
      if (needsStrong) {
        reason += ` (downgrade 被语义规则 ${semanticResult.ruleId} 否决)`;
      }
    }

    return {
      model: finalModel,
      ruleId: semanticResult.ruleId,
      reason,
      thinking: semanticResult.thinking,
      semanticMatch: {
        similarity: semanticResult.similarity,
        threshold: input.semanticThreshold ?? 0.55,
        allScores: semanticResult.allScores,
      },
    };
  }

  // 原有的 Classifier 仲裁逻辑（含 upgrade/downgrade 判断）
  // 与语义路径互斥：此处只有非默认规则的 Router 结果
  // ...
}
```
```

## 阈值设计

### 默认值

```
初始值: 0.55
可调范围: 0.30 - 0.85
用户配置字段: semanticThreshold
```

### 调参指南

| 阈值 | 行为 | 适用场景 |
|------|------|---------|
| 0.40-0.50 | 激进匹配，更多任务走语义路径 | 希望最大化语义路由覆盖 |
| 0.55（默认） | 平衡，滤掉噪声 | 通用推荐 |
| 0.60-0.70 | 保守匹配，只对高置信度任务上语义 | 避免误判，安全第一 |

用户可在 `config/model-config.json` 中配置：

```json
{
  "routing": {
    "semanticRouting": true,
    "semanticThreshold": 0.55,
    "rules": [...]
  }
}
```

## 用户控制

### 命令：`/router`

```
/router           → 当前路由状态概要
/router off       → 仅当前会话关闭语义路由，恢复纯关键词匹配
/router on        → 重新开启语义路由（覆盖当前会话的 off）
/router status    → 同无参数
```

### 状态展示

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🧠 Model Router - 路由状态
 语义引擎: 已开启 (模型: MiniLM-L12-multilingual)
 当前模型: deepseek-v4-pro
 命中规则: code-generation
 匹配方式: 语义 (相似度 0.74)
 阈值: 0.55
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

手动覆盖中的状态示例：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🧠 Model Router - 路由状态
 ⚠ 手动模型覆盖中（剩余 2 轮）
 语义引擎: 已开启 (模型: MiniLM-L12-multilingual)
 当前模型: deepseek-v4-flash（用户手动选择）
 命中规则: —（跳过）
 匹配方式: —（手动覆盖，3 轮后恢复自动）
 阈值: 0.55
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```
```

### `/router off` 作用域

- 仅影响当前 Pi 会话
- 下次启动 Pi 时自动恢复为 config 中的设置
- 如需永久关闭：设置 `"semanticRouting": false` 于 config

### 与 `/model` 命令的交互

`/model`（手动切换模型）的优先级高于语义路由：
- 用户执行 `/model deepseek-v4-flash` → ClassifierState.manualOverrideRemaining = 3 → 3 轮内跳过所有自动路由决策
- 语义路由在此期间**仍运行并记录匹配结果到日志**（`semanticMatch` 字段正常写入 CostRecord），但不覆盖用户的显式模型选择
- `/model auto` 或 3 轮锁定到期后，语义路由恢复自动覆盖能力
- 手动覆盖期间，`/router status` 输出中标注 "⚠ 手动模型覆盖中（剩余 2 轮）"

## 失败处理

### 分级策略

| 场景 | 行为 |
|------|------|
| 模型文件不存在/下载失败 | console.warn + 设置 `sessionSemanticDisabled=true` + 回退关键词路由。当前会话后续调用不再尝试语义匹配（避免重复 ONNX 初始化开销）。 |
| ONNX 运行时错误 | 同模型不可用处理。 |
| 所有规则相似度 < threshold | 正常回退到快速路径结果（默认规则），不设 disabled 标记。 |
| 用户主动 `/router off` | 设置 `sessionSemanticDisabled=true`，log 记录。 |

### recovery 通道

- `/router on` 重置 `sessionSemanticDisabled` 并尝试重新加载模型
- 会话结束后 disabled 标记自动清除
- 全局禁用通过 config `semanticRouting: false` → 下次启动后永久关闭

## 日志与可观测性

### `CostRecord` 新增字段

```typescript
export interface CostRecord {
  // ... existing fields ...
  semanticMatch?: {
    similarity: number;
    threshold: number;
    allScores: Array<{ ruleId: string; similarity: number }>;
  };
}
```

仅在语义路径触发时写入。关键词匹配的记录不写此字段。

### `/cost -vv` 输出

```
/cost -vv

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 路由明细:
 时间       模型          规则              原因
 10:00:21   flash         file-reading      语义 (0.82)
   └ 候选: code-gen 0.31, simple-qa 0.18, complex 0.09
 10:01:05   pro           code-generation   关键词 "实现"
 10:01:45   pro           code-generation   语义 (0.74)
   └ 候选: complex 0.61, simple-qa 0.22, reading 0.15
 10:02:30   flash         default           无语义匹配 (< 阈值 0.55)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`-v`（无第二 v）只显示规则名和匹配方式，不展开候选列表。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `config/model-config.json` | 修改 | 5 条规则各加 `description`；新增 `semanticRouting` 和 `semanticThreshold` 配置项 |
| `src/core/types.ts` | 修改 | `RuleDefinition` 加 `description?`；`ArbitrateInput` 加 `semanticThreshold?`；新增 `SemanticMatch` 接口；`ArbitrationResult` 加 `semanticMatch?`；`CostRecord` 加 `semanticMatch?` |
| `src/core/router.ts` | 修改 | 导出 `decide()` 的匹配详情（规则 ID + 是否默认规则），供语义路径判断触发条件 |
| `src/core/arbitrator.ts` | 修改 | `arbitrate()` 接受可选 `SemanticMatchResult` 参数，语义路径覆盖默认规则 |
| `src/semantic/engine.ts` | **新增** | ONNX embedding 引擎封装 |
| `src/semantic/cache.ts` | **新增** | 规则 embedding 预计算与内存缓存 |
| `src/semantic/matcher.ts` | **新增** | 语义匹配逻辑 |
| `package.json` | 修改 | 新增依赖 `@xenova/transformers` |
| `src/adapters/pi/index.ts` | 修改 | 启动时初始化语义引擎并预下载模型；`before_agent_start` 集成语义路径（含阈值解析）；`/router` 命令注册；处理 `/model` 手动覆盖与语义路由的优先级 |
| `src/adapters/pi/commands.ts` | 修改 | 新增 `/router` 命令；`/cost -vv` 支持 |
| `src/core/tracker.ts` | 修改 | `CostRecord` 新增 `semanticMatch` 字段 |
| `src/utils/report-formatter.ts` | 修改 | `formatVerboseReport` 支持 `-vv` 排名输出 |
| `__tests__/semantic/matcher.test.ts` | **新增** | 语义匹配逻辑单元测试 |
| `__tests__/semantic/cache.test.ts` | **新增** | 规则 embedding 缓存测试 |
| `__tests__/router-semantic.test.ts` | **新增** | 混合路由集成测试（快速路径 + 语义路径交互） |

## 测试策略

### 单元测试

- **matcher.test.ts**：验证相似度计算、阈值过滤、priority 排序、description 缺失规则的降级行为
- **cache.test.ts**：验证预计算正确性、缓存命中、invalidation

### 集成测试

- **router-semantic.test.ts**：模拟完整 `before_agent_start` 场景——
  - 关键词命中 → 快速路径不触发语义
  - 默认规则 → 触发语义路径并正确匹配
  - 语义路径无匹配 → 回退默认规则
  - 语义引擎不可用 → 回退快速路径 + session 禁用
  - description 缺失的规则 → 跳过语义匹配

### 边界测试

- 空输入
- 纯英文输入
- 极短输入（1-2 字）
- 极长输入（>1000 字）
- 所有规则都未过阈值
- ONNX 模型损坏/缺失
- 阈值被设为 0 或 1

## 非功能需求

- 快速路径延迟：与现有实现一致（<1ms），零退化
- 语义路径延迟：5-10ms（首次调用含模型已预加载）
- 包体积增长：约 120MB（模型文件），仅在使用语义路由时下载
- 内存增长：模型加载后约 180-250MB 常驻（以实际 Benchmark 为准；含 ONNX Runtime WASM、tokenizer 及运行时张量）
- 任一组件崩溃不影响 Pi Agent 主流程（延续现有错误处理原则）
- 向后兼容：不写 `description` 的规则行为与 v0.1 完全一致

## 未来扩展

- **用户反馈信号**：语义路由正确/不正确的实时反馈 → 调整阈值或规则描述
- **描述词优化建议**：分析 false positive/negative 日志 → 自动建议调整描述文案
- **多语言描述**：规则 description 支持多语言版本（中/英/日），根据输入语言自动选择
- **本地微调**：从历史成功/失败记录中微调 embedding 权重（长期目标）
