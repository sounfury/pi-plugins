# 云端任务完成播报入口

复用已有的米家常驻服务，通过米家云向指定音箱发送朗读指令。无需本地端口转发，也无需运行模型或 Agent。

```text
Pi Hook → HTTPS 通知入口 → 本机米家服务 /speak → 米家云 → 指定音箱
```

## 部署

依赖 Python 3 标准库，以及能够通过 `/speak` 接收 `text`、`speaker`、`dry_run` 的米家服务。

1. 将 `server.py` 放到服务器的 `~/home-tools/task-notify/`。
2. 将 `notify.env.example` 复制到仓库之外的 `~/.config/task-notify.env`，权限设为 `0600`。生成独立随机令牌，将 `NOTIFY_SPEAKER` 设置为米家里的准确设备名。
3. 按服务器实际用户名和目录调整 `task-notify.service`，安装到 `/etc/systemd/system/`，执行 `systemctl daemon-reload` 和 `systemctl enable --now task-notify`。
4. 配置 HTTPS 反向代理，后端为 `http://127.0.0.1:18766`。米家服务继续只监听服务器本机，不对公网开放。
5. 在客户端私有的 `~/.pi/agent/xiaoai-hook.json` 中配置通知 URL 和相同令牌。公共仓库中的地址使用 `https://notify.example.com/hooks/task-completed` 占位。

不要将真实令牌、米家认证文件、客户端配置或服务器环境文件提交到仓库。服务代码不包含实际域名、设备名或认证信息。

## 接口

- `GET /health`：返回最小健康状态。
- `POST /hooks/task-completed`：要求 `Authorization: Bearer <token>`，JSON 为 `{"source":"PiWeb","event_id":"unique-id","task":"任务名称"}`。
- 正常接收返回 HTTP 202、`{"status":"queued"}`；同一事件重试返回 `{"status":"duplicate"}`，兼容现有 Pi Hook。
- 加上 `"dry_run":true` 可检查固定音箱是否支持播报，不实际发声，也不入队。
- 客户端不能覆盖服务器配置的默认音箱、米家地址或播报模板。

已认证请求每分钟最多接收 10 次新事件或模拟校验，队列最多 100 条。任务名称最多 160 字，正文最多 4096 字节。SQLite 保存队列和去重记录，已完成记录保留 7 天；失败发送最多尝试 3 次。网关返回成功表示米家接受了指令，无法确认设备是否已经实际出声。网络中断造成上游已接收但未返回时，重试仍可能产生重复播报。

运行 `python -m unittest discover -s tests -v` 验证认证、固定音箱、队列恢复和重复事件处理。
