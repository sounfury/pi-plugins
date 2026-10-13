# 任务完成通知（xiaoai-hook）

pi 扩展：主对话的一轮任务正常完成后，向 XiaoAiPlayer 的 hook 接口 POST 一条通知，由小爱音箱播报。

## 安装

```sh
cp xiaoai-hook.js ~/.pi/agent/extensions/
cp xiaoai-hook.example.json ~/.pi/agent/xiaoai-hook.json   # 再填入 token
chmod 600 ~/.pi/agent/xiaoai-hook.json
```

重启 pi 后生效。

## 配置（`~/.pi/agent/xiaoai-hook.json`）

| 键 | 说明 |
| --- | --- |
| `enabled` | 必须为 `true` 才发送 |
| `piwebOnly` | 默认只在 pi-web-ui 启动的会话里发送；设为 `false` 时终端里的 pi 也发送 |
| `url` | 通知接口，HTTP 或 HTTPS |
| `source` | 播报里的来源名，缺省为 `PiWeb` |
| `token` | Bearer 令牌，必填 |

真实的 `xiaoai-hook.json` 含令牌，不要提交到仓库（已在 `.gitignore` 里）。

## 行为

- 只在任务正常完成时发送；出错或被中止的不发。
- 子代理和临时会话不发，避免重复播报。
- 请求体为 `{ source, event_id, task }`，`task` 是会话名，未命名时取首条用户消息。播报文案由 XiaoAiPlayer 的 `HOOK_TEXT` 决定。
- 请求超时 4 秒，遇到 5xx / 429 / 网络错误最多试 3 次。
- 通知接口连接被拒绝（SSH 隧道没连、对端没开机）时视为离线：静默跳过，不重试也不弹警告，日志里记 `skip_offline`。
- 调试日志写在 `~/.pi/agent/xiaoai-hook.log`。
