import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachNotifier, isQuietTime } from "../xiaoai-hook.js";

const originalDir = process.env.PI_CODING_AGENT_DIR;
const sandbox = mkdtempSync(join(tmpdir(), "hook-quiet-hours-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(sandbox, { recursive: true, force: true });
});
const config = {
  enabled: true,
  source: "Oracle test",
  quietHours: { enabled: true, timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], beforeHour: 19 },
};

for (const [label, iso, expected] of [
  ["周一18:59:59静默", "2026-10-19T10:59:59Z", true],
  ["周一19:00:00恢复", "2026-10-19T11:00:00Z", false],
  ["周一00:00按北京时间静默，此时UTC仍是周日", "2026-10-18T16:00:00Z", true],
  ["周五白天静默", "2026-10-23T02:00:00Z", true],
  ["周五23:59允许播报", "2026-10-23T15:59:59Z", false],
  ["周六00:00允许播报，此时UTC仍是周五", "2026-10-23T16:00:00Z", false],
  ["周六白天允许播报", "2026-10-24T02:00:00Z", false],
  ["周日白天允许播报", "2026-10-25T02:00:00Z", false],
]) {
  test(label, () => assert.equal(isQuietTime(config, new Date(iso)), expected));
}

test("未启用的客户端维持全天播报", () => {
  assert.equal(isQuietTime({}, new Date("2026-10-19T02:00:00Z")), false);
  assert.equal(isQuietTime({ quietHours: { enabled: false } }, new Date("2026-10-19T02:00:00Z")), false);
});

async function settle(now, getConfig) {
  const handlers = new Map();
  const sent = [];
  const pi = { on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } };
  const dispose = attachNotifier(pi, {
    getConfig, isPiWeb: () => true, now: () => new Date(now),
    send: async (...args) => sent.push(args), makeId: () => "test-id",
  });
  const ctx = { sessionManager: {
    getSessionDir: () => "/tmp/pi/sessions", getSessionId: () => "test-session",
    getSessionName: () => "task", getEntries: () => [],
  } };
  await handlers.get("agent_start")();
  await handlers.get("agent_before_settle")({ outcome: "completed" });
  await handlers.get("agent_settled")({}, ctx);
  dispose();
  return sent;
}

test("静默时任务完成不会调用发送函数", async () => {
  assert.equal((await settle("2026-10-19T10:59:59Z", () => config)).length, 0);
});

test("19点完成的任务正常发送", async () => {
  const sent = await settle("2026-10-19T11:00:00Z", () => config);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].source, "Oracle test");
});

test("配置每次结算重读，周末不静默", async () => {
  let reads = 0;
  const sent = await settle("2026-10-24T02:00:00Z", () => { reads++; return config; });
  assert.equal(reads, 1);
  assert.equal(sent.length, 1);
});
