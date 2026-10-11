/**
 * Anda C Smoke Hub — local API server.
 *
 * Runs inside the Electron main process and serves the renderer on loopback.
 * API requests may be proxied to the hosted service to keep browser requests
 * same-origin without making local SQLite the source of truth.
 *
 * Binding to 127.0.0.1 only keeps the till's data unreachable from the local
 * network. Nothing here talks to the internet, so the app works with the cable
 * pulled out.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Product photos, written by the media handler, live outside dist/.
const media = require('./media.cjs');

const API_BODY_LIMIT = 8 * 1024 * 1024; // 8 MB, enough for a large barcode import

/** When this process started, reported by the health endpoint. */
const startedAt = new Date().toISOString();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > API_BODY_LIMIT) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Wraps a Node response with the small `status().json()` chain the handlers use.
 */
function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // The renderer and the API share an origin, but keep this correct anyway.
      res.setHeader('Cache-Control', 'no-store');
    }
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = (body) => {
    res.end(body === undefined ? '' : String(body));
    return res;
  };
  return res;
}

async function proxyCloudApi(req, res, cloudApiOrigin) {
  try {
    const headers = {};
    const hopByHopHeaders = new Set([
      'accept-encoding', 'connection', 'content-length', 'host', 'keep-alive',
      'origin', 'proxy-authenticate', 'proxy-authorization', 'referer', 'te',
      'trailer', 'transfer-encoding', 'upgrade',
    ]);
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    const method = req.method || 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    const response = await fetch(new URL(req.url || '/', cloudApiOrigin), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });

    res.statusCode = response.status;
    for (const name of ['cache-control', 'content-disposition', 'content-type', 'etag', 'last-modified', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('[api] hosted request failed:', error && error.message ? error.message : error);
    return res.status(503).json({ error: 'The hosted POS service is unreachable. Check the internet connection and try again.' });
  }
}

/** Parses `/api/orders/abc123` into `{ resource: 'orders', id: 'abc123' }`. */
function parseRoute(pathname) {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments[0] !== 'api') return null;
  const [, resource, ...rest] = segments;
  if (!resource) return { resource: '', id: undefined, query: {} };
  return { resource, id: rest.join('/') || undefined, segments: rest };
}

/**
 * Starts the server. Returns the listening port so callers know the origin the
 * renderer should load (the window must use this exact host and port).
 */
async function startLocalServer({ distDir, handlers, cloudApiOrigin, host = '127.0.0.1', port = 0 }) {
  const distIndex = path.join(distDir, 'index.html');

  const server = http.createServer(async (req, res) => {
    decorate(res);

    try {
      const requestUrl = new URL(req.url || '/', `http://${host}`);

      if (cloudApiOrigin && requestUrl.pathname.startsWith('/api/')) {
        return await proxyCloudApi(req, res, cloudApiOrigin);
      }

      // ── Health ──────────────────────────────────────────────────────────
      // Answered here, before any handler: it must not depend on the database,
      // because "can the till take a sale" has to be answerable when the
      // database is the thing that is broken.
      if (requestUrl.pathname === '/api/health') {
        return res.status(200).json({
          ok: true,
          service: 'anda-smoke-hub-pos',
          // The version of the running app, so a stale build can be spotted.
          startedAt: startedAt,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }

      const route = parseRoute(requestUrl.pathname);

      if (route) {
        const handler = handlers[route.resource];
        if (!handler) return res.status(404).json({ error: 'API route not found' });

        const rawBody = req.method === 'GET' || req.method === 'HEAD'
          ? ''
          : await readBody(req);

        // Mirror the shape the handlers expect from the old serverless platform.
        const query = {};
        for (const [key, value] of requestUrl.searchParams.entries()) {
          if (key === 'route') continue;
          query[key] = value;
        }
        // `/api/products/<id>` and `/api/orders/<id>` are routed by path segment.
        if (route.id) query.id = route.id;

        let body = {};
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            return res.status(400).json({ error: 'Request body must be valid JSON' });
          }
        }

        req.query = query;
        req.body = body;
        return await handler(req, res);
      }

      // ── Product media stored on this machine ──
      // Photos live in the data folder rather than the build, so a rebuilt app
      // never loses the catalogue's pictures.
      if (requestUrl.pathname.startsWith('/media/')) {
        const stored = media.resolveStoredMediaPath(requestUrl.pathname);
        if (!stored) return res.status(404).json({ error: 'Image not found' });
        res.setHeader('Content-Type', MIME[path.extname(stored).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return fs.createReadStream(stored).pipe(res);
      }

      // ── Static renderer ──
      const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      let filePath = path.join(distDir, relative);
      // Never let a crafted path escape dist/.
      if (!filePath.startsWith(path.resolve(distDir))) {
        return res.status(403).end('Forbidden');
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = distIndex; // SPA fallback
      }
      if (!fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(503).end('Application has not been built yet. Run: npm run build');
      }

      const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const immutable = /\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/.test(filePath);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      console.error('[api] request failed:', error && error.message ? error.message : error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, port: actualPort, origin: `http://${host}:${actualPort}` };
}

module.exports = { startLocalServer };