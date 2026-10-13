import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

const [project, framework, prefix] = process.argv.slice(2);
const requireProject = createRequire(`${project}/package.json`);
let server;
let closing = false;

async function stop() {
  if (closing) return;
  closing = true;
  try { await (framework === 'astro' ? server?.stop() : server?.close()); }
  finally { process.exit(0); }
}
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

try {
  // Resolve from the project's installed dependencies, including pnpm links.
  const api = await import(pathToFileURL(requireProject.resolve(framework)).href);
  // Astro/Vite versions can treat port 0 as the default. Pick a free loopback
  // port explicitly, then enforce it so a collision reports a startup failure.
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const viteServer = {
    host: '127.0.0.1', port, strictPort: true, open: false,
    // 0 makes Vite derive the browser's public port from import.meta.url.
    hmr: { clientPort: 0, host: undefined, protocol: undefined, port: undefined,
      path: framework === 'astro' ? `${prefix}/` : undefined },
  };
  if (framework === 'astro') {
    server = await api.dev({
      root: project, base: `${prefix}/`,
      server: { host: '127.0.0.1', port, open: false },
      devToolbar: { enabled: false },
      vite: { server: viteServer, clearScreen: false },
    });
  } else {
    server = await api.createServer({
      root: project, base: `${prefix}/`, clearScreen: false,
      server: viteServer,
    });
    await server.listen();
  }
  const address = framework === 'astro' ? server.address : server.httpServer.address();
  console.log(`Preview ready: ${prefix}/ (local http://127.0.0.1:${address.port}${prefix}/)`);
  process.send?.({ type: 'ready', port: address.port });
} catch (error) {
  console.error(error?.stack || String(error));
  process.send?.({ type: 'failed', error: error?.message || String(error) });
  await stop();
}
