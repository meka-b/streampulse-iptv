import http from 'http';

// User provided HTTP Proxy List to bypass IPTV Datacenter/IP 401 anti-leech blocks
const HTTP_PROXIES = [
  "http://174.138.119.88:80",
  "http://150.238.75.122:3128",
  "http://12.50.107.219:80",
  "http://45.155.226.177:3128",
  "http://85.214.107.177:80",
  "http://140.238.32.108:3128",
  "http://164.90.213.227:3128",
  "http://142.93.202.130:3128",
  "http://157.230.38.173:3128",
  "http://157.230.178.216:8080",
  "http://167.99.173.119:3128",
  "http://188.166.198.82:3128",
  "http://104.248.81.109:3128",
  "http://89.36.161.56:3128",
  "http://68.183.178.217:3128",
  "http://68.183.177.73:3128",
  "http://165.22.240.206:3128"
];

function fetchViaHttpProxy(proxyUrlStr, targetUrlStr) {
  return new Promise((resolve, reject) => {
    try {
      const proxyUrl = new URL(proxyUrlStr);
      const targetUrl = new URL(targetUrlStr);

      const options = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        path: targetUrlStr,
        method: 'GET',
        headers: {
          'Host': targetUrl.host,
          'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
          'Accept': '*/*',
          'Connection': 'close'
        },
        timeout: 7000
      };

      const req = http.request(options, (res) => {
        let chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'] || '',
            buffer: Buffer.concat(chunks)
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Proxy timeout'));
      });
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

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

  let finalBuffer = null;
  let finalContentType = '';
  let success = false;
  let lastErrorStatus = 500;

  // STEP 1: Direct Vercel fetch with player User-Agents
  const userAgents = [
    'VLC/3.0.18 LibVLC/3.0.18',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'IPTVSmartersPlayer/3.1.5 (Linux;Android 11)',
    'Lavf/58.29.100'
  ];

  for (const ua of userAgents) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resAttempt = await fetch(targetUrl, {
        method: req.method || 'GET',
        headers: {
          'User-Agent': ua,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (resAttempt.ok) {
        finalContentType = resAttempt.headers.get('content-type') || '';
        const ab = await resAttempt.arrayBuffer();
        finalBuffer = Buffer.from(ab);
        success = true;
        break;
      } else {
        lastErrorStatus = resAttempt.status;
      }
    } catch (err) {}
  }

  // STEP 2: If 401 / 403 or failure, fallback to user HTTP Proxy rotation list
  if (!success) {
    console.log(`Direct fetch failed (${lastErrorStatus}). Trying HTTP Proxy List fallback for ${targetUrl}...`);
    for (const proxyUrl of HTTP_PROXIES) {
      try {
        const proxyRes = await fetchViaHttpProxy(proxyUrl, targetUrl);
        if (proxyRes.status >= 200 && proxyRes.status < 300 && proxyRes.buffer.length > 0) {
          finalBuffer = proxyRes.buffer;
          finalContentType = proxyRes.contentType;
          success = true;
          console.log(`Proxy ${proxyUrl} succeeded with status ${proxyRes.status}!`);
          break;
        }
      } catch (e) {}
    }
  }

  if (!success || !finalBuffer) {
    return res.status(lastErrorStatus).send(`Target HTTP Error: ${lastErrorStatus}`);
  }

  // Handle Binary Video Segments (.ts)
  if (targetUrl.includes('.ts') || finalContentType.includes('video/') || finalContentType.includes('octet-stream')) {
    res.setHeader('Content-Type', finalContentType || 'video/mp2t');
    return res.status(200).send(finalBuffer);
  }

  const text = finalBuffer.toString('utf-8');

  // Handle M3U8 Playlist URL Rewriting
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
  if (finalContentType) {
    res.setHeader('Content-Type', finalContentType);
  }
  return res.status(200).send(text);
}
