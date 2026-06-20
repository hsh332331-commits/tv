const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url parameter');
      return;
    }

    const targetUrl = decodeURIComponent(target);
    const extraHeaders = {};
    if (parsed.query.Referer) extraHeaders['Referer'] = parsed.query.Referer;
    if (parsed.query['User-Agent']) extraHeaders['User-Agent'] = parsed.query['User-Agent'];

    try {
      var opts = new url.URL(targetUrl);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid URL');
      return;
    }

    const isHttps = opts.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: opts.hostname,
      port: opts.port || (isHttps ? 443 : 80),
      path: opts.pathname + opts.search,
      method: req.method,
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
      timeout: 30000,
    };

    if (req.headers['range']) {
      options.headers['Range'] = req.headers['range'];
    }

    const proxyReq = transport.request(options, (proxyRes) => {
      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges',
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp2t',
      };

      // Forward important headers if present
      if (proxyRes.headers['content-length']) responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
      if (proxyRes.headers['content-range']) responseHeaders['Content-Range'] = proxyRes.headers['content-range'];

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Proxy timeout');
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
