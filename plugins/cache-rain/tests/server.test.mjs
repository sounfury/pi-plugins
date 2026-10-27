// 跑法：node --test plugins/cache-rain/tests/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheRain } from '../index.mjs';

function fakeHost(conv) {
  const host = { sent: [], registered: [], updates: [], effects: [], handlers: {} };
  host.ui = {
    register: (item) => host.registered.push(item),
    update: (id, patch) => host.updates.push([id, patch]),
  };
  host.getActiveConversation = () => conv;
  host.broadcast = (p) => host.sent.push(['*', p]);
  host.sendTo = (id, p) => host.sent.push([id, p]);
  host.onMessage = (h) => { host.handlers.message = h; };
  host.onAttach = (h) => { host.handlers.attach = h; };
  host.onClientModelChanged = (h) => { host.handlers.modelChanged = h; };
  host.onConversationChanged = (h) => { host.handlers.conversationChanged = h; };
  host.effect = (_label, fn) => host.effects.push(fn);
  host.routes = {};
  host.route = (method, path, fn) => { host.routes[`${method} ${path}`] = fn; };
  return host;
}

function setup(conv, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-rain-'));
  const env = { PI_CACHE_MODE_CONFIG: join(dir, 'mode.json'), PI_CACHE_MODE_STATE: join(dir, 'state.json') };
  if (files.config) writeFileSync(env.PI_CACHE_MODE_CONFIG, JSON.stringify(files.config));
  if (files.state) writeFileSync(env.PI_CACHE_MODE_STATE, JSON.stringify(files.state));
  const host = fakeHost(conv);
  const api = createCacheRain(host, { env, now: () => 1000 });
  return { host, api, env, done: () => host.effects.forEach((f) => f()) };
}

describe('cache-rain server', () => {
  it('激活时把当前模式写到 manifest 声明的下拉上', () => {
    const { host, done } = setup({ model: 'magpie/claude/claude-opus-5-5' }, { config: { mode: 'focus' } });
    assert.equal(host.updates[0][1].value, 'focus');
    assert.deepEqual(host.updates[0][1].options.map(o => o.value), ['daily', 'focus', 'off']);
    done();
  });

  it('manifest 在输入框旁声明了三档下拉', () => {
    const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const item = m.ui.items.find((x) => x.id === 'mode');
    assert.equal(item.slot, 'composer.actions');
    assert.equal(item.kind, 'select');
    assert.equal(item.action, 'cache-rain:mode');
    assert.deepEqual(item.options.map((o) => o.value), ['daily', 'focus', 'off']);
    assert.ok(m.permissions.includes('ui') && m.permissions.includes('http'));
  });

  it('快照：Magpie 的 Claude 对话带上本会话的请求记录', () => {
    const conv = { sessionId: 's1', model: 'magpie/claude/claude-opus-5-5', isStreaming: true };
    const { api, done } = setup(conv, {
      config: { mode: 'focus' },
      state: { sessions: { s1: { at: 900, ttlSec: 300, mode: 'focus', model: 'claude/claude-opus-5-5' } } },
    });
    const s = api.snapshot('c1');
    assert.equal(s.mode, 'focus');
    assert.equal(s.tracked, true);
    assert.equal(s.streaming, true);
    assert.equal(s.entry.at, 900);
    assert.equal(s.now, 1000);
    done();
  });

  it('别家的模型不下雨', () => {
    const { api, done } = setup({ sessionId: 's1', model: 'magpie/codex/gpt-6-astra' }, { config: { mode: 'focus' } });
    assert.equal(api.snapshot().tracked, false);
    assert.equal(api.snapshot().mode, 'off');
    assert.equal('configuredMode' in api.snapshot(), false);
    assert.equal(api.config().mode, 'off');
    done();
  });

  it('客户端切模式：写回模式文件、保留其他字段、回包给来源标签页', () => {
    const { host, env, done } = setup({ model: 'magpie/claude/claude-opus-5-5' }, { config: { mode: 'daily', focusAutoOffMinutes: 12 } });
    host.handlers.message({ action: 'mode', value: 'focus' }, 'tab-1');
    const saved = JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8'));
    assert.deepEqual(saved, { mode: 'focus', focusAutoOffMinutes: 12, modeChangedAt: 1000 });
    assert.equal(host.updates.at(-1)[1].value, 'focus');
    const [to, body] = host.sent.at(-1);
    assert.equal(to, 'tab-1');
    assert.equal(body.mode, 'focus');
    done();
  });

  it('HTTP：GET /state 给快照，POST /mode 要自定义请求头', () => {
    const conv = { sessionId: 's1', model: 'magpie/claude/claude-opus-5-5' };
    const { host, env, done } = setup(conv, { config: { mode: 'daily' } });
    const res = () => {
      const r = { code: 200, body: null, headers: {} };
      r.status = (c) => { r.code = c; return r; };
      r.set = (k, v) => { r.headers[k] = v; return r; };
      r.json = (b) => { r.body = b; return r; };
      return r;
    };
    const get = res();
    host.routes['GET /state']({}, get);
    assert.equal(get.body.tracked, true);
    assert.equal(get.headers['Cache-Control'], 'no-store');

    const noHeader = res();
    host.routes['POST /mode']({ get: () => undefined, body: { mode: 'focus' } }, noHeader);
    assert.equal(noHeader.code, 400);
    assert.equal(JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8')).mode, 'daily');

    const ok = res();
    host.routes['POST /mode']({ get: (h) => (h === 'x-cache-rain' ? '1' : undefined), body: { mode: 'focus' } }, ok);
    assert.equal(ok.code, 200);
    assert.equal(ok.body.mode, 'focus');
    const saved = JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8'));
    assert.equal(saved.mode, 'focus');
    assert.equal(saved.modeChangedAt, 1000);
    done();
  });

  it('非匹配模型拒绝开启 5m / 1h，并关闭全局状态', () => {
    const { host, api, env, done } = setup({ model: 'magpie/codex/gpt-6-astra' }, { config: { mode: 'focus' } });
    try {
      for (const mode of ['focus', 'daily']) {
        assert.throws(() => api.setMode(mode, 'codex-tab'), /当前模型不在缓存配置范围内/);
        host.handlers.message({ action: 'mode', value: mode }, 'codex-tab');
        assert.equal(host.sent.at(-1)[1].mode, 'off');
        assert.match(host.sent.at(-1)[1].error, /当前模型不在缓存配置范围内/);
      }
      api.setMode('off', 'codex-tab');
      assert.equal(JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8')).mode, 'off');
    } finally { done(); }
  });

  it('按配置正则切换模型，只维护一份全局模式，切回来不自动开启', () => {
    const { host, api, done } = setup({ model: 'custom/allowed/model' }, { config: { mode: 'daily', provider: 'custom', modelPattern: '^allowed/' } });
    const tabs = { claude: { model: 'custom/allowed/model' }, other: { model: 'custom/blocked/model' } };
    host.getActiveConversation = ({ clientId } = {}) => tabs[clientId];
    try {
      assert.equal(api.snapshot('claude').mode, 'daily');
      assert.equal(api.snapshot('other').mode, 'off');
      assert.equal(api.snapshot('claude').mode, 'off');
      tabs.other = tabs.claude;
      assert.equal(api.snapshot('other').mode, 'off');
      api.setMode('focus', 'other');
      assert.equal(api.snapshot('claude').mode, 'focus');
    } finally { done(); }
  });

  it('HTTP 非匹配模型不能绕过下拉限制', () => {
    const { host, env, done } = setup({ model: 'magpie/codex/gpt-6-astra' }, { config: { mode: 'focus' } });
    try {
      const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      host.routes['POST /mode']({ get: () => '1', query: { clientId: 'codex-tab' }, body: { mode: 'daily' } }, res);
      assert.equal(res.code, 400);
      assert.equal(res.body.mode, 'off');
      assert.equal(JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8')).mode, 'off');
    } finally { done(); }
  });

  it('输入和轮询不重复发布 UI，也不保留隐藏的集中模式', () => {
    const { host, api, env, done } = setup({ model: 'magpie/codex/gpt-6-astra' }, { config: { mode: 'focus' } });
    try {
      const before = readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8');
      for (let i = 0; i < 50; i++) assert.equal(api.snapshot('gpt-tab').mode, 'off');
      assert.equal(host.updates.length, 1);
      assert.equal(host.updates[0][1].value, 'off');
      assert.deepEqual(host.updates[0][1].options.map(o => o.value), ['off']);
      assert.equal(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8'), before);
    } finally { done(); }
  });

  it('浏览器重连时重新下发全局值和选项，覆盖宿主激活期旧清单', () => {
    const { host, env, done } = setup({ model: 'magpie/codex/gpt-6-astra' }, { config: { mode: 'focus' } });
    try {
      const before = readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8');
      host.updates.length = 0;
      host.handlers.attach('reconnected-tab');
      assert.equal(host.updates.length, 1);
      assert.equal(host.updates[0][1].value, 'off');
      assert.deepEqual(host.updates[0][1].options.map(o => o.value), ['off']);
      assert.equal(host.sent.at(-1)[0], 'reconnected-tab');
      assert.equal(host.sent.at(-1)[1].mode, 'off');
      assert.equal(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8'), before);
    } finally { done(); }
  });

  it('模型切换事件立即同步宿主，忽略子代理切换', () => {
    const conv = { model: 'magpie/claude/claude-opus-5-5' };
    const { host, api, done } = setup(conv, { config: { mode: 'focus' } });
    try {
      conv.model = 'magpie/codex/gpt-6-astra';
      host.handlers.modelChanged({ clientId: 'tab', isSubagent: true });
      assert.equal(api.config().mode, 'focus');
      host.handlers.modelChanged({ clientId: 'tab', isSubagent: false });
      assert.equal(api.config().mode, 'off');
      assert.equal(host.updates.at(-1)[1].value, 'off');
      conv.model = 'magpie/claude/claude-opus-5-5';
      host.handlers.modelChanged({ clientId: 'tab', isSubagent: false });
      assert.equal(api.config().mode, 'off');
      assert.equal(host.updates.at(-1)[1].options.length, 3);
    } finally { done(); }
  });

  it('不认识的模式不写文件，回包带错误', () => {
    const { host, env, done } = setup({ model: 'magpie/claude/claude-opus-5-5' }, { config: { mode: 'daily' } });
    host.handlers.message({ action: 'mode', value: 'rainy' }, 'tab-1');
    assert.equal(JSON.parse(readFileSync(env.PI_CACHE_MODE_CONFIG, 'utf8')).mode, 'daily');
    assert.match(host.sent.at(-1)[1].error, /未知模式/);
    done();
  });
});
