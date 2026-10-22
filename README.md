# pi-plugins

我自己用的 [pi](https://github.com/earendil-works/pi) / [pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 插件、扩展和主题。除了 `PUBLIC.md` 里列的公开包，这里的东西都是我自己写的。

```
plugins/
  vite-preview/        前端预览（pi-web-ui 插件）
  xiaoai-hook/         任务完成后用小爱音箱播报（pi 扩展）
  cache-expiry-guard/  Claude 缓存过期预警（pi 扩展）
  cache-mode/          Magpie Claude 缓存时长切换：日常 1h / 集中 5m（pi 扩展）
  cache-rain/          集中模式下页面下雨，雨停 = 缓存过期（pi-web-ui 插件）
themes/
  megumin.css          爆裂魔导 · 惠惠（pi-web-ui 主题）
PUBLIC.md              在用的公开包 / 技能清单（只记名字）
```

两类插件的区别：

- **pi-web-ui 插件**（带 `manifest.json`）只在 Web UI 里运行，可以有自己的页面、顶栏按钮和服务端路由。
- **pi 扩展**（单个 `.js` / `.ts` 文件）由 pi 本身加载，在命令行 `pi` 和 pi-web-ui 里都生效。

## 插件

### 前端预览 · `plugins/vite-preview`

pi-web-ui 插件。在 Web UI 自己的域名下（`/preview/`）预览 Vite / Astro 项目，不用新开端口、加域名或改反代。

- 在插件页里填项目绝对路径就能启动预览，可以切桌面 / 手机宽度、看启动日志、停止服务。支持热更新。
- 给 Agent 提供 `vite_preview` 工具（`start` / `state` / `stop`）。
- 配置：插件设置里的 `defaultProject`（默认项目目录，留空就用当前工作区）。
- 权限：`http`、`ui`、`tools`、`fs:read`。
- 限制：一个实例同一时间只能预览一个项目；不会自动装依赖；宿主重启后要重新启动预览。

详见 [plugins/vite-preview/README.md](plugins/vite-preview/README.md)。

### 任务完成通知 · `plugins/xiaoai-hook`

pi 扩展。主对话的一轮任务正常完成后，向 XiaoAiPlayer 的 hook 接口 POST 一条通知，由小爱音箱播报。

- 出错、被中止、子代理和临时会话都不发。接口连不上就当离线，静默跳过。
- 配置文件 `~/.pi/agent/xiaoai-hook.json`，字段有 `enabled`、`piwebOnly`、`url`、`source`、`token`。里面有令牌，已经写进 `.gitignore`，不要提交。

详见 [plugins/xiaoai-hook/README.md](plugins/xiaoai-hook/README.md)。

### 缓存过期预警 · `plugins/cache-expiry-guard`

pi 扩展。用 Claude 这类模型接着聊时，如果是从别的模型切过来接手，或者距离它上次回复已经超过设定的分钟数（缓存多半过期了），并且上下文够大，就先拦下消息弹窗，显示大概要重写多少 token。弹窗有三个选项：

- **直接发送**
- **先用便宜模型压缩再发**
- **生成交接总结**：存到 `.pi-handoff/`，同时在对话里显示一张可复制的卡片，这张卡片不会发给模型。

配置文件 `~/.pi/agent/cache-expiry-guard.json`，字段有 `idleMinutes`、`minContextTokens`、`cheapProvider`、`cheapModel`、`guards`。`guards` 按模型正则逐条配置，每条可以单独覆盖时间和上下文阈值。另外有测试命令 `/cache-guard-test`。

详见 [plugins/cache-expiry-guard/README.md](plugins/cache-expiry-guard/README.md)。

### 缓存模式 · `plugins/cache-mode`

pi 扩展。给经 Magpie 订阅桥接的 Claude 切换缓存时长：日常 1h（默认）、集中 5m（连续干活更省）、关闭（交回 Magpie）。做法是让 Claude 请求改走 Magpie 的 `/v1/messages`，并带上 `X-Magpie-Cache-Marks: client`（Magpie #1717），不改 `models.json`。

- 命令 `/cache-mode [focus|daily|off|status]`，状态栏显示模式和缓存截止时间。
- 集中模式空闲超过 `focusAutoOffMinutes`（默认 30）分钟，自动切回日常。
- 集中模式下，`cache-expiry-guard` 的过期阈值自动变成 `focusIdleMinutes`（默认 4.5 分钟）。
- 配置文件 `~/.pi/agent/cache-mode.json`。

详见 [plugins/cache-mode/README.md](plugins/cache-mode/README.md)。

### 缓存雨 · `plugins/cache-rain`

pi-web-ui 插件，配合 `cache-mode`。输入框旁加一个「缓存」下拉；集中模式下整个页面下雨，右上角倒计时。最后 60 秒雨变小、冒「ゴゴゴ」、浮出「覺悟」独白；归零时雨停，『暴雨結束之時』『就是我的死期』加 To Be Continued；赶在最后续上则是彩虹 +「Catch the Rainbow！」。权限：`ui`、`http`。

详见 [plugins/cache-rain/README.md](plugins/cache-rain/README.md)。

## 主题

### 爆裂魔导 · 惠惠 · `themes/megumin.css`

pi-web-ui 浅色主题，配色取自惠惠的立绘：主强调是红魔之瞳红 `#c8243a`，次强调是巫师帽紫。装饰有背景魔法阵水印、空状态下缓慢旋转的法阵、发送键的“蓄力”光晕、工具运行时的呼吸光，等等。没有配置项。

## 安装

| 内容 | 放到哪里 | 生效方式 |
| --- | --- | --- |
| `plugins/vite-preview/` | `~/.pi-web/plugins/vite-preview/` | 刷新 Web UI 即加载，首次会弹一条能力声明提醒 |
| `plugins/xiaoai-hook/xiaoai-hook.js` | `~/.pi/agent/extensions/xiaoai-hook.js` | 重启 pi；配置见该目录 README |
| `plugins/cache-expiry-guard/cache-expiry-guard.ts` | `~/.pi/agent/extensions/cache-expiry-guard.ts` | 重启 pi；配置见该目录 README |
| `plugins/cache-mode/cache-mode.ts` | `~/.pi/agent/extensions/cache-mode.ts` | 重启 pi；配置见该目录 README |
| `plugins/cache-rain/` | `pi-web-ui install <目录>` | 刷新 Web UI |
| `themes/*.css` | `~/.pi-web/themes/` | 刷新页面，在顶栏主题选择器里选 |

用 pi-web-ui 时，“重启 pi”就是重启 pi-web-ui 服务，可以使用 pi-web-ui 自带的重启功能。

在用的公开包和技能清单见 [PUBLIC.md](PUBLIC.md)。
