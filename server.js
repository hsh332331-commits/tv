const http = require('http');
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

  // CORS proxy endpoint
  if (pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing url parameter');
      return;
    }

    const targetUrl = decodeURIComponent(target);
    const headers = {};
    if (parsed.query.Referer) headers['Referer'] = parsed.query.Referer;
    if (parsed.query['User-Agent']) headers['User-Agent'] = parsed.query['User-Agent'];

    const opts = new url.URL(targetUrl);
    const options = {
      hostname: opts.hostname,
      port: opts.port || 80,
      path: opts.pathname + opts.search,
      method: req.method,
      headers: {
        ...headers,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Range': req.headers['range'] || '',
      }
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // Forward CORS headers
      res.writeHead(proxyRes.statusCode, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': proxyRes.headers['content-type'] || 'video/mp2t',
        'Content-Length': proxyRes.headers['content-length'] || '',
        'Accept-Ranges': proxyRes.headers['accept-ranges'] || 'bytes',
        'Content-Range': proxyRes.headers['content-range'] || '',
      });

      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    });

    if (req.headers['range']) {
      proxyReq.setHeader('Range', req.headers['range']);
    }

    proxyReq.end();
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);

  // Security: prevent directory traversal
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
  console.log(`\n  🖥  خادم بكر الجازي`);
  console.log(`  ───────────────────`);
  console.log(`  الرابط: http://localhost:${PORT}`);
  console.log(`  الشبكة: http://${require('os').hostname()}:${PORT}`);
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
