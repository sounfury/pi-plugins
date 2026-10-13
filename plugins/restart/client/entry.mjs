// 这个插件的页面本身就是「重启」动作：从插件菜单或钉在顶栏的按钮切到它，就弹出重启确认。
const API = new URL('../../../plugins-api/restart/', import.meta.url);
const SELF = 'plugin:restart';
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

// 宿主在页面加载时就把所有插件页挂进隐藏面板，所以不能在 mount 里弹确认，
// 只在视图真的切到本页时才弹。顺便记住之前所在的视图：取消或出错后回到那里。
let previousView = 'chat';
(async () => {
  for (let i = 0; i < 100; i++) {
    const bridge = window.__piWebUiHost;
    if (typeof bridge?.onViewChange === 'function') {
      // 插件重载后旧模块的监听还挂着，先摘掉，免得弹两层。
      try { window.__piRestartOffView?.(); } catch { /* 旧监听已失效 */ }
      window.__piRestartOffView = bridge.onViewChange(view => {
        if (view === SELF) void restart();
        else if (view) previousView = view;
      });
      return;
    }
    await sleep(100);
  }
})();
function leave() {
  try { window.__piWebUiHost?.setView?.(previousView); } catch { /* 留在本页，页面上还有重启按钮 */ }
}

function makeButton(label, primary, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = 'border:1px solid var(--border,#555);border-radius:7px;background:var(--bg-elev,#222);' +
    `color:var(${primary ? '--accent,#9bf' : '--text,#eee'});padding:8px 16px;font:inherit;cursor:pointer;`;
  button.onclick = onClick;
  return button;
}

function overlay() {
  const el = document.createElement('div');
  el.setAttribute('role', 'alertdialog');
  el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;gap:14px;' +
    'align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg,#111) 88%,transparent);' +
    'color:var(--text,#eee);font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px;';
  const text = document.createElement('div');
  text.style.cssText = 'max-width:420px;white-space:pre-line;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;';
  el.append(text, actions);
  document.body.appendChild(el);
  const ui = {
    say(message) { text.textContent = message; actions.replaceChildren(); },
    offer(label, onClick) { actions.appendChild(makeButton(label, true, onClick)); },
    ask(message, yes, no) {
      ui.say(message);
      return new Promise(resolve => {
        const done = value => { document.removeEventListener('keydown', onKey, true); resolve(value); };
        const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); done(false); } };
        document.addEventListener('keydown', onKey, true);
        actions.appendChild(makeButton(no, false, () => done(false)));
        actions.appendChild(makeButton(yes, true, () => done(true))).focus();
      });
    },
    close() { el.remove(); },
  };
  return ui;
}

let busy = false;
async function restart() {
  if (busy) return;
  busy = true;
  const ui = overlay();
  try {
    const ok = await ui.ask(
      t('重启 pi-web-ui 服务？\n进行中的对话会被打断，服务恢复后自动续跑；页面会自动刷新。',
        'Restart the pi-web-ui service?\nRunning conversations are interrupted and resume once the service is back; this page reloads itself.'),
      t('重启', 'Restart'), t('取消', 'Cancel'));
    if (!ok) { ui.close(); leave(); return; }
    ui.say(t('正在重启 pi…', 'Restarting pi…'));
    const before = await call('status');
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
    ui.say(t('重启失败：', 'Restart failed: ') + (error?.message || error));
    ui.offer(t('关闭', 'Close'), () => { ui.close(); leave(); });
  } finally {
    busy = false;
  }
}

export default {
  mount(el) {
    // 确认框被取消后若宿主没能切回原视图，这一页还留着一个按钮可以再点。
    const page = document.createElement('div');
    page.style.cssText = 'padding:24px;color:var(--text,#eee);font:14px/1.6 system-ui,sans-serif;';
    const hint = document.createElement('p');
    hint.style.cssText = 'margin:0 0 12px;color:var(--text-dim,#aaa);';
    hint.textContent = t('重启 pi-web-ui 服务（连同其中的 pi 和扩展），恢复后页面自动刷新。',
      'Restart the pi-web-ui service (pi and its extensions included); this page reloads once it is back.');
    page.append(hint, makeButton(t('重启', 'Restart'), true, () => { void restart(); }));
    el.replaceChildren(page);
    return () => page.remove();
  },
};
