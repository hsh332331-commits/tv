'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

const RAW_RENDER_URL = process.env.RENDER_URL || 'tv-2-vbcc.onrender.com';
const RENDER_PARSED = (() => {
  try { return new URL(RAW_RENDER_URL.includes('://') ? RAW_RENDER_URL : `https://${RAW_RENDER_URL}`); } catch { return new URL(`https://${RAW_RENDER_URL}`); }
})();
const USE_HTTPS = RENDER_PARSED.protocol === 'https:';
const RENDER_HOST = RENDER_PARSED.hostname;
const RENDER_PORT = RENDER_PARSED.port ? Number(RENDER_PARSED.port) : (USE_HTTPS ? 443 : 80);
const AGENT_LIB = USE_HTTPS ? https : http;
const TIMEOUT_MS = 20000;

const m3u = fs.readFileSync('tv_movie_api.m3u', 'utf8');
const channels = [];
const lines = m3u.split('\n');
let current = { name: '', logo: '', cat: '', url: '', headers: {} };

function flushCurrent() {
  if (current.url && current.name) {
    channels.push({
      name: current.name.replace(/,/g, '').trim(),
      url: current.url.trim(),
      headers: JSON.parse(JSON.stringify(current.headers)),
      domain: extractDomain(current.url)
    });
  }
  current = { name: '', logo: '', cat: '', url: '', headers: {} };
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? ':' + u.port : '');
  } catch { return 'unknown'; }
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line.startsWith('#EXTINF:')) {
    const nameMatch = line.match(/,([^,]+)$/);
    if (nameMatch) current.name = nameMatch[1];
    const logoMatch = line.match(/tvg-logo="([^"]*)"/);
    if (logoMatch) current.logo = logoMatch[1];
    const catMatch = line.match(/group-title="([^"]*)"/);
    if (catMatch) current.cat = catMatch[1];
  } else if (line.startsWith('#KODIPROP:') || line.startsWith('#EXTVLCOPT:')) {
    const refMatch = line.match(/http-referrer?[=:]"?(https?:\/\/[^\s"']+)/i);
    const uaMatch = line.match(/http-user-agent[=:]"?([^"]+)/i);
    if (refMatch) current.headers.Referer = refMatch[1].replace(/["']$/, '');
    if (uaMatch) current.headers['User-Agent'] = uaMatch[1].replace(/["']$/, '');
  } else if (line && !line.startsWith('#')) {
    current.url = line;
    flushCurrent();
  }
}
flushCurrent();

console.log(`Total channels: ${channels.length}\n`);

// Deduplicate by url+headers combo for testing
const seen = new Set();
const unique = [];
for (const ch of channels) {
  const key = ch.url + '|' + JSON.stringify(ch.headers);
  if (!seen.has(key)) { seen.add(key); unique.push(ch); }
}
console.log(`Unique URL+Header combos: ${unique.length}\n`);

let tested = 0, working = 0, failed = 0;

function testChannel(ch, done) {
  const params = new URLSearchParams();
  params.set('url', ch.url);
  if (ch.headers.Referer) params.set('Referer', ch.headers.Referer);
  if (ch.headers['User-Agent']) params.set('User-Agent', ch.headers['User-Agent']);
  
  const proxyPath = '/proxy?' + params.toString();

  const start = Date.now();
  const req = AGENT_LIB.get({
    hostname: RENDER_HOST,
    port: RENDER_PORT,
    path: proxyPath,
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': 'Mozilla/5.0 Test' }
  }, (res) => {
    const elapsed = Date.now() - start;
    const status = res.statusCode;
    let bodySize = 0;
    res.on('data', (c) => { bodySize += c.length; if (bodySize > 20000) res.destroy(); });
    const statusText = status === 200 ? 'OK' : status === 206 ? 'PARTIAL' : status === 302 ? 'REDIRECT' : status === 502 ? 'BAD_GATEWAY' : `STATUS_${status}`;
    const domain = ch.domain.padEnd(25);
    const sizeInfo = bodySize > 0 ? ` ${bodySize}B` : '';
    const result = `[${statusText.padEnd(12)}] ${domain} ${ch.name.slice(0, 35).padEnd(37)} ${elapsed}ms${sizeInfo}`;
    if (status === 200 || status === 206) {
      console.log(`  ✅ ${result}`);
      working++;
    } else {
      console.log(`  ❌ ${result}`);
      failed++;
    }
    tested++;
    done();
  });
  req.on('error', (err) => {
    const elapsed = Date.now() - start;
    console.log(`  💥 [ERROR] ${ch.domain.padEnd(25)} ${ch.name.slice(0, 35).padEnd(37)} ${elapsed}ms - ${err.message.slice(0, 60)}`);
    tested++;
    failed++;
    done();
  });
  req.on('timeout', () => {
    req.destroy();
    console.log(`  ⏰ [TIMEOUT] ${ch.domain.padEnd(25)} ${ch.name.slice(0, 35).padEnd(37)} ${TIMEOUT_MS}ms`);
    tested++;
    failed++;
    done();
  });
}

function runTests() {
  console.log('Testing channels through Render proxy...\n');
  let idx = 0;
  function next() {
    if (idx >= unique.length) {
      console.log(`\n---\nDone. Total: ${unique.length}, Working: ${working}, Failed: ${failed}\n`);
      return;
    }
    testChannel(unique[idx++], next);
  }
  next();
}

runTests();
