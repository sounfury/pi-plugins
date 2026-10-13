import { randomUUID } from 'node:crypto';

// 只有被 supervisor 托管的实例退出后才会回来（systemd 设 INVOCATION_ID，
// 新版 `pi-web-ui server install` 另外写 PI_WEB_LAUNCHED_BY=service）。
export function isSupervised(env = process.env) {
  return env.PI_WEB_LAUNCHED_BY === 'service' || !!env.INVOCATION_ID;
}

export function createRestart(host, options = {}) {
  const env = options.env || process.env;
  // SIGTERM 走宿主自己的优雅关机：先记下进行中的对话，重启后自动续跑。
  const exit = options.exit || (() => process.kill(process.pid, 'SIGTERM'));
  const delayMs = options.delayMs ?? 300;
  const bootId = options.bootId || randomUUID();
  let pending = false;
  const status = () => ({ bootId, supervised: isSupervised(env), restarting: pending });

  host.route('GET', '/status', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(status());
  });
  host.route('POST', '/restart', (req, res) => {
    // 自定义请求头让跨站页面无法用简单请求触发重启。
    if (req.get('x-pi-restart') !== '1') return res.status(400).json({ error: '缺少 x-pi-restart 请求头' });
    if (!isSupervised(env)) {
      return res.status(409).json({ error: '当前实例不是由系统服务托管的（前台运行），退出后不会自动回来；请在终端里重启，或先执行 pi-web-ui server install。' });
    }
    if (!pending) {
      pending = true;
      // 先让这次响应发出去再退出。
      const timer = setTimeout(exit, delayMs);
      host.effect('pending restart', () => clearTimeout(timer));
    }
    res.json(status());
  });
  return { status };
}

export default {
  async activate(host) { createRestart(host); },
};
