import http from 'node:http';
import net from 'node:net';

export const PREFIX = '/preview';
const BODY_LIMIT = 8 * 1024 * 1024;

export function prefixUrl(value) {
  return value.startsWith('/') && !value.startsWith('//') && value !== PREFIX &&
    !value.startsWith(`${PREFIX}/`) && !value.startsWith(`${PREFIX}?`)
    ? `${PREFIX}${value}` : value;
}

export function rewriteJs(source) {
  return source.replace(
    /(\b(?:from\s*|import\s*|import\s*\(\s*|new\s+URL\s*\(\s*))(["'])(\/[^"']*)\2/g,
    (_, syntax, quote, url) => `${syntax}${quote}${prefixUrl(url)}${quote}`,
  );
}
export function rewriteCss(source) {
  return source.replace(/(url\(\s*)(["']?)(\/[^)"']*)\2(\s*\))/gi,
    (_, syntax, quote, url, closing) => `${syntax}${quote}${prefixUrl(url)}${quote}${closing}`);
}
export function rewriteHtml(html) {
  const rewritten = html.replace(
    /(\b(?:href|src|action|poster|component-url|renderer-url)\s*=\s*)(["'])(\/[^"']*)\2/gi,
    (_, attribute, quote, url) => `${attribute}${quote}${prefixUrl(url)}${quote}`,
  ).replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, opening, code, closing) => opening + rewriteJs(code) + closing);
  const script = '<script src="/plugins/vite-preview/client/preview-runtime.mjs"></script>';
  return /<head(?:\s[^>]*)?>/i.test(rewritten)
    ? rewritten.replace(/<head(?:\s[^>]*)?>/i, match => match + script)
    : script + rewritten;
}

export function createAdapter(getPort) {
  const sockets = new Set();
  const upstreams = new Set();
  const server = http.createServer((req, res) => {
    const port = getPort();
    if (!port) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('预览服务尚未启动，请在「前端预览」中启动项目。');
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers['accept-encoding'];
    const upstream = http.request({
      hostname: '127.0.0.1', port, method: req.method,
      path: PREFIX + (req.url || '/'), headers,
    }, incoming => {
      const responseHeaders = { ...incoming.headers, 'cache-control': 'no-store' };
      delete responseHeaders['x-frame-options'];
      if (responseHeaders.location) responseHeaders.location = prefixUrl(responseHeaders.location);
      // Development pages run inside the current authenticated UI.
      // Preserve CSP otherwise; this directive alone can disallow embedding.
      if (responseHeaders['content-security-policy']) {
        responseHeaders['content-security-policy'] = responseHeaders['content-security-policy']
          .replace(/(?:^|;)\s*frame-ancestors[^;]*/gi, '');
      }
      const contentType = incoming.headers['content-type'] || '';
      const rewrite = /\btext\/html\b/i.test(contentType) ? rewriteHtml
        : /(?:javascript|ecmascript)/i.test(contentType) ? rewriteJs
        : /\btext\/css\b/i.test(contentType) ? rewriteCss : null;
      if (req.method === 'HEAD' || !rewrite || incoming.headers['content-encoding']) {
        res.writeHead(incoming.statusCode || 502, responseHeaders);
        incoming.pipe(res);
        return;
      }
      // Astro manages its base separately from Vite. Prefix generated module
      // imports as well as HTML links without modifying project source files.
      delete responseHeaders['content-length'];
      delete responseHeaders.etag;
      const chunks = [];
      let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          incoming.destroy();
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Preview text response exceeds 8 MiB.');
        } else chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (res.writableEnded) return;
        res.writeHead(incoming.statusCode || 502, responseHeaders);
        res.end(rewrite(Buffer.concat(chunks).toString('utf8')));
      });
      incoming.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end('Preview response interrupted.');
      });
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Preview server is unavailable.');
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    const port = getPort();
    if (!port) { socket.destroy(); return; }
    const upstream = net.connect(port, '127.0.0.1');
    upstreams.add(upstream);
    upstream.on('connect', () => {
      const headers = { ...req.headers, host: `127.0.0.1:${port}` };
      const lines = Object.entries(headers).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}`));
      upstream.write(`${req.method} ${PREFIX}${req.url || '/'} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close);
    socket.on('error', close);
    socket.on('close', close);
    upstream.on('close', () => { upstreams.delete(upstream); socket.destroy(); });
  });
  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    }),
    disconnect() {
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreams) socket.destroy();
    },
    close() {
      this.disconnect();
      return new Promise(resolve => server.close(resolve));
    },
  };
}
