# pi-plugins

自用的 pi / pi-web-ui 插件、扩展和主题。

```
plugins/
  vite-preview/   前端预览（pi-web-ui 插件，自写）
  restart/        一键重启服务并自动刷新页面（pi-web-ui 插件，自写）
  xiaoai-hook/    任务完成通知（pi 扩展，自写）
themes/
  megumin.css     爆裂魔导 · 惠惠（pi-web-ui 主题，自定义）
PUBLIC.md         在用的公开包 / 技能清单（只记名字）
```

## 安装

| 内容 | 放到哪里 | 生效方式 |
| --- | --- | --- |
| `plugins/vite-preview/` | `~/.pi-web/plugins/vite-preview/` | 在 Web UI 里重新加载插件并批准权限 |
| `plugins/restart/` | `~/.pi-web/plugins/restart/` | 同上 |
| `plugins/xiaoai-hook/xiaoai-hook.js` | `~/.pi/agent/extensions/xiaoai-hook.js` | 重启 pi；配置见该目录 README |
| `themes/*.css` | `~/.pi-web/themes/` | 刷新页面，在顶栏主题选择器里选 |

各目录的说明见其中的 README。
