# 缓存模式（cache-mode）

pi 扩展：给经 Magpie 订阅桥接的 Claude 切换提示缓存的时长。

| 模式 | 缓存 | 适合 |
| --- | --- | --- |
| `daily` 日常（默认） | 1 小时 | 随时离开、随时回来 |
| `focus` 集中 | 5 分钟 | 一段时间连续干活。每次请求续命 5 分钟，写缓存按 1.25 倍计，比 1h 的 2 倍省 |
| `off` 关闭 | 交给 Magpie（1 小时） | 不让插件接管，完全回到 Magpie 原来的行为 |

## 原理

Magpie 的订阅桥接默认把 Claude Code 的缓存写死成 1h。Magpie #1717（v0.1.1268 起）加了一个开关：请求 `/v1/messages` 时带上 `X-Magpie-Cache-Marks: client`，就按请求里的 `cache_control` 定 TTL，没写 ttl 按 5m，写了 `ttl: "1h"` 按 1h。

Magpie 的 Claude 模型可能配置为 `openai-completions`，也可能直接配置为 `anthropic-messages`；扩展分别处理两条请求路径：

- 命中的模型（默认 `^(?:[^/]+/)*claude/`）改走 `anthropic-messages`，发到网关根地址（`baseUrl` 去掉 `/v1`），带上上面那个请求头。既支持 `claude/...`，也支持 `remote-magpie/claude/...` 等带网关前缀的订阅模型；provider 仍须为 `magpie`。
- 对已经使用 `anthropic-messages` 的模型，通过 `before_provider_headers` / `before_provider_request` 补上客户端缓存头并调整现有缓存点的 TTL；工具缓存点同样移除，请求实际生成时记录会话时间。SDK 先处理请求头、再生成 payload；不依赖 OpenAI 包装是否被调用。
- 集中模式按 pi 的 `cacheRetention: "short"` 发（不带 ttl → 5m），日常模式按 `"long"` 发（`ttl: "1h"`）。请求本身指定了 `none` 的，保持不缓存；原生请求没有缓存点时也不会伪造倒计时。
- 工具定义上不打缓存标记（工具归 Claude Code 管，Magpie 只会丢掉并报告）。
- 其他模型原样走 `openai-completions`。

不改 `models.json`，Magpie 同步重写它也不影响。

每个会话最后一次 Claude 请求的时间和 TTL 记在 `~/.pi/agent/cache-mode.state.json`，供 `cache-expiry-guard` 和 pi-web-ui 插件 `cache-rain` 使用。

## 用法

- `/cache-mode`：弹出选择。
- `/cache-mode focus`（或 `5m`、`集中`）、`/cache-mode daily`（或 `1h`、`日常`）、`/cache-mode off`。
- `/cache-mode status`：看当前模式、本会话最后一次请求的时间，以及 Magpie 丢掉的缓存点（如果有）。
- pi-web-ui 里也可以用输入框旁的「缓存」下拉（需要装 `cache-rain` 插件）。
- 当前模型不匹配配置的 `provider` / `modelPattern` 时，直接把全局模式改为关闭；网页只保留关闭选项，命令也不能开启。切回匹配模型后可手动选择 5m / 1h，不自动恢复旧选择。

状态栏会显示当前模式和「缓存到 几点几分」。

默认保持手动选择，不自动切回日常。如果把 `focusAutoOffMinutes` 设为正数，则从最近一次手动切到集中模式或任意会话的最后一次集中模式 Claude 请求开始，超过该分钟数没有活动后，下一条消息发出前会自动切回日常。刚手动选择 5m 时会重新计时，不会受旧会话记录影响。设为 `0`（默认）关闭自动切换。

## 什么时候会多写一次缓存

- **第一次装上**：每个已有对话的下一条消息会让 Magpie 换用带客户端缓存标记的桥接会话，可能产生额外缓存写入。
- **集中 ↔ 日常**：插件会同时修改系统指令和消息结尾的 TTL；系统指令的 TTL 参与 Magpie 的会话匹配，因此两个方向都可能换用另一条桥接会话。即使旧缓存没有过期，也不能保证完整复用，长对话应按可能接近全量重写来预算。
- 能复用多少以返回的缓存读取和缓存写入用量为准；建议在任务开始前选好模式，避免频繁来回切换。`/cache-mode daily` 会在集中模式的缓存尚未过期时提示切换成本。

## 配置

`~/.pi/agent/cache-mode.json`，示例见 `cache-mode.example.json`。每次请求都会重新读，改了立即生效。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `daily` | `daily` / `focus` / `off` |
| `provider` | `magpie` | pi 里 Magpie 的 provider id |
| `modelPattern` | `^(?:[^/]+/)*claude/` | 要接管的模型 id（正则，不区分大小写），允许 Claude 路径前有网关前缀 |
| `focusAutoOffMinutes` | `0` | 集中模式空闲多少分钟后自动切回日常；`0` 不自动切，保持手动选择 |
| `anthropicBaseUrl` | 空 | Magpie 网关根地址；留空从 provider 的 `baseUrl` 推出 |

环境变量 `PI_CACHE_MODE_CONFIG`、`PI_CACHE_MODE_STATE` 可以改两个文件的位置（测试用）。

已有配置显式写了 `"modelPattern": "^claude/"` 的，仍按该限制执行。要接管远程转发的 Claude，可改成 `"modelPattern": "^(?:[^/]+/)*claude/"`，或删掉该字段使用新默认值。网页下拉、请求扩展和缓存过期预警都使用同一条规则；未发送消息的新对话也可以先选择缓存模式。

## 安装

```sh
cp cache-mode.ts ~/.pi/agent/extensions/
cp cache-mode.example.json ~/.pi/agent/cache-mode.json   # 可选
```

新开的对话会加载它；已经开着的对话执行 `/reload` 或使用 Web UI 的扩展重载后生效，也可以重启 pi-web-ui（或 pi）。只刷新浏览器或重载 `cache-rain` 网页插件，不会替换当前会话已加载的 pi 扩展。

## 测试

需要 Node.js 24（使用内置 TypeScript 加载和模块钩子），在仓库根目录运行：

```sh
node --test plugins/cache-mode/tests/idle.test.mjs plugins/cache-rain/tests/server.test.mjs
```

实际 SDK 集成测试会创建隔离的配置和会话，把请求发往本地模拟 Anthropic 服务，验证真实的模型 API 分派、扩展事件顺序、请求头、TTL 和状态落盘，不调用远程模型。指定已安装 SDK 的入口后运行：

```sh
PI_CACHE_MODE_SDK=/path/to/pi-coding-agent/dist/index.js node --test plugins/cache-mode/tests/sdk.test.mjs
```

未指定 `PI_CACHE_MODE_SDK` 时，该集成测试会明确跳过。

## 已知限制

- 依赖 Magpie v0.1.1268 及以后的版本。
- 倒计时按请求发出的时间算，比 Anthropic 那边实际的过期时间略早，只会偏保守。
- 所有会话共享一份模式；切到非匹配模型会全局关闭，不保留按标签页区分的模式。
