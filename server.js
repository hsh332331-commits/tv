'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
};
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
  let p;
  try { p = decodeURIComponent(req.url === '/' ? 'index.html' : req.url.replace(/^\/+/, '')); } catch { res.writeHead(400); res.end(); return; }
  p = path.normalize(p);
  if (p.includes('\0') || p.startsWith('..') || path.isAbsolute(p)) { res.writeHead(403); res.end('Forbidden'); return; }
  const fp = path.join(ROOT, p);
  fs.stat(fp, (e, s) => {
    if (e || !s.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(fp).pipe(res);
  });
}).listen(PORT, '0.0.0.0', () => console.log('Static server on port ' + PORT));
