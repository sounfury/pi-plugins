import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheRain } from '../../cache-rain/index.mjs';

// 只替换网络传输，实际加载扩展并执行命令、input 事件和请求包装。
const transport = 'data:text/javascript,' + encodeURIComponent(
  ['streamAnthropic', 'streamOpenAICompletions', 'streamSimpleAnthropic', 'streamSimpleOpenAICompletions']
    .map(name => `export const ${name} = (model, context, options) => ({ model, context, options });`).join('\n'),
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-ai') return { url: transport, shortCircuit: true };
    return next(specifier, context);
  },
});
after(() => hooks.deregister());
let sequence = 0;
const minute = 60_000;
const now = Date.UTC(2026, 9, 23, 12);

async function setup(t, { config = {}, sessions = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const dir = mkdtempSync(join(tmpdir(), 'cache-mode-idle-'));
  const env = { PI_CACHE_MODE_CONFIG: join(dir, 'mode.json'), PI_CACHE_MODE_STATE: join(dir, 'state.json') };
  writeFileSync(env.PI_CACHE_MODE_CONFIG, JSON.stringify({ mode: 'daily', focusAutoOffMinutes: 30, ...config }));
  writeFileSync(env.PI_CACHE_MODE_STATE, JSON.stringify({ sessions }));
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const handlers = {};
  const commands = {};
  let wrapped;
  const extension = await import(`../cache-mode.ts?test=${++sequence}`);
  extension.default({
    registerProvider: (_id, provider) => { wrapped = provider.streamSimple; },
    registerCommand: (name, command) => { commands[name] = command.handler; },
    on: (event, handler) => { handlers[event] = handler; },
  });
  const model = { provider: 'magpie', id: 'claude/claude-opus-5-5', baseUrl: 'http://localhost/v1' };
  const notices = [];
  const ctx = { model, hasUI: true, ui: { notify: (text, level) => notices.push({ text, level }), setStatus() {} }, sessionManager: { getSessionId: () => 'current' } };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    env, ctx, model, notices,
    modelSelect: () => handlers.model_select({}, ctx),
    command: arg => commands['cache-mode'](arg, ctx),
    read: () => JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8')),
    focus: () => commands['cache-mode']('focus', ctx),
    input: () => handlers.input({ source: 'interactive' }, ctx),
    request: () => wrapped(model, { messages: [] }, { sessionId: 'current' }),
  };
}

test('非配置模型命令直接关闭全局模式，无法开启 5m / 1h', async t => {
  const s = await setup(t, { config: { mode: 'focus' } });
  s.ctx.model = { ...s.model, id: 'codex/gpt-6-astra' };
  for (const arg of ['focus', 'daily', 'off', 'status']) {
    await s.command(arg);
    assert.equal(s.read().mode, 'off');
    assert.match(s.notices.at(-1).text, /关闭/);
  }
  s.ctx.model = s.model;
  await s.command('daily');
  assert.equal(s.read().mode, 'daily');
});

test('切到 GPT 关闭全局模式，切回 Claude 后保持关闭直到手动开启', async t => {
  const s = await setup(t, { config: { mode: 'focus' } });
  s.ctx.model = { ...s.model, id: 'codex/gpt-6-astra' };
  await s.modelSelect();
  assert.equal(s.read().mode, 'off');
  s.ctx.model = s.model;
  await s.modelSelect();
  assert.equal(s.read().mode, 'off');
  await s.focus();
  assert.equal(s.read().mode, 'focus');
});

const oldFocus = { old: { at: now - 120 * minute, mode: 'focus', ttlSec: 300, model: 'claude/claude-opus-5-5' } };

test('命令刚切到 5m 后，旧会话记录不能让首条请求切回 1h', async t => {
  const s = await setup(t, { sessions: oldFocus });
  await s.focus();
  await s.input();
  assert.equal(s.read().mode, 'focus');
  assert.equal(s.request().options.cacheRetention, 'short');
});

test('网页刚切到 5m 后，旧会话记录不能让首条请求切回 1h', async t => {
  const s = await setup(t, { sessions: oldFocus });
  const effects = [];
  const host = { getActiveConversation: () => ({ model: `${s.model.provider}/${s.model.id}` }), ui: { update() {} }, effect: (_name, dispose) => effects.push(dispose), broadcast() {}, onMessage() {}, onAttach() {} };
  const rain = createCacheRain(host, { env: s.env, now: () => Date.now() });
  t.after(() => effects.forEach(dispose => dispose()));
  rain.setMode('focus');
  await s.input();
  assert.equal(s.read().mode, 'focus');
  assert.equal(s.request().options.cacheRetention, 'short');
});

test('切换后没有请求，空闲超过 30 分钟仍自动回日常', async t => {
  const s = await setup(t);
  await s.focus();
  t.mock.timers.tick(31 * minute);
  await s.input();
  assert.equal(s.read().mode, 'daily');
  assert.equal(s.request().options.cacheRetention, 'long');
});

test('5m 请求会继续延长空闲计时', async t => {
  const s = await setup(t, { sessions: oldFocus });
  await s.focus();
  t.mock.timers.tick(29 * minute);
  s.request();
  t.mock.timers.tick(29 * minute);
  await s.input();
  assert.equal(s.read().mode, 'focus');
  t.mock.timers.tick(2 * minute);
  await s.input();
  assert.equal(s.read().mode, 'daily');
});

test('手动编辑的旧版配置按文件修改时间开始计时', async t => {
  const s = await setup(t, { config: { mode: 'focus' }, sessions: oldFocus });
  utimesSync(s.env.PI_CACHE_MODE_CONFIG, now / 1000, now / 1000);
  await s.input();
  assert.equal(s.read().mode, 'focus');
  t.mock.timers.tick(31 * minute);
  await s.input();
  assert.equal(s.read().mode, 'daily');
});

test('关闭自动切换时保持手动选择', async t => {
  const s = await setup(t, { config: { focusAutoOffMinutes: 0 }, sessions: oldFocus });
  await s.focus();
  t.mock.timers.tick(120 * minute);
  await s.input();
  assert.equal(s.read().mode, 'focus');
});
