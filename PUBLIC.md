# 在用的公开包

不是我写的，这里只记名字，方便换机器时装回来。

## pi 包（`~/.pi/agent/settings.json` 的 `packages`）

| 包 | 用途 | 仓库 |
| --- | --- | --- |
| `billion-context` | 上下文压缩 | https://github.com/ranxianglei/billion-context |
| `pi-web-ui` | 浏览器界面 | https://github.com/xing-shuyin/pi-web-ui |
| `pi-web-access` | 联网搜索 / 抓取 | https://github.com/nicobailon/pi-web-access |
| `pi-lens` | LSP / 诊断 / 结构化搜索 | https://github.com/apmantza/pi-lens |

```json
"packages": [
  "npm:billion-context@^0.1.190",
  "npm:pi-web-ui@0.105.1",
  "npm:pi-web-access@0.39.0",
  "npm:pi-lens@^4.4.0"
]
```

## 技能（`~/.agents/skills/`）

全部来自 https://github.com/emilkowalski/skills ：

animate、animate-expo、animation-vocabulary、apple-design、ask-sonner、break-ui、emil-design-eng、find-animation-opportunities、improve-animations、mobile-native、pick-ui-library、prototype、review-animations、write-swift
