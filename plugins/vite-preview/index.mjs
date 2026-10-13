import { fork } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter, PREFIX } from './proxy.mjs';

export async function createPreview(host) {
  let child = null;
  let upstreamPort = null;
  let pendingStart = null;
  let starting = false;
  let disposed = false;
  let logTimer;
  let revision = 0;
  const state = { status: 'idle', project: '', framework: '', logs: [], error: null };
  const snapshot = () => ({
    type: 'state', ...state, logs: state.logs.slice(), url: `${PREFIX}/`, revision,
    defaultProject: String(host.getSettings?.().defaultProject || host.cwd),
  });
  const publish = () => { if (!disposed) host.broadcast(snapshot()); };
  const log = chunk => {
    const clean = String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n');
    state.logs.push(...clean.split('\n').filter(Boolean).map(line => line.slice(0, 2000)));
    state.logs = state.logs.slice(-300);
    if (!logTimer) logTimer = setTimeout(() => { logTimer = null; publish(); }, 150);
  };
  const adapter = createAdapter(() => upstreamPort);
  const adapterPort = await adapter.listen();
  const unregisterProxy = host.registerProxy(PREFIX, adapterPort);

  async function stop() {
    const previous = child;
    child = null;
    upstreamPort = null;
    if (pendingStart) { pendingStart.reject(new Error('启动已取消')); pendingStart = null; }
    adapter.disconnect();
    if (!previous) {
      state.status = 'idle'; state.error = null; publish();
      return snapshot();
    }
    state.status = 'stopping'; publish();
    await new Promise(resolveStopped => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(graceTimer); clearTimeout(killTimer); resolveStopped();
      };
      const graceTimer = setTimeout(() => previous.kill('SIGTERM'), 1500);
      const killTimer = setTimeout(() => { previous.kill('SIGKILL'); finish(); }, 4000);
      previous.once('exit', finish);
      if (previous.exitCode !== null || previous.signalCode !== null) finish();
      else if (previous.connected) previous.send({ type: 'stop' }, () => {});
      else previous.kill('SIGTERM');
    });
    state.status = 'idle'; state.error = null; publish();
    return snapshot();
  }

  async function launch(requested) {
    if (disposed) throw new Error('插件已卸载');
    const project = await realpath(resolve(host.cwd, requested || snapshot().defaultProject));
    let pkg;
    try { pkg = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8')); }
    catch (error) { throw new Error(`无法读取项目 package.json：${error.message}`); }
    const requireProject = createRequire(resolve(project, 'package.json'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = declared.astro ? 'astro' : 'vite';
    try { requireProject.resolve(framework); }
    catch { throw new Error(`项目尚未安装 ${framework}。请先在 ${project} 安装项目依赖。`); }
    if (child && state.status === 'running' && state.project === project) return snapshot();
    await stop();
    if (disposed) throw new Error('插件已卸载');
    state.status = 'starting'; state.project = project; state.framework = framework;
    state.logs = []; state.error = null; publish();
    const worker = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [project, framework, PREFIX], {
      cwd: project, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    });
    child = worker;
    worker.stdout.on('data', log); worker.stderr.on('data', log);
    try {
      await new Promise((resolveReady, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('启动超过 90 秒，请查看日志')), 90_000);
        const finish = (error, port) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (pendingStart?.worker === worker) pendingStart = null;
          if (error) reject(error);
          else { upstreamPort = port; resolveReady(); }
        };
        pendingStart = { worker, reject: error => finish(error) };
        worker.on('message', message => {
          if (child !== worker) return;
          if (message?.type === 'ready') finish(null, message.port);
          else if (message?.type === 'failed') finish(new Error(message.error));
        });
        worker.once('error', error => finish(error));
        worker.once('exit', (code, signal) => {
          finish(new Error(`开发服务退出 (${signal || code})`));
          if (child === worker) {
            child = null; upstreamPort = null; adapter.disconnect();
            state.status = 'error'; state.error = `开发服务退出 (${signal || code})`; publish();
          }
        });
      });
      if (child !== worker) throw new Error('启动已取消');
      revision += 1;
      state.status = 'running'; publish();
      return snapshot();
    } catch (error) {
      if (child === worker) await stop();
      if (error.message !== '启动已取消') {
        state.status = disposed ? 'idle' : 'error'; state.error = error.message; publish();
      }
      throw error;
    }
  }

  async function start(requested) {
    if (starting || state.status === 'stopping') throw new Error('预览正在启动或停止，请稍后重试');
    starting = true;
    try { return await launch(requested); }
    finally { starting = false; }
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(logTimer);
    unregisterProxy();
    await stop();
    clearTimeout(logTimer);
    await adapter.close();
  }
  return { start, stop, snapshot, dispose };
}

export default {
  async activate(host) {
    const preview = await createPreview(host);
    // Effects execute synchronously on plugin reload: disposal immediately removes
    // proxy access, then terminates its worker and closes local sockets.
    host.effect('preview server and child process', () => { void preview.dispose(); });
    const handle = async payload => {
      if (payload?.action === 'start') return preview.start(payload.project);
      if (payload?.action === 'stop') return preview.stop();
      if (payload?.action === 'state') return preview.snapshot();
      throw new Error('未知操作：请使用 start、stop 或 state');
    };
    host.onMessage((payload, clientId) => {
      void handle(payload).then(state => {
        if (clientId) host.sendTo(clientId, state);
      }).catch(error => {
        const state = { ...preview.snapshot(), error: error.message };
        if (clientId) host.sendTo(clientId, state); else host.broadcast(state);
      });
    });
    host.onAttach(clientId => host.sendTo(clientId, preview.snapshot()));
    host.onSettingsChanged?.(() => host.broadcast(preview.snapshot()));
    host.route('GET', '/state', (_req, res) => res.json(preview.snapshot()));
    host.route('POST', '/start', async (req, res) => {
      try { res.json(await preview.start(req.body?.project)); }
      catch (error) { res.status(400).json({ ...preview.snapshot(), error: error.message }); }
    });
    host.route('POST', '/stop', async (_req, res) => res.json(await preview.stop()));
    host.registerAgentTool({
      name: 'vite_preview', label: 'Frontend preview',
      description: 'Start, stop, or check the authenticated same-domain Vite/Astro frontend preview. Open /preview/ on this Web UI domain. Dependencies must already be installed; this runs project dev configuration. One project at a time.',
      parameters: {
        type: 'object', properties: {
          action: { type: 'string', enum: ['start', 'stop', 'state'] },
          project: { type: 'string', description: 'Absolute project directory; defaults to the plugin setting or workspace.' },
        }, required: ['action'],
      },
      async execute(_id, params) {
        const state = await handle(params);
        return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }], details: state };
      },
    });
    host.log('info', 'Frontend preview ready at /preview/ (Vite and Astro)');
  },
};
