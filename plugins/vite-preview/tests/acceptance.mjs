import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createPreview } from '../index.mjs';
const { PI_WEB_UI_DIR, PREVIEW_TEST_PROJECT } = process.env;
assert.ok(PI_WEB_UI_DIR && PREVIEW_TEST_PROJECT, 'set PI_WEB_UI_DIR and PREVIEW_TEST_PROJECT');
const requireHost = createRequire(join(resolve(PI_WEB_UI_DIR), 'package.json'));
const WebSocket = requireHost('ws');
let adapterPort;
const events = [];
const host = {
  cwd: dirname(resolve(PREVIEW_TEST_PROJECT)),
  getSettings: () => ({ defaultProject: resolve(PREVIEW_TEST_PROJECT) }),
  broadcast: state => events.push(state),
  registerProxy(prefix, port) { assert.equal(prefix, '/preview'); adapterPort = port; return () => {}; },
};
const preview = await createPreview(host);
try {
  const state = await preview.start(resolve(PREVIEW_TEST_PROJECT));
  assert.equal(state.status, 'running');
  assert.equal(state.framework, 'astro');
  assert.equal((await preview.start(state.project)).revision, state.revision);
  const home = await fetch(`http://127.0.0.1:${adapterPort}/`);
  const html = await home.text();
  assert.equal(home.status, 200);
  assert.ok(/preview-runtime\.mjs/.test(html), 'runtime injected');
  assert.ok(/href="\/preview\/archive\/?"/.test(html), 'archive link stays in preview');
  assert.ok(/src="\/preview\/[^" ]*vite\/client"/.test(html), 'Vite client path has preview prefix');
  const archive = await fetch(`http://127.0.0.1:${adapterPort}/archive`);
  assert.equal(archive.status, 200);
  assert.ok(/<html/.test(await archive.text()), 'archive returns HTML');
  const viteClient = await fetch(`http://127.0.0.1:${adapterPort}/@vite/client`);
  assert.equal(viteClient.status, 200);
  const clientJs = await viteClient.text();
  const token = clientJs.match(/const wsToken = "([^"]+)"/)?.[1];
  assert.ok(token, 'Vite HMR token is present');
  const socketLine = clientJs.split('\n').find(line => /^const socketHost\s*=/.test(line));
  assert.ok(socketLine?.includes('/preview/'), 'Vite HMR socket uses preview prefix');
  const ws = new WebSocket(`ws://127.0.0.1:${adapterPort}/?token=${token}`, 'vite-hmr');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('HMR handshake timeout')), 15_000);
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'connected') { clearTimeout(timeout); resolve(); }
    });
    ws.on('error', error => { clearTimeout(timeout); reject(error); });
  });
  console.log('PASS Echoes Astro home/archive and prefixed links');
  console.log('PASS Vite client and HMR WebSocket connected through preview adapter');
  ws.close();
  await preview.stop();
  assert.equal(preview.snapshot().status, 'idle');
  assert.equal((await fetch(`http://127.0.0.1:${adapterPort}/`)).status, 503);
  console.log('PASS stop returns idle and disables preview');
} catch (error) {
  console.error(preview.snapshot().logs.join('\n'));
  throw error;
} finally {
  await preview.dispose();
}
