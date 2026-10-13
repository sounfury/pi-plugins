// 无视图插件：manifest 的 preload 让这个 bundle 随页面常驻加载，只负责顶栏按钮的动作。
const API = new URL('../../../plugins-api/restart/', import.meta.url);
const POLL_MS = 1000;
const TIMEOUT_MS = 90_000;
const en = () => !/^zh/i.test(document.documentElement.lang || navigator.language || 'zh');
const t = (zh, enText) => (en() ? enText : zh);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(path, init = {}) {
  const response = await fetch(new URL(path, API), { cache: 'no-store', signal: AbortSignal.timeout(4000), ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function overlay() {
  const el = document.createElement('div');
  el.setAttribute('role', 'alertdialog');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;gap:14px;' +
    'align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg,#111) 88%,transparent);' +
    'color:var(--text,#eee);font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px;';
  const text = document.createElement('div');
  const button = document.createElement('button');
  button.type = 'button';
  button.hidden = true;
  button.style.cssText = 'border:1px solid var(--border,#555);border-radius:7px;background:var(--bg-elev,#222);' +
    'color:var(--accent,#9bf);padding:8px 14px;font:inherit;cursor:pointer;';
  el.append(text, button);
  document.body.appendChild(el);
  return {
    say(message) { text.textContent = message; },
    offer(label, onClick) { button.textContent = label; button.hidden = false; button.onclick = onClick; },
    close() { el.remove(); },
  };
}

let busy = false;
async function restart() {
  if (busy) return;
  busy = true;
  let ui;
  try {
    const before = await call('status');
    const bridge = window.__piWebUiHost;
    const title = t('重启 pi-web-ui 服务？', 'Restart the pi-web-ui service?');
    const detail = t('进行中的对话会被打断，服务恢复后自动续跑；页面会自动刷新。',
      'Running conversations are interrupted and resume once the service is back; this page reloads itself.');
    const ok = bridge?.dialogs?.confirm ? await bridge.dialogs.confirm({ title, detail }) : window.confirm(`${title}\n\n${detail}`);
    if (!ok) return;
    ui = overlay();
    ui.say(t('正在重启 pi…', 'Restarting pi…'));
    await call('restart', { method: 'POST', headers: { 'x-pi-restart': '1' } });
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      // 换了 bootId 才算新进程起来了；旧进程退出前的应答和断线期间的失败都继续等。
      const now = await call('status').catch(() => null);
      if (now && now.bootId !== before.bootId) {
        ui.say(t('已恢复，正在重新打开…', 'Back up — reloading…'));
        location.reload();
        return;
      }
    }
    ui.say(t('服务 90 秒内没有恢复，请到服务器上检查：systemctl status pi-web-ui',
      'The service did not come back within 90s — check it on the server: systemctl status pi-web-ui'));
    ui.offer(t('刷新页面', 'Reload'), () => location.reload());
  } catch (error) {
    const message = t('重启失败：', 'Restart failed: ') + (error?.message || error);
    if (ui) { ui.say(message); ui.offer(t('关闭', 'Close'), () => ui.close()); }
    else window.alert(message);
  } finally {
    busy = false;
  }
}

// 宿主桥可能晚于 bundle 就绪，等到了再注册。
(async () => {
  for (let i = 0; i < 100; i++) {
    const bridge = window.__piWebUiHost;
    if (typeof bridge?.onUiAction === 'function') { bridge.onUiAction('restart', () => { void restart(); }); return; }
    await sleep(100);
  }
  console.error('[plugin:restart] 宿主桥未就绪，重启按钮不可用');
})();

export default {};
