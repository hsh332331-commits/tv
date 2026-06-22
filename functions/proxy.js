export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) return new Response('Missing url', { status: 400 });

  const reqHeaders = { 'Accept': '*/*' };
  const referer = url.searchParams.get('Referer');
  const userAgent = url.searchParams.get('User-Agent');
  if (referer) reqHeaders['Referer'] = referer;
  if (userAgent) reqHeaders['User-Agent'] = userAgent;

  function buildProxyUrl(u) {
    let p = '/proxy?url=' + encodeURIComponent(u);
    if (referer) p += '&Referer=' + encodeURIComponent(referer);
    if (userAgent) p += '&User-Agent=' + encodeURIComponent(userAgent);
    return p;
  }

  try {
    const resp = await fetch(target, { headers: reqHeaders, redirect: 'follow' });

    const newHeaders = new Headers(resp.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
    newHeaders.set('Cache-Control', 'no-store');

    const contentType = resp.headers.get('content-type') || '';
    const isM3U8 = contentType.includes('mpegurl') || contentType.includes('m3u8') || target.endsWith('.m3u8');

    if (isM3U8) {
      const text = await resp.text();
      const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);

      const rewritten = text.split('\n').map(line => {
        // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MAP, etc.)
        line = line.replace(/URI="([^"]+)"/g, (m, uri) => {
          try { return 'URI="' + buildProxyUrl(new URL(uri, baseUrl).href) + '"'; } catch { return m; }
        });

        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;

        try {
          return buildProxyUrl(new URL(trimmed, baseUrl).href);
        } catch {
          return line;
        }
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
