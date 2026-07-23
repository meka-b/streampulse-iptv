export default async function handler(req, res) {
  let targetUrl = req.query.url;

  // Enable CORS headers for browser player
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL parameter' });
  }

  // Safely decode target URL
  try {
    targetUrl = decodeURIComponent(targetUrl);
  } catch (e) {}

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Send valid IPTV player User-Agent & Headers to bypass 401 Unauthorized anti-leech blocks
    const response = await fetch(targetUrl, {
      method: req.method || 'GET',
      headers: {
        'User-Agent': 'IPTVSmartersPlayer/3.1.5 (Linux;Android 11)',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Referer': parsedUrl.origin
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).send(`Target HTTP Error: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // If binary stream (.ts video segment) or octet-stream
    if (targetUrl.includes('.ts') || contentType.includes('video/') || contentType.includes('octet-stream')) {
      res.setHeader('Content-Type', contentType || 'video/mp2t');
      const arrayBuffer = await response.arrayBuffer();
      return res.status(200).send(Buffer.from(arrayBuffer));
    }

    const text = await response.text();

    // If M3U8 playlist content, rewrite relative segment paths through /api/proxy
    if (targetUrl.includes('.m3u8') || text.includes('#EXTM3U')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

      try {
        const origin = parsedUrl.origin;
        const basePath = parsedUrl.pathname.substring(0, parsedUrl.pathname.lastIndexOf('/') + 1);
        const baseDir = `${origin}${basePath}`;

        const lines = text.split('\n');
        const rewrittenLines = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            if (trimmed.includes('URI="')) {
              return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                let fullUri = uri;
                if (uri.startsWith('/')) fullUri = `${origin}${uri}`;
                else if (!uri.startsWith('http')) fullUri = `${baseDir}${uri}`;
                return `URI="/api/proxy?url=${encodeURIComponent(fullUri)}"`;
              });
            }
            return line;
          }

          let fullSegmentUrl = trimmed;
          if (trimmed.startsWith('/')) {
            fullSegmentUrl = `${origin}${trimmed}`;
          } else if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            fullSegmentUrl = `${baseDir}${trimmed}`;
          }

          return `/api/proxy?url=${encodeURIComponent(fullSegmentUrl)}`;
        });

        return res.status(200).send(rewrittenLines.join('\n'));
      } catch (e) {
        return res.status(200).send(text);
      }
    }

    // Default API JSON / Text response
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    return res.status(200).send(text);

  } catch (error) {
    console.error('Vercel serverless proxy error:', error);
    return res.status(500).json({ error: 'Proxy fetch failed', details: error.message });
  }
}
