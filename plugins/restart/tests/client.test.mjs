import assert from 'node:assert/strict';
import { test } from 'node:test';

// 够 client/entry.mjs 用的最小 DOM 替身。
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attrs = {}; this.textContent = ''; this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; } }
  focus() {}
  find(match) { return match(this) ? this : this.children.map(node => node.find(match)).find(Boolean); }
}
const body = new El('body');
const viewHandlers = [];
const views = [];
let reloads = 0;
let requests = [];
let respond = () => ({ status: 500, body: {} });
globalThis.document = {
  body, documentElement: { lang: 'zh-CN' }, createElement: tag => new El(tag),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { __piWebUiHost: { onViewChange: handler => { viewHandlers.push(handler); return () => {}; }, setView: view => views.push(view) } };
globalThis.location = { reload: () => { reloads++; } };
globalThis.fetch = async (url, init = {}) => {
  const request = { path: new URL(url).pathname, method: init.method || 'GET', headers: init.headers || {} };
  requests.push(request);
  const { status, body: json } = respond(request);
  return { ok: status < 400, status, json: async () => json };
};

const view = (await import('../client/entry.mjs')).default;
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const dialog = () => body.find(node => node.attrs.role === 'alertdialog');
const button = label => dialog()?.find(node => node.tag === 'button' && node.textContent === label);
const reset = () => { requests = []; views.length = 0; reloads = 0; };

const open = () => viewHandlers[0]('plugin:restart');

test('mounting alone never asks: the host mounts every plugin page at load', async () => {
  reset();
  await tick(10);
  viewHandlers[0]('terminal');
  const page = new El('div');
  const unmount = view.mount(page);
  await tick(10);
  assert.ok(page.find(node => node.tag === 'button' && node.textContent === '重启'), 'page keeps a restart button');
  assert.equal(dialog(), undefined);
  assert.equal(requests.length, 0);
  unmount();
});

test('switching to the page asks; cancel returns to the previous view without restarting', async () => {
  reset();
  open();
  assert.ok(button('重启') && button('取消'), 'confirm overlay is shown');
  button('取消').onclick();
  await tick(10);
  assert.equal(dialog(), undefined);
  assert.deepEqual(views, ['terminal']);
  assert.equal(requests.length, 0);
});

test('confirm restarts, waits for a new bootId, then reloads', async () => {
  reset();
  let statusCalls = 0;
  respond = request => {
    if (request.method === 'POST') return { status: 200, body: { bootId: 'old', restarting: true } };
    statusCalls++;
    if (statusCalls <= 2) return { status: 200, body: { bootId: 'old' } };  // 确认后的基线 + 旧进程退出前
    if (statusCalls === 3) return { status: 502, body: {} };                // 服务还没回来
    return { status: 200, body: { bootId: 'new' } };
  };
  open();
  button('重启').onclick();
  await tick(3500);
  const post = requests.find(request => request.method === 'POST');
  // 在 Node 里 import.meta.url 是 file:// 路径，所以只看相对于站点根的那一段。
  assert.match(post.path, /\/plugins-api\/restart\/restart$/);
  assert.equal(post.headers['x-pi-restart'], '1');
  assert.equal(statusCalls, 4);
  assert.equal(reloads, 1);
});

test('the page button also asks; a refused restart is reported and closing returns to the previous view', async () => {
  reset();
  dialog()?.remove();
  respond = request => (request.method === 'POST'
    ? { status: 409, body: { error: '前台运行' } }
    : { status: 200, body: { bootId: 'old' } });
  const page = new El('div');
  view.mount(page);
  page.find(node => node.tag === 'button').onclick();
  button('重启').onclick();
  await tick(20);
  assert.match(dialog().find(node => /重启失败/.test(node.textContent)).textContent, /前台运行/);
  button('关闭').onclick();
  assert.equal(dialog(), undefined);
  assert.deepEqual(views, ['terminal']);
  assert.equal(reloads, 0);
});
