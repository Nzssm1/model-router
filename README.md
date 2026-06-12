# Model Router 🤖

智能模型路由系统 — 根据任务类型自动切换大语言模型，在保证质量的前提下最大化降低成本。

## 快速开始

### 前提

- 已安装 [Pi Agent](https://github.com/earendil-works/pi)
- DeepSeek API Key（[注册](https://platform.deepseek.com/)）

### 安装

```bash
pi install model-router
```

### 配置

设置环境变量：

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

（可选）自定义路由规则：编辑 `~/.model-router/config.json` 或项目 `config/model-config.json`

### 使用

安装后自动生效，无感使用。可用命令：

```bash
/cost          # 当前会话成本报告
/cost -v       # 详细路由明细
/cost -vv      # 路由明细 + 语义匹配候选排名
/cost --all    # 所有会话汇总
/router        # 查看语义路由状态
/router on     # 开启语义路由（当前会话）
/router off    # 关闭语义路由（当前会话）
```

## 路由策略

### 快速路径（关键词/工具匹配）

| 场景 | 模型 |
|------|------|
| 重构、架构分析 | deepseek-v4-pro |
| 代码生成、功能实现 | deepseek-v4-pro |
| 文件读取、搜索 | deepseek-v4-flash |
| 简单问答、概念解释 | deepseek-v4-flash |

### 语义路径（Embedding 匹配）

当关键词匹配无法命中任何规则（落入 default）时，语义路由自动启用：

1. 将用户输入编码为 384 维向量（paraphrase-multilingual-MiniLM-L12-v2）
2. 与所有规则的**自然语言描述**计算余弦相似度
3. 选择相似度 ≥ 阈值（默认 0.55）且优先级最高的规则

语义路由通过 `/router on` 启用（需在 config 中设置 `semanticRouting: true`），首次使用会自动下载约 120MB 的 ONNX 模型。

### 安全保护（Classifier）

跨 turn 分析任务难度，自动升级/降级：

- **自动升级**：连续失败时自动从 Flash 切换到 Pro
- **降级否决**：强规则（priority ≥ 80）命中的任务不会被自动降级

## 配置参考

```json
{
  "routing": {
    "semanticRouting": true,
    "semanticThreshold": 0.55,
    "rules": [
      {
        "id": "complex-task",
        "priority": 100,
        "when": { "keywords": ["重构", "refactor"] },
        "then": { "model": "deepseek-v4-pro", "thinking": "high" },
        "description": "涉及跨模块重构、架构设计、复杂问题排查的任务"
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 2
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `semanticRouting` | 是否启用语义路由 | `false`（需主动开启） |
| `semanticThreshold` | 语义匹配相似度阈值（0–1） | `0.55` |
| `rules[].description` | 规则的自然语言描述（用于语义匹配） | 无描述则跳过语义匹配 |

## 成本报告示例

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🤖 Model Router - 成本报告
 总调用: 47 次    总花费: ¥3.28
 对比：全用 Pro ¥14.86 → 节省 78%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`/cost -vv` 可查看语义匹配的候选排名：

```
 路由明细（含语义候选排名）:
 时间                   模型               规则             原因
 14:32:05              deepseek-v4-pro    complex-task     语义匹配 complex-task (相似度 0.74)
   └ 候选: complex-task 0.74, code-generation 0.61, simple-qa 0.33, file-reading 0.28
```

## 架构

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│    Router    │───▶│  Arbitrator  │───▶│  Pi Extension │
│  (规则引擎)   │    │  (决策仲裁)   │    │  (事件钩子)   │
└──────────────┘    └──────────────┘    └──────┬───────┘
      │                   ▲                    │
      │   ┌───────────────┤                    │
      │   │  Semantic     │           ┌───────▼───────┐
      │   │  Engine       │           │   Tracker    │
      │   │  (Embedding)  │           │  (成本追踪)   │
      │   └───────────────┘           └──────────────┘
      │          ▲
┌──────▼──────────┐      │
│  Classifier     │──────┘
│ (跨Turn分析)     │
└─────────────────┘
```

- **Router**：关键词/工具快速匹配
- **Semantic Engine**：ONNX embedding 语义匹配（fallback）
- **Arbitrator**：合并 Router/语义结果 + Classifier 裁决
- **Classifier**：跨 turn 任务难度分析，升级/降级保护
- **Tracker**：成本记录与报告

## 依赖

- `@huggingface/transformers`（v3）— ONNX 推理，首次运行自动下载模型至 `~/.model-router/models/`

## License

MIT
