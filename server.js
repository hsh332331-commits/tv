const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

function safeEnd(res, code, msg) {
  try { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); } catch (e) {}
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  const pathname = reqUrl.pathname;

  if (pathname === '/proxy') {
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      safeEnd(res, 400, 'Missing url parameter');
      return;
    }

    const targetUrl = decodeURIComponent(target);
    const extraHeaders = {};
    if (reqUrl.searchParams.get('Referer')) extraHeaders['Referer'] = reqUrl.searchParams.get('Referer');
    if (reqUrl.searchParams.get('User-Agent')) extraHeaders['User-Agent'] = reqUrl.searchParams.get('User-Agent');

    var opts;
    try { opts = new URL(targetUrl); } catch (e) {
      safeEnd(res, 400, 'Invalid URL');
      return;
    }

    let done = false;

    const options = {
      hostname: opts.hostname,
      port: opts.port || (isHttps ? 443 : 80),
      path: opts.pathname + opts.search,
      method: req.method,
      headers: { 'Accept': '*/*', ...extraHeaders },
      timeout: 30000,
    };

    if (req.headers['range']) options.headers['Range'] = req.headers['range'];

    const followRedirect = (targetUrl, extraHeaders, depth) => {
      if (depth > 5) { safeEnd(res, 502, 'Too many redirects'); return null; }
      var opts;
      try { opts = new URL(targetUrl); } catch (e) { safeEnd(res, 400, 'Invalid redirect URL'); return null; }
      const isHttps = opts.protocol === 'https:';
      const transport = isHttps ? https : http;
      const opt = {
        hostname: opts.hostname, port: opts.port || (isHttps ? 443 : 80),
        path: opts.pathname + opts.search, method: 'GET',
        headers: { 'Accept': '*/*', ...extraHeaders }, timeout: 30000,
      };
      if (req.headers['Range']) opt.headers['Range'] = req.headers['Range'];
      const req2 = transport.request(opt, (proxyRes) => {
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
          var loc = proxyRes.headers.location;
          if (!loc.startsWith('http')) loc = new URL(loc, targetUrl).href;
          followRedirect(loc, extraHeaders, depth + 1);
        } else {
          if (done) return; done = true;
          var h = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges',
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp2t',
          };
          if (proxyRes.headers['content-length']) h['Content-Length'] = proxyRes.headers['content-length'];
          if (proxyRes.headers['accept-ranges']) h['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
          if (proxyRes.headers['content-range']) h['Content-Range'] = proxyRes.headers['content-range'];
          res.writeHead(proxyRes.statusCode, h);
          proxyRes.pipe(res, { end: true });
        }
      });
      req2.on('error', (err) => { if (done) return; done = true; safeEnd(res, 502, 'Proxy error: ' + err.message); });
      req2.on('timeout', () => { req2.destroy(); if (done) return; done = true; safeEnd(res, 504, 'Proxy timeout'); });
      req2.end();
      return req2;
    };
    followRedirect(targetUrl, extraHeaders, 0);

    proxyReq.on('error', (err) => {
      if (done) return; done = true;
      safeEnd(res, 502, 'Proxy error: ' + err.message);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (done) return; done = true;
      safeEnd(res, 504, 'Proxy timeout');
    });

    proxyReq.end();
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🖥  بكر الجازي | خادم البث`);
  console.log(`  ───────────────────────`);
  console.log(`  الرابط: http://localhost:${PORT}`);
  console.log(`  القنوات: ${getChannelCount()}`);
  console.log(`  اكتب Ctrl+C للإيقاف\n`);
});

function getChannelCount() {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const matches = html.match(/"n":\s*"/g);
    return matches ? matches.length : 0;
  } catch { return 0; }
}
