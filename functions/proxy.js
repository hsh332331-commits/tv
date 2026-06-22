export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing url', { status: 400 });

  const headers = { 'Accept': '*/*' };
  const referer = url.searchParams.get('Referer');
  const userAgent = url.searchParams.get('User-Agent');
  if (referer) headers['Referer'] = referer;
  if (userAgent) headers['User-Agent'] = userAgent;

  try {
    const resp = await fetch(target, { headers, redirect: 'follow' });
    const newHeaders = new Headers(resp.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    newHeaders.set('Cache-Control', 'no-store');

    const ct = (resp.headers.get('content-type') || '');
    const isM3U8 = ct.includes('mpegurl') || ct.includes('mpeg') || target.includes('.m3u8');
    if (isM3U8) {
      const text = await resp.text();
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
      const rewritten = text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        try { return new URL(t, baseUrl).href; } catch { return line; }
      }).join('\n');
      return new Response(rewritten, {
        status: resp.status,
        headers: { ...Object.fromEntries(newHeaders), 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' }
      });
    }
    return new Response(resp.body, { status: resp.status, headers: newHeaders });
  } catch (e) {
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}
