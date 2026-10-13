# 一键重启（restart）

pi-web-ui 插件：顶栏加一个「⟳ 重启」按钮，点一下重启 pi-web-ui 服务（连同其中的 pi 和扩展），服务恢复后页面自动刷新。

## 安装

```sh
cp -r restart ~/.pi-web/plugins/
```

刷新 Web UI，在设置的插件页批准它的权限（`http`、`ui`）。

## 行为

- 只在被 supervisor 托管的实例上生效（`pi-web-ui server install` 装的 systemd / launchd 服务）。前台运行的实例会拒绝并提示，因为退出后没人拉它回来。
- 点按钮后先弹确认；确认后服务进程收到 SIGTERM，走宿主自己的优雅关机，进行中的对话会被记下、重启后自动续跑。
- 页面每秒轮询 `/plugins-api/restart/status`，看到新的 `bootId` 就刷新；90 秒没恢复则给出提示。
- systemd 的 `RestartSec=5`，所以一次重启大约 6–10 秒。

## 测试

```sh
node --test tests/restart.test.mjs
```
