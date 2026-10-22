// cache-rain 浏览器端：集中模式（5m 缓存）下，整个页面下一场雨。
// 梗出自《飙马野郎》布莱克摩尔的替身 Catch the Rainbow：用雨滴堵住致命伤，雨一停就会死。
// 雨还在下 = 缓存还活着。最后 60 秒雨势转弱、「ゴゴゴ」压上来、屏幕下方轮流浮出「覺悟」独白；
// 归零时雨停——『暴雨結束之時』『就是我的死期』+ To Be Continued。赶在最后续上，则「Catch the Rainbow！」。
//
// 宿主在页面加载时会 import 每个插件的 client/entry.mjs，但只有打开插件页时才调 mount，
// 切走就卸载。所以雨幕挂在模块顶层（window 上只留一份），状态走插件的 HTTP 路由轮询；
// mount 只画插件页里的说明和按钮。

const API = new URL('../../../plugins-api/cache-rain/', import.meta.url);
const POLL_MS = 2000;
const WARN_SEC = 60;
const COLLAPSE_KEY = 'pi-cache-rain:collapsed';
const LINES = {
  title: 'Catch the Rainbow · 5m',
  waiting: '烏雲已經聚攚。第一滴雨落下，就是開始。',
  raining: '『雨停之後，我就會死。』',
  streaming: '『在這暴風雨停息之前。』',
  warn: '『暴雨結束之時……』',
  dead: '『就是我的死期。』',
  daily1h: '上一場是 1h 的雨。下一条消息，换成 5 分钟的。',
  toFocus: '『我將全心全意將其奪回，在這暴風雨停息之前。』',
  toDaily: '雨過天晴。這一次，我能活一個小時。',
  reborn: '「すいませェん……」雨又下起來了。（缓存已从头重写）',
  rainbow: '『因為【覺悟】能夠驅散【絕望】！！！』',
  bannerBig: '『暴雨結束之時』',
  bannerDead: '『就是我的死期』',
  bannerSmall: '5 分钟缓存已经过期 · 下一条消息将把整段上下文从头重写',
  // 最后 60 秒屏幕下方轮流浮出的独白
  monologue: [
    '『即便知曉暴風雨停止之後自己將迎來死亡』',
    '『只要擁有想要挽回什麼的【覺悟】』',
    '『死亡也沒什麼好怕的了』',
    '『因為【覺悟】能夠驅散【絕望】！！！』',
  ],
};

const CSS = `
#pi-cache-rain { position: fixed; inset: 0; pointer-events: none; z-index: 9000; font-family: system-ui, sans-serif; }
#pi-cache-rain canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; transition: opacity 1.6s ease; }
#pi-cache-rain.raining canvas { opacity: 1; }
#pi-cache-rain .cr-chip { position: absolute; top: 58px; right: 16px; pointer-events: auto; cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 12px; padding: 9px 15px; border-radius: 12px;
  background: color-mix(in srgb, var(--bg-elev, #1d2230) 86%, transparent); backdrop-filter: blur(6px);
  border: 1px solid color-mix(in srgb, #7fa6ff 45%, transparent); color: var(--text, #e8ecf4);
  box-shadow: 0 6px 22px rgba(0,0,0,.25); transition: border-color .4s, transform .25s, opacity .4s; }
#pi-cache-rain .cr-chip[hidden] { display: none; }
#pi-cache-rain .cr-icon { font-size: 20px; line-height: 1; }
#pi-cache-rain .cr-time { font: 700 21px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .5px; min-width: 3.4em; text-align: right; }
#pi-cache-rain .cr-text { display: flex; flex-direction: column; gap: 3px; }
#pi-cache-rain .cr-title { font-size: 11px; letter-spacing: 2px; opacity: .6; }
#pi-cache-rain .cr-line { font: 700 14px/1.2 "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "Hiragino Mincho ProN", serif; letter-spacing: 1px; }
#pi-cache-rain .cr-chip.collapsed .cr-text { display: none; }
#pi-cache-rain .cr-chip.warn { border-color: #ff5a6a; animation: cr-pulse 1s ease-in-out infinite; }
#pi-cache-rain .cr-chip.warn .cr-time { color: #ff7a86; }
#pi-cache-rain .cr-chip.dead { border-color: #8a8f99; opacity: .85; }
#pi-cache-rain .cr-chip.bump { transform: scale(1.06); }
@keyframes cr-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,90,106,0); } 50% { box-shadow: 0 0 0 6px rgba(255,90,106,.22); } }
#pi-cache-rain .cr-go { position: absolute; font: 900 30px/1 "Hiragino Mincho ProN", "Yu Mincho", serif; color: #b44cff;
  text-shadow: 2px 2px 0 #2a0040, -1px -1px 0 #f2c6ff; animation: cr-go 1.8s ease-out forwards; }
@keyframes cr-go { 0% { opacity: 0; transform: translate(0,0) scale(.6) rotate(-8deg); }
  20% { opacity: 1; } 100% { opacity: 0; transform: translate(var(--dx), -70px) scale(1.25) rotate(8deg); } }
#pi-cache-rain .cr-banner { position: absolute; left: 50%; bottom: 24%; transform: translateX(-50%); text-align: center; white-space: nowrap;
  color: #f4f1e8; text-shadow: 0 2px 14px rgba(0,0,0,.75), 0 0 2px #000; opacity: 0; transition: opacity .9s; }
#pi-cache-rain .cr-banner.show { opacity: 1; }
#pi-cache-rain .cr-banner .big { font: 900 44px/1.35 "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "Hiragino Mincho ProN", serif; letter-spacing: 8px; min-height: 1.35em; }
#pi-cache-rain .cr-banner .big span { display: inline-block; opacity: 0; transform: translateY(10px); filter: blur(4px);
  animation: cr-char .7s ease-out forwards; }
@keyframes cr-char { to { opacity: 1; transform: none; filter: none; } }
#pi-cache-rain .cr-banner .small { margin-top: 10px; font-size: 13px; letter-spacing: 1px; opacity: .78; }
#pi-cache-rain .cr-tbc { position: absolute; left: 24px; bottom: 26px; display: flex; align-items: center; transform: translateX(-120%);
  transition: transform .9s cubic-bezier(.2,.9,.2,1.05), opacity .8s; opacity: 0; filter: drop-shadow(0 3px 6px rgba(0,0,0,.5)) sepia(.35); }
#pi-cache-rain .cr-tbc.show { transform: translateX(0); opacity: 1; }
#pi-cache-rain .cr-tbc .arrow { width: 0; height: 0; border-top: 26px solid transparent; border-bottom: 26px solid transparent; border-right: 34px solid #c9a24a; }
#pi-cache-rain .cr-tbc .body { background: #c9a24a; color: #2b1d08; padding: 8px 18px 8px 10px; font: italic 900 22px/36px Georgia, "Times New Roman", serif;
  letter-spacing: 1px; border: 2px solid #3a2a10; border-left: none; }
#pi-cache-rain .cr-rainbow { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
  animation: cr-flash 2.2s ease-out forwards; }
#pi-cache-rain .cr-rainbow::before { content: ""; position: absolute; left: 50%; top: 62%; width: 150vmax; height: 150vmax; transform: translate(-50%, 0) scale(.2);
  border-radius: 50%; background: radial-gradient(circle, transparent 54%, rgba(255,60,60,.55) 55%, rgba(255,160,40,.55) 57%, rgba(255,230,60,.55) 59%,
  rgba(70,220,110,.55) 61%, rgba(60,160,255,.55) 63%, rgba(120,90,255,.55) 65%, transparent 67%); animation: cr-arc 2.2s cubic-bezier(.2,.8,.2,1) forwards; }
#pi-cache-rain .cr-rainbow span { position: relative; font: italic 900 60px/1 Georgia, "Times New Roman", serif; letter-spacing: 2px;
  background: linear-gradient(90deg, #ff5a5a, #ffb02e, #ffe94a, #4be37a, #4aa8ff, #9a6bff); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(3px 3px 0 #000); animation: cr-pop 2.2s ease-out forwards; }
@keyframes cr-flash { 0% { opacity: 0; } 10% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }
@keyframes cr-arc { to { transform: translate(-50%, 0) scale(1); } }
@keyframes cr-pop { 0% { transform: scale(.6); } 18% { transform: scale(1.08); } 30% { transform: scale(1); } }
#pi-cache-rain .cr-mono { position: absolute; left: 50%; bottom: 30%; transform: translateX(-50%); white-space: nowrap; color: #f4f1e8;
  font: 900 26px/1.4 "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif; letter-spacing: 4px;
  text-shadow: 0 2px 12px rgba(0,0,0,.8), 0 0 2px #000; opacity: 0; transition: opacity .8s; }
#pi-cache-rain .cr-mono.show { opacity: .92; }
#pi-cache-rain .cr-mono span { display: inline-block; opacity: 0; filter: blur(3px); animation: cr-char .6s ease-out forwards; }
#pi-cache-rain .cr-toast { position: absolute; top: 58px; left: 50%; transform: translate(-50%, -10px); opacity: 0; padding: 9px 18px; border-radius: 10px;
  background: color-mix(in srgb, var(--bg-elev, #1d2230) 92%, transparent); color: var(--text, #eee);
  font: 700 15px/1.4 "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif; letter-spacing: 1px; transition: opacity .4s, transform .4s; }
#pi-cache-rain .cr-toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (prefers-reduced-motion: reduce) {
  #pi-cache-rain canvas, #pi-cache-rain .cr-go { display: none; }
  #pi-cache-rain .cr-chip.warn { animation: none; }
  #pi-cache-rain .cr-rainbow { animation: none; opacity: 0; }
  #pi-cache-rain .cr-mono span { animation: none; opacity: 1; filter: none; }
  #pi-cache-rain .cr-banner .big span { animation: none; opacity: 1; transform: none; filter: none; }
}
[data-pi-cache-rain] { padding: 20px; max-width: 640px; line-height: 1.7; color: var(--text, #e8ecf4); }
[data-pi-cache-rain] h2 { margin: 0 0 4px; font: 900 22px/1.4 "Songti SC", "Noto Serif CJK SC", serif; letter-spacing: 2px; }
[data-pi-cache-rain] .motto { margin: 0 0 14px; font: 700 15px/1.4 "Songti SC", "Noto Serif CJK SC", serif; opacity: .8; letter-spacing: 1px; }
[data-pi-cache-rain] .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
[data-pi-cache-rain] button { border: 1px solid var(--border, #555); border-radius: 8px; background: var(--bg-elev, #222); color: var(--text, #eee);
  padding: 6px 14px; font: inherit; cursor: pointer; }
[data-pi-cache-rain] button.on { border-color: var(--accent, #9bf); color: var(--accent, #9bf); }
[data-pi-cache-rain] .muted { opacity: .7; font-size: 13px; }
`;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const fmt = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** pi-web-ui 给每个标签页的 id；带上它，服务端才知道「这个标签页正在看哪个对话」 */
const clientId = () => { try { return sessionStorage.getItem('pi-web-client-id') || ''; } catch { return ''; } };

async function api(path, init = {}) {
  const url = new URL(path, API);
  const id = clientId();
  if (id) url.searchParams.set('clientId', id);
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000), ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** 雨：canvas 上的斜线雨滴 + 落地小水花，强度 0..1 */
function createRain(canvas) {
  const g = canvas.getContext('2d');
  let drops = [];
  let splashes = [];
  let target = 0;
  let level = 0;
  let raf = 0;
  let w = 0;
  let h = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const spawn = () => ({
    x: Math.random() * (w + 200) - 100,
    y: -20 - Math.random() * h,
    len: 10 + Math.random() * 16,
    v: 9 + Math.random() * 9,
    a: 0.18 + Math.random() * 0.3,
  });
  const frame = () => {
    raf = 0;
    level += (target - level) * 0.03;
    if (Math.abs(target - level) < 0.002) level = target;
    const want = Math.round(170 * level);
    while (drops.length < want) drops.push(spawn());
    if (drops.length > want) drops.length = want;
    g.clearRect(0, 0, w, h);
    g.lineCap = 'round';
    g.lineWidth = 1.1;
    for (const d of drops) {
      d.y += d.v; d.x -= d.v * 0.18;
      if (d.y > h) {
        if (Math.random() < 0.35) splashes.push({ x: d.x, y: h - 2 - Math.random() * 6, r: 1, life: 1 });
        Object.assign(d, spawn(), { y: -20 });
      }
      g.strokeStyle = `rgba(160,190,255,${d.a})`;
      g.beginPath(); g.moveTo(d.x, d.y); g.lineTo(d.x + d.len * 0.18, d.y - d.len); g.stroke();
    }
    splashes = splashes.filter((s) => (s.life -= 0.06) > 0);
    for (const s of splashes) {
      s.r += 0.6;
      g.strokeStyle = `rgba(170,200,255,${0.35 * s.life})`;
      g.beginPath(); g.ellipse(s.x, s.y, s.r * 1.8, s.r * 0.5, 0, 0, Math.PI * 2); g.stroke();
    }
    if (level > 0 || drops.length || splashes.length) schedule();
  };
  const schedule = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };
  const onVis = () => { if (!document.hidden) schedule(); };
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVis);
  resize();
  return {
    set(next) { target = Math.max(0, Math.min(1, next)); if (target > 0 || level > 0) schedule(); },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}

function createOverlay(doc) {
  doc.getElementById('pi-cache-rain')?.remove();
  doc.getElementById('pi-cache-rain-css')?.remove();
  const style = doc.createElement('style');
  style.id = 'pi-cache-rain-css';
  style.textContent = CSS;
  doc.head.appendChild(style);
  const root = doc.createElement('div');
  root.id = 'pi-cache-rain';
  root.innerHTML = `
    <canvas></canvas>
    <div class="cr-toast"></div>
    <div class="cr-mono"></div>
    <div class="cr-banner"><div class="big"></div><div class="small"></div></div>
    <div class="cr-tbc"><div class="arrow"></div><div class="body">To Be Continued</div></div>
    <div class="cr-chip" hidden title="点一下收起 / 展开">
      <span class="cr-icon">☔</span>
      <span class="cr-text"><span class="cr-title"></span><span class="cr-line"></span></span>
      <span class="cr-time">5:00</span>
    </div>`;
  doc.body.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const chip = $('.cr-chip');
  $('.cr-title').textContent = LINES.title;
  if (localStorage.getItem(COLLAPSE_KEY) === '1') chip.classList.add('collapsed');
  chip.addEventListener('click', () => {
    chip.classList.toggle('collapsed');
    localStorage.setItem(COLLAPSE_KEY, chip.classList.contains('collapsed') ? '1' : '0');
  });
  const rain = createRain($('canvas'));
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };

  let toastTimer = 0;
  let goTimer = 0;
  let deadShownFor = 0;
  let lastAt = 0;
  let wasWarn = false;
  let lastMode = null;

  const toast = (text) => {
    const el = $('.cr-toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = later(3200, () => el.classList.remove('show'));
  };
  /** 字一个一个浮出来 */
  const typeInto = (el, text, step) => {
    el.replaceChildren(...[...text].map((ch, i) => {
      const span = doc.createElement('span');
      span.textContent = ch;
      span.style.animationDelay = `${i * step}s`;
      return span;
    }));
  };
  const typeBig = (text) => typeInto($('.cr-banner .big'), text, 0.14);
  // 最后 60 秒的独白：按剩余时间分段，每段一句
  let monoIdx = -1;
  const monologue = (left, warnSec = WARN_SEC) => {
    const el = $('.cr-mono');
    if (left === null) { el.classList.remove('show'); monoIdx = -1; return; }
    const n = LINES.monologue.length;
    const idx = Math.max(0, Math.min(n - 1, Math.floor((warnSec - left) / (warnSec / n))));
    if (idx !== monoIdx) {
      monoIdx = idx;
      typeInto(el, LINES.monologue[idx], 0.06);
      el.classList.add('show');
    }
  };
  const menacing = () => {
    if (reducedMotion()) return;
    const r = chip.getBoundingClientRect();
    for (let i = 0; i < 2; i++) {
      const go = doc.createElement('span');
      go.className = 'cr-go';
      go.textContent = 'ゴ';
      go.style.left = `${r.left - 40 + Math.random() * (r.width + 20)}px`;
      go.style.top = `${r.bottom + 4 + Math.random() * 30}px`;
      go.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
      root.appendChild(go);
      later(1900, () => go.remove());
    }
  };
  // 赶在雨停前续上：一道彩虹 + Catch the Rainbow
  const catchTheRainbow = () => {
    const el = doc.createElement('div');
    el.className = 'cr-rainbow';
    el.innerHTML = '<span>Catch the Rainbow！</span>';
    root.appendChild(el);
    later(2300, () => el.remove());
    later(700, () => toast(LINES.rainbow));
  };
  const rainStops = () => {
    rain.set(0);
    const banner = $('.cr-banner');
    typeBig(LINES.bannerBig);
    banner.querySelector('.small').textContent = '';
    banner.classList.add('show');
    later(2600, () => typeBig(LINES.bannerDead));
    later(4600, () => { banner.querySelector('.small').textContent = LINES.bannerSmall; $('.cr-tbc').classList.add('show'); });
    later(11000, () => { banner.classList.remove('show'); $('.cr-tbc').classList.remove('show'); });
  };

  /** 根据状态和当前时间刷新画面；state 为空 = 不显示 */
  const render = (s, nowMs) => {
    if (lastMode !== null && s && s.mode !== lastMode) {
      if (s.mode === 'focus') toast(LINES.toFocus);
      else if (lastMode === 'focus') toast(LINES.toDaily);
    }
    if (s) lastMode = s.mode;
    if (!s || s.mode !== 'focus' || !s.tracked) {
      monologue(null);
      chip.hidden = true;
      rain.set(0);
      root.classList.remove('raining');
      clearInterval(goTimer); goTimer = 0;
      return;
    }
    chip.hidden = false;
    root.classList.add('raining');
    const e = s.entry;
    const time = $('.cr-time');
    const line = $('.cr-line');
    const icon = $('.cr-icon');
    chip.classList.remove('warn', 'dead');
    if (!e?.at) {
      monologue(null);
      icon.textContent = '☁';
      time.textContent = '—';
      line.textContent = LINES.waiting;
      rain.set(0);
      return;
    }
    if (lastAt && e.at > lastAt) {
      if (wasWarn) catchTheRainbow();
      else if (deadShownFor === lastAt) toast(LINES.reborn);
      chip.classList.add('bump');
      later(260, () => chip.classList.remove('bump'));
    }
    lastAt = e.at;
    const left = (e.at + e.ttlSec * 1000 - nowMs) / 1000;
    const rainy = e.mode === 'focus';
    if (left <= 0) {
      icon.textContent = '☁';
      time.textContent = '0:00';
      line.textContent = LINES.dead;
      chip.classList.add('dead');
      monologue(null);
      wasWarn = false;
      clearInterval(goTimer); goTimer = 0;
      // 只为「这一场雨」演一次；刷新页面时早就停了的雨不重演
      if (deadShownFor !== e.at) {
        deadShownFor = e.at;
        if (left > -15) rainStops(); else rain.set(0);
      }
      return;
    }
    icon.textContent = rainy ? '☔' : '☀';
    time.textContent = fmt(left);
    const warnSec = s.warnSec ?? WARN_SEC; // 预览时压缩
    const warn = rainy && left <= warnSec && !s.streaming;
    if (warn) {
      chip.classList.add('warn');
      line.textContent = LINES.warn;
      if (!goTimer) { menacing(); goTimer = setInterval(menacing, 1400); }
      monologue(left, warnSec);
    } else {
      monologue(null);
      line.textContent = !rainy ? LINES.daily1h : s.streaming ? LINES.streaming : LINES.raining;
      clearInterval(goTimer); goTimer = 0;
    }
    wasWarn = warn;
    rain.set(!rainy || reducedMotion() ? 0 : warn ? 0.15 + 0.6 * (left / warnSec) : s.streaming ? 1 : 0.8);
  };

  return {
    render,
    destroy() {
      for (const t of timers) clearTimeout(t);
      clearInterval(goTimer);
      clearTimeout(toastTimer);
      rain.destroy();
      root.remove();
      style.remove();
    },
  };
}

/** 全局雨幕：页面加载（宿主 import 本模块）时启动，window 上只留一份 */
function start() {
  try { window.__piCacheRain?.destroy?.(); } catch { /* 旧版本已失效 */ }
  const overlay = createOverlay(document);
  const listeners = new Set();
  let state = null;
  let skew = 0; // 服务端时间 - 本机时间
  let demoUntil = 0;
  let demoState = null;
  let dead = false;

  const tick = () => {
    const now = Date.now() + skew;
    if (demoUntil && Date.now() < demoUntil) overlay.render(demoState, now);
    else { demoUntil = 0; overlay.render(state, now); }
  };
  const accept = (s) => {
    if (dead || !s || s.kind !== 'cache-rain') return;
    skew = (s.now ?? Date.now()) - Date.now();
    state = s;
    // 宿主重扫插件时会把下拉的值还原成 manifest 里的默认值，这里按实际模式校正
    const sel = document.querySelector('select[aria-label="缓存"]');
    if (sel && sel.value !== s.mode && [...sel.options].some((o) => o.value === s.mode)) sel.value = s.mode;
    for (const fn of listeners) { try { fn(s); } catch { /* 页面已卸载 */ } }
    tick();
  };
  const poll = async () => {
    if (dead || document.hidden) return;
    try { accept(await api('state')); } catch { /* 服务重启中，下次再试 */ }
  };
  const setMode = async (mode) => {
    try {
      accept(await api('mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cache-rain': '1' },
        body: JSON.stringify({ mode }),
      }));
    } catch (error) { console.error('[plugin:cache-rain] 切换模式失败:', error); }
  };

  // 输入框旁「缓存」下拉
  let offAction = null;
  let tries = 0;
  const hook = () => {
    if (dead) return;
    const bridge = window.__piWebUiHost;
    if (typeof bridge?.onUiAction === 'function') {
      offAction = bridge.onUiAction('cache-rain:mode', (_id, value) => { if (value) void setMode(value); });
    } else if (tries++ < 200) setTimeout(hook, 100);
  };
  hook();

  void poll();
  const pollTimer = setInterval(poll, POLL_MS);
  const tickTimer = setInterval(tick, 250);
  const onVis = () => { if (!document.hidden) void poll(); };
  document.addEventListener('visibilitychange', onVis);

  window.__piCacheRain = {
    get state() { return state; },
    setMode,
    subscribe(fn) { listeners.add(fn); if (state) fn(state); return () => listeners.delete(fn); },
    /** 预览：rainbow=false 演到雨停；rainbow=true 在独白中途续上，演 Catch the Rainbow */
    demo(rainbow = false) {
      const now = Date.now() + skew;
      const warnSec = 16; // 最后 60 秒压缩成 16 秒，4 句独白每句 4 秒
      demoState = { kind: 'cache-rain', mode: 'focus', tracked: true, streaming: false, warnSec,
        entry: { at: now - (300 - warnSec) * 1000, ttlSec: 300, mode: 'focus' } };
      demoUntil = Date.now() + (rainbow ? 16_000 : 32_000);
      if (rainbow) {
        setTimeout(() => {
          if (!demoUntil) return;
          demoState = { ...demoState, entry: { ...demoState.entry, at: Date.now() + skew } };
        }, 9000);
      }
      tick();
    },
    destroy() {
      dead = true;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      document.removeEventListener('visibilitychange', onVis);
      try { offAction?.(); } catch { /* 宿主已清理 */ }
      listeners.clear();
      overlay.destroy();
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.body) start();
else if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', start, { once: true });

const MODE_NAMES = { daily: '☀ 日常 · 1h', focus: '☔ 集中 · 5m', off: '关闭（交给 Magpie，默认 1h）' };

/** 插件页：说明 + 切换 + 预览 */
export default {
  mount(el) {
    const rain = window.__piCacheRain;
    el.setAttribute('data-pi-cache-rain', '');
    el.innerHTML = `
      <h2>☔ 缓存雨</h2>
      <p class="motto">『雨停之後，我就會死。』<br>『因為【覺悟】能夠驅散【絕望】！！！』</p>
      <div>当前模式：<b class="mode">…</b> <span class="muted state"></span></div>
      <div class="row">
        <button data-mode="daily">☀ 日常 · 1h</button>
        <button data-mode="focus">☔ 集中 · 5m</button>
        <button data-mode="off">关闭</button>
      </div>
      <div class="row"><button class="demo">预览：暴雨結束之時</button><button class="demo-rainbow">预览：Catch the Rainbow</button></div>
      <p class="muted">集中模式下，经 Magpie 的 Claude 只缓存 5 分钟，每次请求续命 5 分钟。连续干活时比 1h 缓存更省额度。
      页面上的雨就是缓存：雨还在下，缓存就还活着；最后 60 秒雨势转弱；倒计时归零，雨停。
      右上角的牌子点一下可以收起。也可以用输入框旁的「缓存」下拉，或 pi 命令 <code>/cache-mode</code> 切换。</p>`;
    for (const b of el.querySelectorAll('[data-mode]')) b.addEventListener('click', () => void rain?.setMode(b.dataset.mode));
    el.querySelector('.demo').addEventListener('click', () => rain?.demo(false));
    el.querySelector('.demo-rainbow').addEventListener('click', () => rain?.demo(true));
    const update = (s) => {
      el.querySelector('.mode').textContent = MODE_NAMES[s.mode] ?? s.mode;
      for (const b of el.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === s.mode);
      el.querySelector('.state').textContent = !s.tracked ? '（当前对话不是 Magpie 的 Claude，这里不下雨）'
        : s.entry?.at ? `（本对话上次请求 ${new Date(s.entry.at).toLocaleTimeString()}，${s.entry.ttlSec / 60} 分钟缓存${s.entry.dropped ? `；丢掉的缓存点 ${s.entry.dropped}` : ''}）`
          : '（本对话还没有请求）';
    };
    const off = rain?.subscribe(update);
    return () => { off?.(); el.textContent = ''; };
  },
};
