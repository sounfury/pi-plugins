// 缓存模式只有 cache-mode.json 这一份全局状态；模型不匹配时直接写回 off。
import { existsSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT_DIR = join(homedir(), '.pi', 'agent');
export const MODES = ['daily', 'focus', 'off'];
const MODE_OPTIONS = [
  { value: 'daily', label: '☀ 日常 1h' },
  { value: 'focus', label: '☔ 集中 5m' },
  { value: 'off', label: '缓存插件关' },
];

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
    const c = { mode: 'daily', provider: 'magpie', modelPattern: '^(?:[^/]+/)*claude/', ...(readJson(configPath) || {}) };
    if (!MODES.includes(c.mode)) c.mode = 'daily';
    return c;
  };
  const writeMode = (mode) => {
    const raw = readJson(configPath) || {};
    if (raw.mode === mode) return;
    const tmp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...raw, mode, modeChangedAt: now() }, null, 2)}\n`);
    renameSync(tmp, configPath);
  };
  const matches = (cfg, model) => {
    if (typeof model !== 'string') return false;
    const [provider, ...rest] = model.split('/');
    try { return provider === cfg.provider && new RegExp(cfg.modelPattern, 'i').test(rest.join('/')); } catch { return false; }
  };

  let lastTracked = false;
  let lastUiKey = '';
  const syncMode = (tracked, force = false) => {
    lastTracked = tracked;
    if (!tracked && config().mode !== 'off') writeMode('off');
    const mode = config().mode;
    const key = `${mode}:${tracked}`;
    if (force || key !== lastUiKey) {
      lastUiKey = key;
      // 宿主没有 option.disabled：非匹配模型只下发 off，从状态源头让其余选项不可选。
      try {
        host.ui.update('mode', {
          value: mode,
          options: tracked ? MODE_OPTIONS : MODE_OPTIONS.filter(o => o.value === 'off'),
          hint: tracked ? '选择缓存模式' : '当前模型不在缓存配置范围内，仅可关闭',
        });
      } catch { /* manifest 条目还未注册或插件已注销 */ }
      host.broadcast({ kind: 'cache-rain:mode', mode });
    }
    return mode;
  };

  const snapshot = (clientId) => {
    const cfg = config();
    let conv = null;
    try { conv = host.getActiveConversation(clientId ? { clientId } : undefined); } catch { /* 没有对话 */ }
    const tracked = !!conv && matches(cfg, conv.model);
    const mode = syncMode(tracked);
    const sessionId = conv?.sessionId;
    const entry = sessionId ? (readJson(statePath)?.sessions?.[sessionId] ?? null) : null;
    return {
      kind: 'cache-rain', mode, now: now(), tracked,
      model: conv?.model ?? null, sessionId: sessionId ?? null,
      streaming: !!conv?.isStreaming, entry,
    };
  };
  const setMode = (mode, clientId) => {
    if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}`);
    const s = snapshot(clientId);
    if (!s.tracked && mode !== 'off') throw new Error('当前模型不在缓存配置范围内，只能使用关闭模式');
    writeMode(mode);
    syncMode(s.tracked);
  };

  snapshot();
  // 激活时 manifest 条目可能还没进入宿主注册表，稍后重新发布同一份状态。
  const again = setTimeout(() => syncMode(lastTracked, true), 1500);
  host.effect('show mode later', () => clearTimeout(again));
  const onConfigChange = () => syncMode(lastTracked);
  watchFile(configPath, { interval: 1500 }, onConfigChange);
  host.effect('watch cache-mode.json', () => unwatchFile(configPath, onConfigChange));
  if (typeof host.onClientModelChanged === 'function') {
    host.onClientModelChanged(s => { if (!s?.isSubagent) snapshot(s?.clientId); });
  }
  if (typeof host.onConversationChanged === 'function') host.onConversationChanged(() => snapshot());

  host.onMessage((payload, clientId) => {
    const reply = body => { if (clientId) host.sendTo(clientId, body); else host.broadcast(body); };
    try {
      if (payload?.action === 'mode') setMode(String(payload.value), clientId);
      reply(snapshot(clientId));
    } catch (error) {
      reply({ ...snapshot(clientId), error: error.message });
    }
  });
  host.onAttach(clientId => {
    const s = snapshot(clientId);
    // 宿主连接时先发激活期的清单；重新发布全局状态，覆盖那份旧清单。
    syncMode(lastTracked, true);
    host.sendTo(clientId, s);
  });

  const clientOf = req => {
    const id = req.query?.clientId;
    return typeof id === 'string' && /^[\w-]{1,80}$/.test(id) ? id : undefined;
  };
  if (typeof host.route === 'function') {
    host.route('GET', '/state', (req, res) => {
      res.set('Cache-Control', 'no-store').json(snapshot(clientOf(req)));
    });
    host.route('POST', '/mode', (req, res) => {
      if (req.get('x-cache-rain') !== '1') return res.status(400).json({ error: '缺少 x-cache-rain 请求头' });
      try {
        setMode(String(req.body?.mode), clientOf(req));
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
