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

安装后自动生效，无感使用。需要查看成本时：

```bash
/cost          # 当前会话成本报告
/cost -v       # 详细路由明细
/cost --all    # 所有会话汇总
```

## 路由策略

| 场景 | 模型 |
|------|------|
| 重构、架构分析 | deepseek-v4-pro |
| 代码生成、功能实现 | deepseek-v4-pro |
| 文件读取、搜索 | deepseek-v4-flash |
| 其他 | deepseek-v4-flash |

执行失败自动升级到更强模型。

## 成本报告示例

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🤖 Model Router - 成本报告
 总调用: 47 次    总花费: ¥3.28
 对比：全用 Pro ¥14.86 → 节省 78%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 架构

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│    Router    │───▶│  Arbitrator  │───▶│  Pi Extension │
│  (规则引擎)   │    │  (决策仲裁)   │    │  (事件钩子)   │
└──────────────┘    └──────────────┘    └──────┬───────┘
                      ▲                        │
┌──────────────┐      │                 ┌──────▼───────┐
│  Classifier  │──────┘                 │   Tracker    │
│ (跨Turn分析)  │                        │  (成本追踪)   │
└──────────────┘                        └──────────────┘
```

## License

MIT
