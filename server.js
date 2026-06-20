'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;
const SOCKET_TIMEOUT_MS = 90000;
const FALLBACK_TO_HTTP_ON_TLS_ERROR = true;

const KEEPALIVE_AGENT_HTTP = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });
const KEEPALIVE_AGENT_HTTPS = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, rejectUnauthorized: false });

function isTlsLikeError(err) {
  const code = String(err && err.code || '');
  const msg = String(err && err.message || '').toLowerCase();
  return code.includes('SSL') || code.includes('TLS') || code === 'ECONNRESET' || msg.includes('certificate') || msg.includes('tls') || msg.includes('ssl');
}

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
    'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin, Referer, User-Agent, X-Requested-With',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    ...extra,
  };
}

function sendText(res, code, message, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(code, corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }));
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

function createUpstreamHeaders(req, extraHeaders, target) {
  const headers = {
    Accept: '*/*',
    'User-Agent': extraHeaders['User-Agent'] || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari/537.36',
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

const { PassThrough } = require('stream');
const STREAM_BUFFER_SIZE = 1024 * 1024;

function proxyRequest(req, res, targetUrl, extraHeaders, depth = 0, retryCount = 0) {
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
  const isStream = target.pathname.endsWith('.ts') || target.pathname.endsWith('.m3u8');
  const options = {
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: createUpstreamHeaders(req, extraHeaders, target),
    timeout: isStream ? 0 : REQUEST_TIMEOUT_MS,
    family: 4,
  };
  // Use keep-alive agents to reduce connection overhead for frequent stream requests
  options.agent = target.protocol === 'https:' ? KEEPALIVE_AGENT_HTTPS : KEEPALIVE_AGENT_HTTP;
  if (target.protocol === 'https:') options.rejectUnauthorized = false;

  const upstreamReq = transport.request(options, (proxyRes) => {
    const statusCode = proxyRes.statusCode || 502;

    if (statusCode >= 300 && statusCode < 400 && proxyRes.headers.location) {
      proxyRes.resume();
      const nextUrl = new URL(proxyRes.headers.location, target.href).href;
      proxyRequest(req, res, nextUrl, extraHeaders, depth + 1);
      return;
    }

    const contentType = proxyRes.headers['content-type'] || 'application/octet-stream';
    const isStreamContent = isStream || !contentType.includes('text') || contentType.includes('octet-stream');
    const responseHeaders = corsHeaders({
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
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
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Proxy-Rewritten': 'm3u8',
        }));
        res.end(data);
      });
      proxyRes.on('error', (err) => sendText(res, 502, `Proxy response error: ${err.message}`));
      proxyRes.on('close', () => {
        if (!res.headersSent) {
          const msg = chunks.length === 0
            ? 'Upstream closed prematurely'
            : 'Upstream closed before m3u8 end, partial data discarded';
          sendText(res, 502, msg);
        }
      });
      return;
    }

    if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];

    if (isStreamContent && statusCode === 200 && !proxyRes.headers['content-length']) {
      const preBuffer = [];
      let preSize = 0;
      let preTimer = null;
      const MIN_PREBUFFER = 16 * 1024;
      const MAX_PREWAIT = 500;

      function flushPrebuffer() {
        if (preTimer) clearTimeout(preTimer);
        preTimer = null;
        if (!res.headersSent) res.writeHead(statusCode, responseHeaders);
        for (let i = 0; i < preBuffer.length; i++) res.write(preBuffer[i]);
        preBuffer.length = 0;
        const pt = new PassThrough({ highWaterMark: STREAM_BUFFER_SIZE });
        pt.on('data', (c) => { if (!res.destroyed) res.write(c); });
        pt.on('end', () => { try { if (!res.writableEnded) res.end(); } catch (_) {} });
        proxyRes.pipe(pt);
      }

      proxyRes.on('data', (chunk) => {
        if (preTimer === null && preSize < MIN_PREBUFFER) {
          preBuffer.push(chunk);
          preSize += chunk.length;
          if (preSize >= MIN_PREBUFFER) flushPrebuffer();
        }
      });

      preTimer = setTimeout(flushPrebuffer, MAX_PREWAIT);

      proxyRes.on('end', () => {
        if (preTimer !== null) {
          clearTimeout(preTimer);
          if (!res.headersSent) res.writeHead(statusCode, responseHeaders);
          for (let i = 0; i < preBuffer.length; i++) res.write(preBuffer[i]);
          try { if (!res.writableEnded) res.end(); } catch (_) {}
        }
      });

      proxyRes.on('error', () => {
        try { if (!res.writableEnded) res.end(); } catch (_) {}
      });

      proxyRes.on('close', () => {
        // Only act if prebuffer hasn't been flushed yet — after flush, the PassThrough pipe handles end.
        if (preTimer !== null) {
          clearTimeout(preTimer);
          preTimer = null;
          if (!res.headersSent) res.writeHead(statusCode, responseHeaders);
          for (let i = 0; i < preBuffer.length; i++) res.write(preBuffer[i]);
          try { if (!res.writableEnded) res.end(); } catch (_) {}
        }
      });
    } else {
      res.writeHead(statusCode, responseHeaders);
      proxyRes.pipe(res);
      proxyRes.on('close', () => { if (!res.writableEnded) try { res.end(); } catch (_) {} });
      proxyRes.on('end', () => {
        try { if (!res.writableEnded) res.end(); } catch (_) {}
      });
    }

    // Always destroy upstream when proxy response closes
    proxyRes.on('close', () => upstreamReq.destroy());
  });

  upstreamReq.on('socket', (socket) => {
    socket.setNoDelay(true);
    if (!isStream) {
      socket.setTimeout(SOCKET_TIMEOUT_MS);
      socket.on('timeout', () => upstreamReq.destroy(new Error('Socket timeout')));
    }
  });

  upstreamReq.on('error', (err) => {
    // Destroy socket to prevent stale connections in keepalive pool
    if (upstreamReq.socket && !upstreamReq.socket.destroyed) upstreamReq.socket.destroy();

    if (FALLBACK_TO_HTTP_ON_TLS_ERROR && target.protocol === 'https:' && isTlsLikeError(err) && depth < MAX_REDIRECTS) {
      const fallbackUrl = `http://${target.host}${target.pathname}${target.search}`;
      proxyRequest(req, res, fallbackUrl, extraHeaders, depth + 1);
      return;
    }

    // Retry once for transient network errors to mask intermittent blips
    const TRANSIENT_ERRORS = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'];
    if (retryCount < 1 && TRANSIENT_ERRORS.includes(err && err.code) && !res.destroyed) {
      console.log(`  [RETRY] ${(target ? target.href.slice(0, 80) : targetUrl).padEnd(82)} (${err.code})`);
      setTimeout(() => proxyRequest(req, res, targetUrl, extraHeaders, depth, retryCount + 1), 500);
      return;
    }

    const code = err && err.code ? ` (${err.code})` : '';
    const message = `Proxy error${code}: ${err.message}`;
    if (!res.headersSent) sendText(res, 502, message, { 'X-Proxy-Error': String(err && err.code || 'UPSTREAM_ERROR') });
    else {
      try { res.end(); } catch (_) { res.destroy(); }
    }
  });

  upstreamReq.on('timeout', () => {
    console.log(`  [TIMEOUT] ${target.href.slice(0, 80)}...`);
    upstreamReq.destroy(new Error('Proxy timeout'));
  });

  upstreamReq.end();
}

function isTextLike(ext) {
  return ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json' || ext === '.svg' || ext === '.txt' || ext === '.m3u8';
}

function preferredEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return '';
}

function cacheHeaderForStatic(ext) {
  if (ext === '.html') return 'no-cache, must-revalidate';
  return 'public, max-age=604800, immutable';
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
    const lastModified = stat.mtime.toUTCString();
    if (req.headers['if-modified-since'] === lastModified) {
      res.writeHead(304, {
        'Cache-Control': cacheHeaderForStatic(ext),
        'Last-Modified': lastModified,
      });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheHeaderForStatic(ext),
      'Last-Modified': lastModified,
      'X-Content-Type-Options': 'nosniff',
    };

    const encoding = isTextLike(ext) ? preferredEncoding(req) : '';
    if (encoding) {
      headers['Content-Encoding'] = encoding;
      headers.Vary = 'Accept-Encoding';
    } else {
      headers['Content-Length'] = stat.size;
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.destroy();
    });

    if (encoding === 'br') stream.pipe(zlib.createBrotliCompress()).pipe(res);
    else if (encoding === 'gzip') stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
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

  if (reqUrl.pathname === '/health') {
    res.writeHead(200, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    res.end(JSON.stringify({ ok: true, channels: getChannelCount(), time: new Date().toISOString() }));
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

  // Keepalive: self-ping every 10 minutes to prevent Render free tier from sleeping
  setInterval(() => {
    const req = http.get(`http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/health`, (res) => {
      res.resume();
    });
    req.on('error', () => {});
  }, 10 * 60 * 1000);
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
