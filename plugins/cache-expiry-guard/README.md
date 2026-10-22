# 缓存过期预警（cache-expiry-guard）

pi 扩展：用 Claude 这类有提示缓存的模型接着聊时，如果缓存很可能已经失效、这一轮要把整段上下文重新写一遍缓存，就先拦下消息弹窗提醒，让你选怎么处理。

## 什么时候会弹

以下条件都要满足：

1. 当前模型（`provider/model`）匹配配置里 `guards` 的某条 `pattern`（正则，不区分大小写）。
2. 当前上下文超过 `minContextTokens`。
3. 满足下面任意一种情况：
   - **模型切换接手**：当前分支上一条助手回复不是这个模型族回的（比如从 Gemini 切过来），或者这个会话里一直没用过它。
   - **缓存过期**：距离这个模型族在当前分支上最后一次回复超过 `idleMinutes` 分钟。装了 [`cache-mode`](../cache-mode/README.md) 且开着集中模式（5m 缓存）时，对它接管的模型改用 `focusIdleMinutes`。

“最后使用时间”按模型族单独算：中间插几轮别的模型，不会刷新 Claude 的时间。

没有界面时（比如 `pi -p` 这种非交互模式），不会弹窗，消息照常发出。

## 三个选项

弹窗会显示原因，以及大约要重写多少 token。

- **直接发送**：照常发出。
- **先用便宜模型压缩再发**：用 `cheapProvider/cheapModel` 生成压缩摘要（替换 pi 默认的压缩模型，只对这一次生效），压缩完成后自动把你的消息发出去。便宜模型失败时退回 pi 默认压缩。
- **生成交接总结**：用便宜模型把当前分支整理成一份交接提示词，末尾附上你原来那条消息：
  - 存到项目下的 `.pi-handoff/handoff-<时间>.md`；
  - 同时在对话里显示一张卡片，用消息上的复制按钮就能复制，新开会话粘贴即可。这张卡片在每次请求前都会被剔除，不会发给模型，也不会打断缓存；
  - 原消息不会发送。

关掉弹窗（取消）的话，消息不会发送。

## 配置

配置文件：`~/.pi/agent/cache-expiry-guard.json`，示例见 `cache-expiry-guard.example.json`。每次发消息都会重新读取，改完立即生效；文件不存在或 JSON 有错时使用默认值。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `idleMinutes` | `55` | 超过多少分钟没用就当缓存已过期（Claude 缓存最长 1 小时） |
| `focusIdleMinutes` | `4.5` | `cache-mode` 集中模式下的过期阈值（5m 缓存）；取它和该条规则 `idleMinutes` 中较小的 |
| `minContextTokens` | `50000` | 上下文小于这个值时不提醒（重写也不贵） |
| `cheapProvider` | `magpie` | 用来压缩、写交接总结的便宜模型的 provider |
| `cheapModel` | `antigravity/gemini-3.8-flash` | 便宜模型的 id |
| `guards` | `[{ "pattern": "claude" }]` | 需要预警的模型列表。`pattern` 是匹配 `provider/model` 的正则；每条可以单独写 `idleMinutes`、`minContextTokens`，覆盖上面的全局值 |

环境变量（主要测试用，会覆盖配置文件）：

| 变量 | 作用 |
| --- | --- |
| `PI_CEG_CONFIG` | 配置文件路径 |
| `PI_CEG_IDLE_MIN` | 覆盖全局 `idleMinutes` |
| `PI_CEG_MIN_TOKENS` | 覆盖全局 `minContextTokens` |

注意：环境变量只覆盖全局值；`guards` 里单条写了覆盖值的，以那一条为准。

## 命令

- `/cache-guard-test`：下一条消息强制弹窗，用来看效果。

## 安装

```sh
cp cache-expiry-guard.ts ~/.pi/agent/extensions/
cp cache-expiry-guard.example.json ~/.pi/agent/cache-expiry-guard.json   # 按需修改
```

重启 pi（用 pi-web-ui 的话就重启 pi-web-ui）后生效。这是 pi 自己的扩展，命令行里的 `pi` 和 pi-web-ui 都会加载：命令行里弹的是终端选择框，pi-web-ui 里弹的是网页弹窗。

## 已知限制

- pi-web-ui 目前不支持扩展预填输入框或新开会话，所以交接总结只能复制粘贴。
- “压缩完自动发送”只在小会话上测过，大会话上还没实际跑通过。
- 只看当前分支；判断“缓存过期”用的是本地时间间隔，算不上精确，Magpie 等中转那边的真实缓存状态它看不到。
