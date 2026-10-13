# 一键重启（restart）

pi-web-ui 插件：重启 pi-web-ui 服务（连同其中的 pi 和扩展），服务恢复后页面自动刷新。

## 安装

```sh
cp -r restart ~/.pi-web/plugins/
```

刷新 Web UI 即加载；首次激活时宿主会弹一条能力声明提醒（`http`）。

## 使用

- 顶栏「插件」菜单里点「一键重启」；想常驻顶栏就点它右边的图钉。
- 点开后弹全屏确认，「重启」继续，「取消」或 Esc 回到原来的视图。

## 行为

- 只在被 supervisor 托管的实例上生效（`pi-web-ui server install` 装的 systemd / launchd 服务）。前台运行的实例会拒绝并提示，因为退出后没人拉它回来。
- 确认后服务进程收到 SIGTERM，走宿主自己的优雅关机，进行中的对话会被记下、重启后自动续跑。
- 页面每秒轮询 `/plugins-api/restart/status`，看到新的 `bootId` 就刷新；90 秒没恢复则给出提示。
- systemd 的 `RestartSec=5`，所以一次重启大约 6–10 秒。

## 测试

```sh
node --test tests/*.test.mjs
```

`tests/restart.test.mjs` 测服务端路由，`tests/client.test.mjs` 用一个最小 DOM 替身跑页面脚本的确认、取消、轮询和刷新。
