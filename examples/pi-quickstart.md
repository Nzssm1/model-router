# Pi Agent 快速上手指南

## 1. 安装

```bash
pi install model-router
```

## 2. 配置 API Key

```bash
export DEEPSEEK_API_KEY="sk-your-key-here"
```

建议加入 `~/.zshrc` 或 `~/.bashrc`。

## 3. 验证

启动 Pi：

```bash
pi
```

在会话中输入任意指令，Model Router 会自动生效。查看路由效果：

```bash
/cost -v
```

## 4. 自定义规则

创建 `~/.model-router/config.json`：

```json
{
  "routing": {
    "rules": [
      {
        "id": "my-custom",
        "priority": 90,
        "when": { "keywords": ["我的特殊任务"] },
        "then": { "model": "deepseek-v4-pro" }
      }
    ],
    "escalation": {
      "enabled": true,
      "consecutiveErrorsBeforeUpgrade": 3
    }
  }
}
```

## 5. 卸载

```bash
pi uninstall model-router
rm -rf ~/.model-router
```
