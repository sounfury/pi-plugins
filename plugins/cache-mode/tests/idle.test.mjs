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
const serialization = 'data:text/javascript,' + encodeURIComponent(
  'export const convertToLlm = value => value; export const serializeConversation = value => JSON.stringify(value);',
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-ai') return { url: transport, shortCircuit: true };
    if (specifier === '@earendil-works/pi-coding-agent') return { url: serialization, shortCircuit: true };
    return next(specifier, context);
  },
});
after(() => hooks.deregister());
let sequence = 0;
const minute = 60_000;
// 文件系统 mtime 不受 Date mock 影响，时钟起点必须贴近真实写文件的时间。
const now = Date.now();

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
    env, ctx, model, notices, handlers,
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

for (const id of ['remote-magpie/claude/claude-opus-5-5', 'region/remote-magpie/claude/claude-sonnet-4-6']) {
  test(`远程 Claude 首条请求使用所选 TTL，保留网关路由：${id}`, async t => {
    const s = await setup(t, { config: { mode: 'off' } });
    s.model.id = id;
    await s.modelSelect();
    for (const [mode, retention, ttlSec] of [['focus', 'short', 300], ['daily', 'long', 3600]]) {
      await s.command(mode);
      assert.equal(s.read().mode, mode);
      const request = s.request();
      assert.equal(request.model.id, id);
      assert.equal(request.model.api, 'anthropic-messages');
      assert.equal(request.model.baseUrl, 'http://localhost');
      assert.equal(request.model.headers['X-Magpie-Cache-Marks'], 'client');
      assert.equal(request.options.cacheRetention, retention);
      const entry = JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current;
      assert.equal(entry.model, id);
      assert.equal(entry.mode, mode);
      assert.equal(entry.ttlSec, ttlSec);
    }
  });
}

for (const [mode, ttlSec, control] of [
  ['focus', 300, { type: 'ephemeral' }],
  ['daily', 3600, { type: 'ephemeral', ttl: '1h' }],
]) {
  test(`原生 Anthropic 请求按 ${mode} 写入 TTL、请求头和当前会话倒计时`, async t => {
    const s = await setup(t, { config: { mode } });
    s.model.api = 'anthropic-messages';
    s.model.id = 'remote-magpie/claude/claude-opus-5-5';
    const original = {
      model: s.model.id,
      system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
      tools: [{ name: 'read', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
    };
    // 按实际 SDK 顺序先 headers、后 payload；生成 payload 前不能伪造请求记录。
    const headers = { 'x-magpie-cache-marks': 'server', 'content-type': 'application/json' };
    s.handlers.before_provider_headers({ headers }, s.ctx);
    assert.deepEqual(headers, { 'content-type': 'application/json', 'X-Magpie-Cache-Marks': 'client' });
    assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current, undefined);
    const payload = s.handlers.before_provider_request({ payload: original }, s.ctx);
    assert.deepEqual(payload.system[0].cache_control, control);
    assert.deepEqual(payload.messages[0].content[0].cache_control, control);
    assert.equal(payload.tools[0].cache_control, undefined);
    assert.deepEqual(payload.tools[0].input_schema, original.tools[0].input_schema);
    assert.equal(original.system[0].cache_control.ttl, '1h');
    const entry = JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current;
    assert.deepEqual(entry, { at: now, ttlSec, mode, model: s.model.id });
    s.handlers.after_provider_response({ status: 200, headers: { 'x-magpie-cache-marks-dropped': 'tools' } }, s.ctx);
    assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current.dropped, 'tools');
    const effects = [];
    const rain = createCacheRain({
      getActiveConversation: () => ({ sessionId: 'current', model: `${s.model.provider}/${s.model.id}` }),
      ui: { update() {} }, broadcast() {}, onMessage() {}, onAttach() {},
      effect: (_label, dispose) => effects.push(dispose),
    }, { env: s.env, now: () => Date.now() });
    t.after(() => effects.forEach(dispose => dispose()));
    assert.equal(rain.snapshot().entry.at, now);
    assert.equal(rain.snapshot().entry.ttlSec, ttlSec);
    t.mock.timers.tick(30_000);
    assert.equal(rain.snapshot().entry.at, now);
    assert.equal(rain.snapshot().now, now + 30_000);
  });
}

test('原生 Anthropic 无缓存点时不伪造倒计时，下一次请求能正常续期', async t => {
  const s = await setup(t, { config: { mode: 'focus' } });
  s.model.api = 'anthropic-messages';
  const noCache = { model: s.model.id, system: 'instructions', messages: [{ role: 'user', content: 'hello' }] };
  s.handlers.before_provider_headers({ headers: {} }, s.ctx);
  assert.deepEqual(s.handlers.before_provider_request({ payload: noCache }, s.ctx), noCache);
  s.handlers.after_provider_response({ status: 200, headers: {} }, s.ctx);
  assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current, undefined);
  const cached = { ...noCache, cache_control: { type: 'ephemeral', ttl: '1h' } };
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(minute);
    s.handlers.before_provider_headers({ headers: {} }, s.ctx);
    const payload = s.handlers.before_provider_request({ payload: cached }, s.ctx);
    assert.deepEqual(payload.cache_control, { type: 'ephemeral' });
    assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current.at, now + (i + 1) * minute);
  }
});

for (const scenario of ['off', 'other-model', 'other-provider', 'openai-api']) {
  test(`原生请求事件不接管其他请求：${scenario}`, async t => {
    const s = await setup(t, { config: { mode: scenario === 'off' ? 'off' : 'focus' } });
    s.model.api = scenario === 'openai-api' ? 'openai-completions' : 'anthropic-messages';
    if (scenario === 'other-provider') s.model.provider = 'other';
    const payload = { model: scenario === 'other-model' ? 'cheap-model' : s.model.id, cache_control: { type: 'ephemeral' } };
    const headers = { 'x-test': 'keep' };
    s.handlers.before_provider_headers({ headers }, s.ctx);
    if (scenario !== 'other-model') assert.deepEqual(headers, { 'x-test': 'keep' });
    assert.equal(s.handlers.before_provider_request({ payload }, s.ctx), undefined);
    assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current, undefined);
  });
}

test('原生请求未发送前会话结束会清理待处理标记', async t => {
  const s = await setup(t, { config: { mode: 'focus' } });
  s.model.api = 'anthropic-messages';
  s.handlers.before_provider_headers({ headers: {} }, s.ctx);
  s.handlers.session_shutdown({}, s.ctx);
  assert.equal(s.handlers.before_provider_request({ payload: { model: s.model.id, cache_control: { type: 'ephemeral' } } }, s.ctx), undefined);
  assert.equal(JSON.parse(readFileSync(s.env.PI_CACHE_MODE_STATE, 'utf8')).sessions.current, undefined);
});

test('远程 Claude 仍遵守显式 modelPattern 配置', async t => {
  const s = await setup(t, { config: { mode: 'focus', modelPattern: '^claude/' } });
  s.model.id = 'remote-magpie/claude/claude-opus-5-5';
  await s.focus();
  assert.equal(s.read().mode, 'off');
  assert.match(s.notices.at(-1).text, /当前模型不在缓存配置范围内/);
  const request = s.request();
  assert.equal(request.model.api, undefined);
  assert.equal(request.model.baseUrl, 'http://localhost/v1');
});

test('远程 Claude 集中模式沿用 4.5 分钟缓存过期预警', async t => {
  const s = await setup(t, { config: { mode: 'focus' } });
  const previous = process.env.PI_CEG_CONFIG;
  process.env.PI_CEG_CONFIG = join(s.env.PI_CACHE_MODE_CONFIG, '..', 'guard.json');
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CEG_CONFIG; else process.env.PI_CEG_CONFIG = previous;
  });
  const guard = await import(`../../cache-expiry-guard/cache-expiry-guard.ts?test=${++sequence}`);
  const handlers = {};
  guard.default({ registerCommand() {}, on: (name, handler) => { handlers[name] = handler; } });
  const prompts = [];
  const ctx = {
    ...s.ctx,
    model: { ...s.model, id: 'remote-magpie/claude/claude-opus-5-5' },
    getContextUsage: () => ({ tokens: 60_000 }),
    sessionManager: { getBranch: () => [{ type: 'message', message: {
      role: 'assistant', provider: 'magpie', model: 'remote-magpie/claude/claude-opus-5-5', timestamp: now - 6 * minute,
    } }] },
    ui: { ...s.ctx.ui, select: async title => { prompts.push(title); return '直接发送'; } },
  };
  assert.deepEqual(await handlers.input({ source: 'interactive' }, ctx), { action: 'continue' });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /集中模式 5m 缓存/);
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
