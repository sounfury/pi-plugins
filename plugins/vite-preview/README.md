# 前端预览（vite-preview）

pi-web-ui 0.99 的同域前端开发预览插件。支持已经安装依赖的 Vite、Astro 项目。

## 使用

1. 刷新 Web UI，打开「前端预览」插件页。
2. 输入项目绝对目录，点击「启动预览」，留空则使用当前工作区。
3. 在插件内预览，或使用「在新标签页打开」访问当前域名的 `/preview/`。
4. 保存项目文件，Vite 热更新自动推送。可以切换桌面/手机宽度、重新加载并查看启动日志。
5. 点击「停止」结束开发服务。切换 Web UI 标签页不会停止服务；插件卸载、禁用、重载或宿主退出会结束子进程。

Agent 可使用 `vite_preview` 工具，参数为 `{"action":"start","project":"/绝对目录"}`、`{"action":"state"}` 或 `{"action":"stop"}`。工具会在宿主更新插件工具列表后可用。

## 实现

开发进程从项目自己的依赖解析 Vite / Astro，加载原有项目配置与集成，通过内联选项指定 `/preview/`、本机随机端口和适用于当前域名的 HMR 连接。插件自建本机代理适配层，再由 `host.registerProxy` 接入 Web UI 的 HTTP 和 WebSocket。无需新增域名、公网开发端口或修改 Cloudflare / 外部反向代理配置。

代理适配层为 HTML 链接、JS 模块导入和 CSS URL 补路径前缀。预览页中的小型脚本处理动态资源、`document.write`、History、fetch 和 XHR 的根路径。这个脚本只在预览页面运行。

目前一个 Web UI 实例同时预览一个项目，启动操作不会自动安装项目依赖。重启宿主后需要重新启动预览。硬编码通过 `window.location` 直接跳转根路径、Service Worker，以及特殊 CSP / iframe 设置的项目可能需要单独适配。Vite 的配置文件热重启可能丢失插件的内联参数，遇到时用「停止」再「启动」重新加载配置。

## 本次验证

已在 Echoes（Astro 5.17.2 / Vite 6.4.1）通过首页、归档页、链接前缀、Vite 客户端、HMR WebSocket 握手和停止服务的服务端验收。浏览器样式、交互以及保存文件后的热更新效果由用户验收。

安装目录：`~/.pi-web/plugins/vite-preview`。卸载时删除安装目录并在宿主中重新加载插件。

验收脚本：`PI_WEB_UI_DIR=<pi-web-ui 包目录> PREVIEW_TEST_PROJECT=<Astro 项目目录> node tests/acceptance.mjs`（断言按带 `/archive` 页的 Astro 项目写的）。
