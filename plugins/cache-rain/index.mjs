// cache-rain 服务端：读 cache-mode 扩展的模式文件和请求记录，告诉浏览器“雨还能下多久”。
// 模式切换写回同一个模式文件，pi 扩展每次请求都会重新读，立即生效。
import { existsSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT_DIR = join(homedir(), '.pi', 'agent');
export const MODES = ['daily', 'focus', 'off'];

function readJson(path) {
  try { if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')); } catch { /* 坏 JSON 当不存在 */ }
  return undefined;
}

export function createCacheRain(host, options = {}) {
  const env = options.env || process.env;
  const configPath = env.PI_CACHE_MODE_CONFIG || join(AGENT_DIR, 'cache-mode.json');
  const statePath = env.PI_CACHE_MODE_STATE || join(AGENT_DIR, 'cache-mode.state.json');
  const now = options.now || (() => Date.now());

  const config = () => {
    const c = { mode: 'daily', provider: 'magpie', modelPattern: '^claude/', ...(readJson(configPath) || {}) };
    if (!MODES.includes(c.mode)) c.mode = 'daily';
    return c;
  };
  const setMode = (mode) => {
    if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}`);
    const raw = readJson(configPath) || {};
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...raw, mode }, null, 2)}\n`);
    renameSync(tmp, configPath);
  };
  const matches = (cfg, model) => {
    if (typeof model !== 'string') return false;
    const [provider, ...rest] = model.split('/');
    try { return provider === cfg.provider && new RegExp(cfg.modelPattern, 'i').test(rest.join('/')); } catch { return false; }
  };

  /** 某个标签页正在看的对话的缓存状态 */
  const snapshot = (clientId) => {
    const cfg = config();
    let conv = null;
    try { conv = host.getActiveConversation(clientId ? { clientId } : undefined); } catch { /* 拿不到就当没有对话 */ }
    const sessionId = conv?.sessionId;
    const entry = sessionId ? (readJson(statePath)?.sessions?.[sessionId] ?? null) : null;
    return {
      kind: 'cache-rain',
      mode: cfg.mode,
      now: now(),
      tracked: !!conv && matches(cfg, conv.model),
      model: conv?.model ?? null,
      sessionId: sessionId ?? null,
      streaming: !!conv?.isStreaming,
      entry,
    };
  };

  // 「缓存」下拉声明在 manifest.json 的 ui 里（运行时 ui.register 的条目这版宿主不下发），
  // 这里只把当前模式写到它的 value 上。
  let lastMode = config().mode;
  const showMode = (mode) => { try { host.ui.update('mode', { value: mode }); } catch { /* 条目已注销 */ } };
  showMode(lastMode);
  // 激活时 manifest 条目可能还没进宿主的 UI 表，稍后再写一次
  const again = setTimeout(() => showMode(config().mode), 1500);
  host.effect('show mode later', () => clearTimeout(again));

  const pushAll = () => host.broadcast({ kind: 'cache-rain:mode', mode: config().mode });
  const onConfigChange = () => {
    const mode = config().mode;
    if (mode === lastMode) return;
    lastMode = mode;
    showMode(mode);
    pushAll();
  };
  // pi 扩展的 /cache-mode 命令也会改这个文件
  watchFile(configPath, { interval: 1500 }, onConfigChange);
  host.effect('watch cache-mode.json', () => unwatchFile(configPath, onConfigChange));

  host.onMessage((payload, clientId) => {
    const reply = (body) => { if (clientId) host.sendTo(clientId, body); else host.broadcast(body); };
    try {
      if (payload?.action === 'mode') {
        setMode(String(payload.value));
        onConfigChange();
      }
      reply(snapshot(clientId));
    } catch (error) {
      reply({ ...snapshot(clientId), error: error.message });
    }
  });
  host.onAttach((clientId) => host.sendTo(clientId, snapshot(clientId)));

  // 页面加载时宿主只导入 client/entry.mjs、不调 mount，没有 ctx 通道，全局的雨幕走 HTTP。
  // 浏览器带上自己的 clientId（pi-web-ui 存在 sessionStorage）就取该标签页正在看的对话；
  // 不带时取「最近活跃的非子代理对话」。
  const clientOf = (req) => {
    const id = req.query?.clientId;
    return typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? id : undefined;
  };
  if (typeof host.route === 'function') {
    host.route('GET', '/state', (req, res) => {
      res.set('Cache-Control', 'no-store').json(snapshot(clientOf(req)));
    });
    host.route('POST', '/mode', (req, res) => {
      // 自定义请求头：跨站页面没法用简单请求改模式
      if (req.get('x-cache-rain') !== '1') return res.status(400).json({ error: '缺少 x-cache-rain 请求头' });
      try {
        setMode(String(req.body?.mode));
        onConfigChange();
        res.json(snapshot(clientOf(req)));
      } catch (error) {
        res.status(400).json({ ...snapshot(clientOf(req)), error: error.message });
      }
    });
  }

  return { snapshot, setMode, config };
}

export default {
  async activate(host) { createCacheRain(host); },
};
