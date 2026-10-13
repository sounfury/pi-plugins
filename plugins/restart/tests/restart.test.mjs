import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRestart, isSupervised } from '../index.mjs';

function setup(env) {
  const routes = new Map();
  const ui = [];
  let exits = 0;
  const host = {
    ui: { register: item => ui.push(item) },
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    effect: () => {},
  };
  createRestart(host, { env, exit: () => { exits++; }, delayMs: 0, bootId: 'boot-1' });
  const request = async (key, headers = {}) => {
    const res = { code: 200, body: null, set() { return res; }, status(code) { res.code = code; return res; }, json(body) { res.body = body; return res; } };
    routes.get(key)({ get: name => headers[name] }, res);
    await new Promise(resolve => setTimeout(resolve, 5));
    return res;
  };
  return { ui, request, exits: () => exits };
}

test('isSupervised', () => {
  assert.equal(isSupervised({}), false);
  assert.equal(isSupervised({ INVOCATION_ID: 'x' }), true);
  assert.equal(isSupervised({ PI_WEB_LAUNCHED_BY: 'service' }), true);
});

test('registers a top bar action and reports status', async () => {
  const { ui, request } = setup({ INVOCATION_ID: 'x' });
  assert.equal(ui[0].slot, 'topbar.primary');
  assert.equal(ui[0].action, 'restart');
  assert.deepEqual((await request('GET /status')).body, { bootId: 'boot-1', supervised: true, restarting: false });
});

test('restart exits once when supervised', async () => {
  const { request, exits } = setup({ INVOCATION_ID: 'x' });
  const first = await request('POST /restart', { 'x-pi-restart': '1' });
  await request('POST /restart', { 'x-pi-restart': '1' });
  assert.equal(first.code, 200);
  assert.equal(first.body.restarting, true);
  assert.equal(exits(), 1);
});

test('refuses without the header or without a supervisor', async () => {
  const supervised = setup({ INVOCATION_ID: 'x' });
  assert.equal((await supervised.request('POST /restart')).code, 400);
  assert.equal(supervised.exits(), 0);
  const foreground = setup({});
  assert.equal((await foreground.request('POST /restart', { 'x-pi-restart': '1' })).code, 409);
  assert.equal(foreground.exits(), 0);
});
