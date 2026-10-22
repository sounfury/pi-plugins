# 任务完成通知（xiaoai-hook）

云端米家播报可使用配套的[任务通知服务](server/README.md)：经 HTTPS 校验独立令牌后调用服务器本机米家服务，固定播报音箱，无需本机端口转发。实际 URL、令牌和设备名称保存在仓库之外的私有配置中。

pi 扩展：主对话的一轮任务正常完成后，向配置的任务完成通知接口 POST 一条事件，由通知服务调用米家播报。也兼容 XiaoAiPlayer 的 Hook 接口。

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
| `quietHours` | 可选静默时段；默认关闭，在发送 HTTP 请求前判断 |

例如只在这台机器上启用“北京时间周一至周五 19 点前静默”，在其私有配置中添加：

```json
{
  "quietHours": {
    "enabled": true,
    "timeZone": "Asia/Shanghai",
    "weekdays": [1, 2, 3, 4, 5],
    "beforeHour": 19
  }
}
```

`weekdays` 按 ISO 星期编号，1 为周一、7 为周日。19:00 起及周末正常发送，静默期间完成的事件直接丢弃，不排队补播；日志记录 `skip_quiet_hours`，界面不弹提醒。日期和小时均按配置时区计算，不受服务器本地时区影响。未配置或 `enabled:false` 的客户端不受影响。

修改配置会在下次任务完成时读取；首次安装带有静默判断的新脚本后，已有 Pi 会话需重载扩展或重启服务。测试：`node --test plugins/xiaoai-hook/tests/quiet-hours.test.mjs`。

真实的 `xiaoai-hook.json` 含令牌，不要提交到仓库（已在 `.gitignore` 里）。

## 行为

- 只在任务正常完成时发送；出错或被中止的不发。
- 子代理和临时会话不发，避免重复播报。
- 请求体为 `{ source, event_id, task }`，`task` 是会话名：优先读会话文件里最新的 `session_info`（PiWeb 重命名只写盘、不更新运行中的会话），最长 80 字；未命名时取首条用户消息前 30 字（与 PiWeb 左栏一致），会去掉注入的 `<skill>` 等标签块，系统提示词开头的则播报“当前对话”。播报文案由服务端模板配置决定。
- 请求超时 4 秒，遇到 5xx / 429 / 网络错误最多试 3 次。
- 通知接口连接被拒绝（服务或本机转发未启动）时视为离线：静默跳过，不重试也不弹警告，日志里记 `skip_offline`。
- 日志写在 `~/.pi/agent/xiaoai-hook.log`。

## 多机器统一维护

所有机器安装相同的 `xiaoai-hook.js`，地址、令牌、来源和静默时段分别保存在各自的 `~/.pi/agent/xiaoai-hook.json` 中。迁移服务器时同步脚本与私有配置即可，实际部署信息不进入代码仓库。

`xiaoai-hook.example.json` 默认关闭静默保护。需要工作日白天静默的服务器，将其私有配置中的 `quietHours.enabled` 设为 `true`；Windows 客户端保持 `false`。保护行为由配置决定，不依赖机器名或操作系统。
