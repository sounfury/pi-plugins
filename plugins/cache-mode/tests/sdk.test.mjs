import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 指向实际 pi-coding-agent/dist/index.js；不替换 SDK 的模型分派、传输或扩展事件。
const sdkEntry = process.env.PI_CACHE_MODE_SDK;
test('实际 SDK 的原生 Anthropic 请求写入缓存头、TTL 和会话记录', {
  skip: !sdkEntry && '设置 PI_CACHE_MODE_SDK 后运行实际 SDK 集成测试',
  timeout: 30_000,
}, async t => {
  const sdk = await import(pathToFileURL(resolve(sdkEntry)).href);
  const dir = mkdtempSync(join(tmpdir(), 'cache-mode-sdk-'));
  const env = { PI_CACHE_MODE_CONFIG: join(dir, 'cache-mode.json'), PI_CACHE_MODE_STATE: join(dir, 'cache-mode.state.json') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let session;
  let server;
  t.after(async () => {
    session?.dispose();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(env.PI_CACHE_MODE_CONFIG, JSON.stringify({ mode: 'focus' }));
  const modelId = 'remote-magpie/claude/claude-opus-5-5';
  const requests = [];
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(text), path: req.url });
    const events = [
      { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-magpie-cache-marks-dropped': 'test-marker' });
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { magpie: {
    baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-test-only', api: 'openai-completions',
    models: [{ id: modelId, name: 'Local Claude test', api: 'anthropic-messages', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
  } } }));
  writeFileSync(join(dir, 'auth.json'), '{}');
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultProvider: 'magpie', defaultModel: modelId, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off',
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL('../cache-mode.ts', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Local cache transport test.',
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') });
  const model = modelRuntime.getModel('magpie', modelId);
  assert.equal(model.api, 'anthropic-messages');
  ({ session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, resourceLoader, settingsManager, tools: [], sessionManager: sdk.SessionManager.inMemory(dir), thinkingLevel: 'off' }));
  const errors = [];
  await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
  for (const [mode, ttlSec] of [['focus', 300], ['daily', 3600]]) {
    await session.prompt(`/cache-mode ${mode}`);
    await session.prompt('hello local cache test');
    assert.deepEqual(errors, []);
    assert.equal(session.getLastAssistantText(), 'ok');
    const request = requests.at(-1);
    assert.equal(request.headers['x-magpie-cache-marks'], 'client');
    assert.match(request.path, /^\/v1\/messages/);
    const marks = [request.body.cache_control, ...(request.body.system ?? []).map(block => block.cache_control),
      ...request.body.messages.flatMap(message => Array.isArray(message.content) ? message.content.map(block => block.cache_control) : [])].filter(Boolean);
    assert.ok(marks.length >= 2, '应保留系统和会话消息缓存点');
    assert.ok(marks.every(mark => mode === 'focus' ? mark.ttl === undefined : mark.ttl === '1h'));
    const entry = JSON.parse(readFileSync(env.PI_CACHE_MODE_STATE, 'utf8')).sessions[session.sessionId];
    assert.ok(entry.at > 0);
    assert.equal(entry.ttlSec, ttlSec);
    assert.equal(entry.mode, mode);
    assert.equal(entry.model, modelId);
    assert.equal(entry.dropped, 'test-marker');
  }
  assert.equal(requests.length, 2);
});
