'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
};

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin, Referer, User-Agent',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    ...extra,
  };
}

function sendText(res, code, message, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(code, corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...headers }));
  res.end(message);
}

function sendOptions(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}

function buildProxyUrl(targetUrl, extraHeaders = {}) {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  if (extraHeaders.Referer) params.set('Referer', extraHeaders.Referer);
  if (extraHeaders['User-Agent']) params.set('User-Agent', extraHeaders['User-Agent']);
  return `/proxy?${params.toString()}`;
}

function getExtraHeaders(query) {
  const headers = {};
  const referer = query.searchParams.get('Referer');
  const userAgent = query.searchParams.get('User-Agent');
  if (referer) headers.Referer = referer;
  if (userAgent) headers['User-Agent'] = userAgent;
  return headers;
}

function createUpstreamHeaders(req, extraHeaders) {
  const headers = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': extraHeaders['User-Agent'] || req.headers['user-agent'] || 'Mozilla/5.0',
  };
  if (extraHeaders.Referer) headers.Referer = extraHeaders.Referer;
  if (req.headers.range) headers.Range = req.headers.range;
  return headers;
}

function isM3U8Response(proxyRes, targetUrl) {
  const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
  const pathname = parseHttpUrl(targetUrl)?.pathname.toLowerCase() || '';
  return contentType.includes('mpegurl') || contentType.includes('m3u8') || pathname.endsWith('.m3u8');
}

function rewriteM3U8(playlist, baseUrl, extraHeaders) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." attributes used by EXT-X-KEY and EXT-X-MAP.
      const withRewrittenAttributes = line.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          const absolute = new URL(uri, baseUrl).href;
          return `URI="${buildProxyUrl(absolute, extraHeaders)}"`;
        } catch {
          return match;
        }
      });

      if (trimmed.startsWith('#')) return withRewrittenAttributes;

      try {
        const absolute = new URL(trimmed, baseUrl).href;
        return buildProxyUrl(absolute, extraHeaders);
      } catch {
        return line;
      }
    })
    .join('\n');
}

function proxyRequest(req, res, targetUrl, extraHeaders, depth = 0) {
  if (depth > MAX_REDIRECTS) {
    sendText(res, 502, 'Too many redirects');
    return;
  }

  const target = parseHttpUrl(targetUrl);
  if (!target) {
    sendText(res, 400, 'Invalid URL. Only http and https are supported.');
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: createUpstreamHeaders(req, extraHeaders),
    timeout: REQUEST_TIMEOUT_MS,
  };

  const upstreamReq = transport.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode || 502;

    if (statusCode >= 300 && statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      const nextUrl = new URL(proxyRes.headers.location, target.href).href;
      proxyRequest(req, res, nextUrl, extraHeaders, depth + 1);
      return;
    }

    const responseHeaders = corsHeaders({
      'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
    });

    if (proxyRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
    if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];

    if (req.method === 'HEAD') {
      if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      res.writeHead(statusCode, responseHeaders);
      proxyRes.resume();
      res.end();
      return;
    }

    if (isM3U8Response(proxyRes, target.href)) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        if (res.destroyed) return;
        const body = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteM3U8(body, target.href, extraHeaders);
        const data = Buffer.from(rewritten, 'utf8');
        res.writeHead(statusCode, corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
        }));
        res.end(data);
      });
      proxyRes.on('error', (err) => sendText(res, 502, `Proxy response error: ${err.message}`));
      return;
    }

    if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
    res.writeHead(statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) sendText(res, 502, `Proxy error: ${err.message}`);
    else res.destroy(err);
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Proxy timeout'));
  });


  upstreamReq.end();
}

function serveStatic(req, res, pathname) {
  let safePath;
  try {
    safePath = decodeURIComponent(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  safePath = path.normalize(safePath);
  if (safePath.includes('\0') || safePath.startsWith('..') || path.isAbsolute(safePath)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  const filePath = path.join(ROOT, safePath);
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        sendText(res, 500, 'Server error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

const server = http.createServer((req, res) => {
  let reqUrl;
  try {
    reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }

  if (reqUrl.pathname === '/proxy') {
    if (req.method === 'OPTIONS') {
      sendOptions(res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }

    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      sendText(res, 400, 'Missing url parameter');
      return;
    }

    proxyRequest(req, res, targetUrl, getExtraHeaders(reqUrl));
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  serveStatic(req, res, reqUrl.pathname);
});

server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nالمنفذ ${PORT} مستخدم حالياً. أغلق البرنامج الآخر أو شغل الخادم بمنفذ مختلف:`);
    console.error('PowerShell:  $env:PORT=9090; node server.js');
    console.error('CMD:         set PORT=9090 && node server.js\n');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\n  🖥  بكر الجازي | خادم البث');
  console.log('  ───────────────────────');
  console.log(`  الرابط: http://localhost:${PORT}`);
  console.log(`  القنوات: ${getChannelCount()}`);
  console.log('  اكتب Ctrl+C للإيقاف\n');
});

function getChannelCount() {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const matches = html.match(/"n":\s*"/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}
