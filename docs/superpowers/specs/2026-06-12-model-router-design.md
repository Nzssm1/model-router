# Model Router 设计文档

## 概述

Model Router 是一个开源的智能模型路由系统，能够根据当前任务的类型和复杂度，自动在多个大语言模型之间切换，以在保证输出质量的前提下最大化降低成本。

**核心理念：** 简单任务用便宜模型，复杂任务用强模型，执行失败自动升级。

## 目标

- 先实现 Pi Agent 适配，后续推广到 Claude Code、Cursor 等框架
- 在 Pi Agent 中通过 Extension 机制实现自动模型切换
- 内置 DeepSeek V4 Flash / Pro 的定价数据，支持人民币结算，缓存全生命周期计费
- 提供成本追踪和按需报表功能
- 作为 Pi Package 发布，用户通过 `pi install` 一键安装

## 架构

### 整体结构

```
用户输入
  │
  ▼
┌──────────────────────────────────────────────────────┐
│                   路由决策系统                           │
│                                                       │
│  ┌─────────────────────────────┐                      │
│  │   Router (规则引擎)          │  ← per-turn, stateless │
│  │   • 关键词匹配              │                      │
│  │   • 工具模式匹配            │                      │
│  │   • 输出: 模型 ID + 规则 ID │                      │
│  └──────────┬──────────────────┘                      │
│             │ Router 输出是"初始建议"                  │
│             ▼                                         │
│  ┌─────────────────────────────┐                      │
│  │   Classifier (运行时分析器)   │  ← 跨-turn, stateful │
│  │   • 跨 Turn 状态追踪        │                      │
│  │   • 错误/重试计数           │                      │
│  │   • 输出: upgrade /         │                      │
│  │           downgrade / keep  │                      │
│  └──────────┬──────────────────┘                      │
│             │ Classifier 可覆盖或采纳 Router 的建议    │
│             ▼                                         │
│  ┌─────────────────────────────┐                      │
│  │   决策仲裁器                 │                      │
│  │   • 合并 Router + Classifier│                      │
│  │   • 最终输出: 模型 ID       │                      │
│  │   • 附带: 规则 ID + 原因    │                      │
│  └─────────────────────────────┘                      │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────┐
│          Adapter 层                   │
│  ┌──────────────────────────┐        │
│  │   Pi Extension Adapter    │        │
│  │   (index.ts)             │        │
│  │                           │        │
│  │  before_agent_start →     │        │
│  │    session.setModel()     │        │
│  │                           │        │
│  │  turn_end →               │        │
│  │    反馈给 Classifier      │        │
│  └──────────────────────────┘        │
└──────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────┐
│         追踪与报表层                   │
│  ┌──────────────┐ ┌────────────────┐  │
│  │ 成本记录器     │ │ 定价库          │  │
│  │ (per-session  │ │ (内置定价数据)   │  │
│  │  JSONL)      │ │                │  │
│  └──────┬───────┘ └───────┬────────┘  │
│         └───────┬─────────┘           │
│                 ▼                     │
│  /cost → 聚合 per-session 文件 → 报表 │
│  /cost --verbose → 显示每条路由决策   │
└──────────────────────────────────────┘
```

### 目录结构

```
model-router/
├── README.md
├── LICENSE (MIT)
├── package.json              ← Pi Package 声明
│   {
│     "name": "model-router",
│     "pi": {
│       "extensions": ["./src/adapters/pi/index.ts"]
│     }
│   }
│
├── config/
│   └── model-config.json     ← 用户可编辑的路由规则（安装后可自定义）
│
├── data/
│   └── pricing.json          ← 内置定价数据（随包发布，用户不改，不可手动编辑）
│
├── src/
│   ├── core/
│   │   ├── types.ts          ← 核心类型定义
│   │   ├── router.ts         ← 规则引擎（stateless, per-turn）
│   │   ├── classifier.ts     ← 运行时分析器（stateful, 跨-turn）
│   │   ├── arbitrator.ts     ← 决策仲裁器（合并 router + classifier）
│   │   └── tracker.ts        ← 成本追踪器（per-session JSONL）
│   │
│   ├── pricing/
│   │   └── sync.ts           ← 从官方定价页自动拉取更新（代码目录，与 data/pricing.json 数据分离）
│   │
│   ├── adapters/
│   │   └── pi/
│   │       ├── index.ts      ← Extension 主入口
│   │       ├── provider.ts   ← 注册 DeepSeek provider
│   │       ├── commands.ts   ← /cost, /cost --verbose 等命令
│   │       └── cost-ui.ts    ← 报表渲染
│   │
│   └── utils/
│       ├── pricing.ts        ← 缓存全生命周期定价计算（含 cacheWrite）
│       └── report-formatter.ts
│
└── examples/
    └── pi-quickstart.md
```

## 组件设计

### 1. 路由规则引擎 — router.ts (stateless, per-turn)

纯函数式规则匹配器。给定用户输入和上一轮的工具调用记录，按优先级匹配规则。

**规则字段：**
- `id` — 规则唯一标识
- `priority` — 优先级（数值越大越优先）
- `when` — 匹配条件
- `then` — 决策结果

**匹配条件类型（完整版，含否定条件）：**

```typescript
interface MatchCondition {
  // 正向匹配
  keywords?: string[];                    // 输入文本包含任意关键词之一即匹配
  notKeywords?: string[];                 // 输入文本不包含所有指定关键词
  toolsUsed?: string[];                   // 上一轮使用了这些工具
  notToolsUsed?: string[];                // 上一轮没有使用这些工具
  consecutive?: number;                   // 连续调用同一工具的次数 ≥ 此值
  inputLength?: { min?: number; max?: number };  // 用户输入长度区间

  // 逻辑组合
  or?: MatchCondition[];                  // 任一子条件匹配即匹配
  and?: MatchCondition[];                 // 所有子条件均匹配才匹配
  not?: MatchCondition;                   // 子条件不匹配才匹配
}
```

**兜底规则：** 优先级最低的默认规则，`when` 为空对象时无条件匹配。

### 2. 运行时上下文分析器 — classifier.ts (stateful, 跨-turn)

在 Pi Extension 生命周期内维护状态，每次 `turn_end` 后更新。

**维护的状态：**

```typescript
interface ClassifierState {
  sessionId: string;
  currentModel: string;
  currentRuleId: string;

  // 错误/重试追踪
  consecutiveErrors: number;              // 当前模型连续错误次数
  consecutiveRetries: number;             // 当前 Turn 重试次数
  totalErrors: number;                    // 会话累计错误数

  // 工具使用模式
  recentTools: Array<{
    turn: number;
    tools: string[];
    model: string;
  }>;

  // 最新一次的升级/降级判定
  lastVerdict: "upgrade" | "downgrade" | "keep";

  // 升级锁：upgrade 生效后 N 轮内不再降级
  upgradeLockRemaining: number;

  // 用户手动覆盖锁：/model 手动选择模型后 N 轮内不自动切换
  manualOverrideRemaining: number;
}
```

**分析逻辑：**

```
turn_end → 更新 ClassifierState
  │
  ├─ consecutiveErrors ≥ consecutiveErrorsBeforeUpgrade → upgrade（当前模型连续出错）
  ├─ consecutiveRetries ≥ consecutiveErrorsBeforeUpgrade → upgrade（模型不稳定）
  │
  ├─ recentTools 全是 read/ls/grep 且连续 3 轮 → downgrade（任务变简单）
  │  但 upgradeLockRemaining > 0 时不降级
  │
  └─ 否则 → keep
```

### 3. 决策仲裁器 — arbitrator.ts

合并 Router 和 Classifier 的输出，产生最终决策。

**仲裁规则：**

```
before_agent_start 时:
  ┌────────────────────────────────────────────────────┐
  │                                                     │
  │  Router 输出: 规则 A → Flash                         │
  │  Classifier: upgrade                                │
  │  → 仲裁结果: Pro (Classifer 的 upgrade 覆盖 Router)  │
  │                                                     │
  │  Router 输出: 规则 B → Pro                          │
  │  Classifier: downgrade                              │
  │  → 仲裁结果: Pro (downgrade 被子规则否决，因为       │
  │     当前用户输入明确命中了需要 Pro 的规则)           │
  │                                                     │
  │  Router 输出: 规则 C → Flash                        │
  │  Classifier: keep                                   │
  │  → 仲裁结果: Flash (两者一致)                       │
  │                                                     │
  │  Router 输出: 默认规则 → Flash                      │
  │  Classifier: downgrade (但当前是 Flash, 已最便宜)   │
  │  → 仲裁结果: Flash (已无下可降)                     │
  │                                                     │
  └────────────────────────────────────────────────────┘
```

**核心原则：**
- **Upgrade 始终覆盖 Router** — 即使本轮关键词匹配到"简单任务"，只要 Classifier 认为需要升级，就升级。这是安全优先的策略。
- **Downgrade 可以被 Router 否决** — 如果本轮用户输入明确命中了需要强模型的关键词（如"重构"），即使 Classifier 建议降级也不采纳。这是对用户意图的尊重。
- **无升级或降级理由时，保持当前模型不变** — 不产生不必要的切换。

### 4. Pi Extension Adapter

利用 Pi Extension 的以下事件钩子：

| 事件 | 用途 |
|------|------|
| `resources_discover` | 注册 DeepSeek Provider 和模型 |
| `before_agent_start` | 调用 Router → Arbitrator → `session.setModel()` |
| `turn_end` | 更新 Classifier 状态，记录成本 |
| `message_end` | 捕获 API 用量数据（tokens、缓存指标） |

**模型切换时机：** 仅在 `before_agent_start`（新一轮开始前）调用 `session.setModel()`。不在 Turn 中间切换。

**切换失败处理：** 如果 `session.setModel()` 抛出异常（模型不可用/provider 未注册），则回退到当前模型，记录错误到成本追踪（`success: false`），并在下个 Turn 尝试降级到可用模型。

### 5. 成本追踪器 — tracker.ts

**存储位置：** `~/.model-router/costs/<session-id>.jsonl`

- 每个 Pi session 对应一个独立 JSONL 文件
- 文件命名：`YYYY-MM-DD_<session-id>.jsonl`
- 多 session 之间无并发写入冲突
- 支持用户通过环境变量 `MODEL_ROUTER_COST_DIR` 自定义路径

**记录字段：**

```typescript
interface CostRecord {
  timestamp: string;
  turn?: number;              // Turn 序号，方便调试
  model: string;
  ruleId: string;              // 命中的规则 ID（或 "manual"）
  reason: string;              // 仲裁原因说明
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: {
    input: number;             // ¥, 含 cacheRead 折扣
    output: number;            // ¥
    cacheWrite: number;        // ¥, 单独列示
    total: number;             // ¥, input + output + cacheWrite
  };
  duration: number;            // 毫秒
  success: boolean;
  escalated: boolean;
  error?: string;              // 失败时的错误信息
}
```

**写入行为：** 异步 Append，写入失败时 silently drop（不阻塞主流程），通过可选的日志通道报告。

### 6. 定价库 — pricing.json + 计算逻辑

内置 DeepSeek V4 全系模型定价数据（人民币）：

| 模型 | 输入(缓存命中) | 输入(缓存未命中) | 输出 | cacheWrite |
|------|:-:|:-:|:-:|:-:|
| deepseek-v4-flash | ¥0.02/百万tokens | ¥1.00/百万tokens | ¥2.00/百万tokens | ¥0.02/百万tokens |
| deepseek-v4-pro | ¥0.025/百万tokens | ¥3.00/百万tokens | ¥6.00/百万tokens | ¥0.025/百万tokens |

**缓存全生命周期定价计算：**

```
输入费用 = (cacheRead × 缓存命中价 + (input - cacheRead) × 缓存未命中价) / 1,000,000
输出费用 = output × 输出价 / 1,000,000
cacheWrite费用 = cacheWriteTokens × cacheWrite单价 / 1,000,000
总费用 = 输入费用 + 输出费用 + cacheWrite费用
```

**定价文件损坏/缺失时的降级行为：**
- 如果 `pricing.json` 无法加载（损坏、格式错误），使用硬编码的内置默认定价
- 如果 `pricing.json` 完全不存在，也使用硬编码默认值
- 打印一条警告但不中断主流程

## 数据流

### 正常流程

```
用户: "帮我看看这个项目有什么问题"

1. before_agent_start:
   - Router 分析用户输入 → 关键词"看看" → "file-reading" 规则 → deepseek-v4-flash
   - Classifier: keep（无历史状态）
   - Arbitrator: flash，原因: "规则 file-reading 匹配，Classifier keep"
   - session.setModel(deepseek-v4-flash)

2. Turn 1 (Flash):
   - ls → read 多个文件 → 返回分析结果
   - 用户补充: "再帮我把这个问题改了"

3. turn_end:
   - Classifier: keep（无错误，不触发升级）
   - 记录成本: Flash, tokens: ..., cost: ¥0.02

4. before_agent_start (下一轮):
   - Router 分析"再帮我把这个问题改了" → 关键词"改"匹配 "code-generation" 规则 → deepseek-v4-pro
   - Classifier: keep
   - Arbitrator: Pro，原因: "规则 code-generation 匹配，Classifier keep"
   - 设置 upgradeLockRemaining = 2（切到强模型后锁定，防止过早降级）
   - session.setModel(deepseek-v4-pro)

5. Turn 2 (Pro):
   - 深度分析代码 → 生成修复方案 → write 写入

6. turn_end:
   - 记录成本: Pro, tokens: ..., cost: ¥0.18
   - Classifier: upgradeLockRemaining -= 1 → 还剩 1
   - 分析 Turn 2 工具: write → 仍然需要强模型 → keep

7. Turn 3 (Pro):
   - 继续完成修复 → 更多 write → ls 验证

8. turn_end:
   - upgradeLockRemaining = 0 → 解锁
   - 分析 Turn 3 工具: ls, read, grep → 验证阶段 → downgrade

9. before_agent_start (下一轮):
   - Router 分析用户输入 → 默认规则 → deepseek-v4-flash
   - Classifier: downgrade
   - Arbitrator: flash，原因: "默认规则 + Classifier downgrade，未命中需否决的规则"
   - session.setModel(deepseek-v4-flash)
```

### 升级兜底流程

```
1. before_agent_start: 
   - Router: 无关键词匹配 → 默认规则 → deepseek-v4-flash
   - Classifier: keep
   - Arbitrator → flash

2. Turn 1 (Flash): 请求失败 / 返回空 / 质量差导致 retry
   - Classifier: consecutiveErrors++

3. Turn 1 (Flash retry): 再次失败
   - Classifier: consecutiveErrors ≥ consecutiveErrorsBeforeUpgrade → upgrade

4. before_agent_start:
   - Classifier: upgrade
   - Arbitrator → Pro（upgrade 覆盖 Router 的 flash 建议）

5. Turn 2 (Pro): 成功执行
   - 记录 escalated=true
   - Classifier: consecutiveErrors = 0
```

## 错误处理

| 场景 | 行为 |
|------|------|
| `session.setModel()` 失败 | 回退到当前模型，记录 `success: false`，下轮尝试降级 |
| pricing.json 损坏/缺失 | 使用硬编码内置默认定价，打印警告 |
| JSONL 写入失败 | silently drop，不阻塞主流程，通过 console.warn 报告 |
| Classifier 状态异常 | 重置状态（consecutiveErrors=0, upgradeLock=0），相当于冷启动 |
| 配置文件中规则格式错误 | 跳过该规则，打印解析错误警告，继续加载其他规则 |

所有错误处理遵循同一条原则：**不影响用户使用 Agent 的主流程**。Model Router 的任何组件崩溃，Pi Agent 本身不受影响。

## Escalation 升级策略

简化后的状态机，避免 `afterRetries` 和 `maxRetries` 的混淆：

```
                ┌──────────────────────┐
                │  当前模型运行中       │
                │  (任意模型)           │
                └──────┬───────────────┘
                       │
          ┌────────────┼────────────────────────┐
          ▼            ▼                        ▼
     连续错误 x1   连续错误 ≥ x2            模型已切换
          │            │                        │
          ▼            ▼                        ▼
     继续观察      升级到 Pro              consecutiveErrors
     (不升级)       (consecutiveErrors      归零重新计数
                   归零)                     Pro 再出错时
                                           从 0 开始计数
```

配置中只暴露两个参数：

```jsonc
"escalation": {
  "enabled": true,
  "consecutiveErrorsBeforeUpgrade": 2   // 连续错误次数达到此值后升级
}
```

- 当前 MVP 只有两个模型（Flash → Pro），升级链是单步的，不需要 `levels` 数组
- `consecutiveErrorsBeforeUpgrade: 2` 表示连续 2 次失败后升级
- 模型切换时 `consecutiveErrors` 归零重新计数（换模型后重新评估稳定性）
- 升级后如果新模型仍然连续出错达到阈值，记录日志 "已达最高级，无法继续升级"，保持当前模型
- 未来扩展多模型时再引入 `levels` 链条

## 命令设计

| 命令 | 功能 | 可用范围 |
|------|------|---------|
| `/cost` | 输出当前会话的成本报告 | 任何时候 |
| `/cost --verbose` （或 `/cost -v`） | 输出带路由明细的成本报告（每条记录含规则 ID 和仲裁原因） | 任何时候 |
| `/cost --all` （或 `/cost -a`） | 输出所有会话的成本报告 | 任何时候 |
| `/cost -vv` | 语义路由生效时额外展示各候选规则的相似度排名（仅限 Semantic Router 扩展） | 任何时候 |
| `/model` | 查看/手动切换模型（Pi 内置，Model Router 尊重手动选择，临时覆盖自动路由） | 任何时候 |

`/cost` 输出示例：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🤖 Model Router - 成本报告
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 总调用: 47 次    总花费: ¥3.28
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 模型              调用   缓存命中率   花费       占比
 deepseek-v4-flash  32     68%        ¥0.52     16%
 deepseek-v4-pro    15     42%        ¥2.76     84%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 对比参考:
   全程用 Pro:  ¥14.86
   全程用 Flash: ¥0.97
   实际节省 vs 全用 Pro: ¥11.58 (78%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`/cost --verbose`（或 `/cost -v`）额外输出每条路由记录。Semantic Router 扩展还支持 `/cost -vv` 以展示语义候选规则的相似度排名：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 路由明细:
 时间               模型        规则            原因
 2026-06-12 10:00  flash       file-reading    关键词"看看"
 2026-06-12 10:01  pro         code-generation 关键词"改问题" + upgrade
 2026-06-12 10:02  flash       default         downgrade, 验证阶段
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**手动模型覆盖规则：** 用户通过 `/model` 手动选择模型后，Model Router 在后续 3 轮内不自动切换（尊重用户选择），3 轮后恢复自动路由。

## 用户配置 (model-config.json)

```jsonc
{
  "routing": {
    "rules": [
      {
        "id": "complex-task",
        "priority": 100,
        "when": {
          "keywords": ["重构", "架构", "设计", "架构分析"],
          "notKeywords": ["小重构", "简单调整"]  // 否定条件
        },
        "then": { "model": "deepseek-v4-pro" }
      },
      {
        "id": "simple-task",
        "priority": 60,
        "when": {
          "toolsUsed": ["read", "ls", "grep"]
        },
        "then": { "model": "deepseek-v4-flash" }
      },
      {
        "id": "default",
        "priority": 0,
        "when": {},
        "then": { "model": "deepseek-v4-flash" }
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 2
    }
  }
}
```

## 测试策略

- **单元测试：** 覆盖 `router.ts`（规则匹配）、`classifier.ts`（状态更新逻辑）、`arbitrator.ts`（各种仲裁组合）、`pricing.ts`（缓存感知计算）
- **集成测试：** 使用 Pi Extension 的测试能力，模拟 `before_agent_start` 和 `turn_end` 事件，验证完整链路（provider 注册 → 路由 → 模型切换 → 成本追踪）
- **边界情况：** 所有规则都不匹配、所有规则都匹配（优先级测试）、定价文件损坏、setModel 失败、空会话

## 未来扩展

- **定价自动同步** — `src/pricing/sync.ts` 从 DeepSeek 官方页面自动拉取最新定价
- **更多模型** — 内置 Claude、GPT 等主流模型定价
- **多框架适配器** — Claude Code Adapter、Cursor Adapter
- **Web 可视化** — 可选 Dashboard 浏览成本报表
- **多级升级链** — 当模型超过 2 个时，引入 `levels` 升级链条

## 非功能需求

- 路由决策延迟 < 1ms（纯规则匹配，无额外 LLM 调用）
- 成本追踪写入为异步非阻塞，写入失败不阻塞主流程
- 所有配置均通过 JSON 文件，用户无需写代码
- 定价数据内置并可离线使用
- 任一组件崩溃不影响 Pi Agent 主流程
